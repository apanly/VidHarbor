# VidHarbor 规范（spec）

> 代码是唯一的真源（`src/`）。本文档把**当前稳定契约**落成单一参考，便于
> 维护与新 contributor 定位。它不记录设计取舍（见 `docs/designs/`）——那些是历史。
> 改动契约时同步此文件：路由/错误码/状态/事务规则变了，这里就变。
>
> `ponytail:` 手动维护的文档会随代码腐烂。保持它是`src/`的薄引用（只记契约，不改述实现细节）。
> 当契约频繁变动时，考虑把下表反向生成（tests/README 已覆盖契约行为）。

## 1. 架构分层

```
routes/        HTTP 契约：解析/校验入参，调用 service，回传结果（无业务逻辑）
services/      业务规则 + 事务/状态机（下载、频道、通知、代理、设置、cookie）
http/          横切：同源校验、分页、文件流
filesystem.ts  下载路径安全（realpath + isContained + O_NOFOLLOW + dev/ino 对账）
redaction.ts   日志/失败原因脱敏（代理凭据）
db/            better-sqlite3（WAL, foreign_keys ON, busy_timeout 5000）+ 迁移
yt-dlp.ts      yt-dlp/ffmpeg 子进程（超时/不活动超时/进程组 SIGKILL）
```

入口 `src/server.ts` → `startServer()`；应用装配 `src/app.ts`。

## 2. 错误码 → HTTP 状态

`src/errors.ts` 是真源。`BusinessError(code, message)`，框架按 `ERROR_HTTP_STATUS` 映射：

| 状态 | 涵盖错误码 |
| ---- | ----------- |
| 400 | `VALIDATION_ERROR` |
| 404 | `PROXY_NOT_FOUND`, `CHANNEL_NOT_FOUND`, `VIDEO_NOT_FOUND`, `NOTIFICATION_NOT_FOUND`, `DOWNLOAD_NOT_FOUND`, `DOWNLOAD_FILE_UNAVAILABLE` |
| 409 | `DOWNLOAD_DELETE_IN_PROGRESS`, `PROXY_NAME_EXISTS`, `PROXY_IN_USE`, `CHANNEL_ALREADY_EXISTS`, `CHANNEL_NAME_EXISTS`, `CHANNEL_IN_USE`, `AUTHORIZATION_IN_USE`, `DOWNLOAD_ALREADY_EXISTS` |
| 412 | （无保留；范围由 `DOWNLOAD_RANGE_NOT_SATISFIABLE` → 416） |
| 416 | `DOWNLOAD_RANGE_NOT_SATISFIABLE` |
| 422 | `DOWNLOAD_DELETE_FAILED`, `DOWNLOAD_ROOT_OUTSIDE_MOUNT`, `DOWNLOAD_ROOT_UNAVAILABLE`, `DOWNLOAD_ROOT_NOT_CONFIGURED`, `UNSUPPORTED_PLATFORM`, `NOT_A_CHANNEL_URL`, `NOT_A_VIDEO_URL`, `GLOBAL_INTERVAL_NOT_CONFIGURED`, `CHANNEL_FETCH_FAILED`, `CHANNEL_METADATA_INVALID`, `VIDEO_FETCH_FAILED`, `VIDEO_METADATA_INVALID` |
| 500 | `PERSISTENCE_ERROR` |

约定：每个 `BusinessError.code` 必须在该映射中（构造时 `getHttpStatus` 校验，未知码抛错）。

## 3. 下载状态机

`src/services/download.ts` + `src/download-worker.ts`。状态：
`pending / downloading / running / completed / failed / canceled / interrupted / deleting`

- **创建**：`createChannelDownloads`/`createDirectDownload` → `pending`；直连先做 `metadata_probe`。
- **执行**：worker 领任务 `pending → running`（`WHERE status='pending'` 原子切换）；进度写入 `running` 行。
- **结束**：`→ completed`（移动归档 + `output_path`/缩略图/大小落库）或 `→ failed` / `→ canceled`。
- **取消**：仅 `status IN ('pending','running','downloading')`；`cancelDownload` 改状态后 `queue.cancel()`。
- **重试**：仅 `status IN ('failed','canceled','interrupted')`；复位为 `pending`，清空 output/进度/时间戳。
- **删除**：
  - 非 `completed`（failed/canceled/interrupted）：直接 `DELETE` 行（无磁盘归档）。
  - `completed`：`validateDownloadFile` 校验主文件 → `tryMarkDownloadDeleting`（`completed → deleting` 原子）→ `finalizeDeletingDownload`（移到 `.vidharbor-delete/<id>` 隔离区再 `rm`；失败时仅当主文件仍完好才 `restoreDownloadToCompleted`，否则留 `deleting` 由启动恢复兜底）。
- **重启恢复**（`src/server.ts` 启动序）：
  1. `recoverInterruptedChannelSyncs`：`channel_checks`/`channels` 未 finishing → `failed`。
  2. `cleanupInterruptedDownloadDirectories`：删 `.vidharbor-tmp/<id>`。
  3. `recoverInterruptedDownloads`：`pending/downloading/running` → `interrupted`。
  4. `recoverDeletingDownloads`：收敛残留 `deleting` 行。

并发约束：下载队列由 `YtDlpTaskManager` 按 `download_concurrency` 限流；删除态转换靠 SQLite `BEGIN IMMEDIATE` 事务保证单写入者；worker 失败触发 `AbortController` 取消全部在跑任务。

## 4. API 契约

前缀 `/api`。中间件：`requireSameOrigin`（仅 POST/PUT/PATCH/DELETE 要求 `origin === protocol://host`）、`requireJsonBody`（JSON 或 cookie 上传的 octet-stream）、`express.json()`。`/api` 响应固定 `application/json`。**无鉴权**——仅同源 CSRF 防护；仅单用户 localhost / 可信私有网络（见 `SECURITY.md`）。

### 资源路由

| 路由 | 方法 | 说明 |
| ----- | ------ | ------ |
| `/api/authorizations` | GET/POST/PUT/DELETE `/cookies/:platform` | Cookie 授权配置（`POST/PUT` 上传 octet-stream，落盘前 Netscape 格式校验） |
| `/api/settings` | GET/`PUT /` | `globalCheckIntervalMinutes`、`downloadConcurrency`（均 ≥1）；`downloadRoot` 来自 `downloadsMountPath` |
| `/api/database` | GET `/tables`，POST `/query` | 仅**只读** SQL（`statement.readonly` 拦截写）；无 `LIMIT` |
| `/api/proxies` | GET/POST/`PATCH /:id`/`DELETE /:id` | 代理；删除时 `IN_USE` 受频道引用保护 |
| `/api/channels` | GET `/`、`/updates`、`/:id/*` | 列表/更新；`POST /`、`PATCH /:id` 需 `requireSelectedAuthorization`（按 `authorizationPlatform` 校验 cookie 已配置）；`/initial-sync`、`/check`、`/pause`、`/resume` |
| `/api/notifications` | GET `/`、POST `/read`、`/read-all`、`/:id/read` | 标记已读；ID 校验 `^[1-9]\d*$` |
| `/api/yt-dlp/tasks` | GET `/` | 任务快照 |
| `/api/downloads` | GET `/`（分页/tab/检索）、`/events`（SSE）、`/:id/*` | 列表、实时事件、详情 |
| `/api/downloads/:id/{media,file,thumbnail}` | GET | 流式输出（支持 `Range`/`HEAD`） |
| `/api/downloads/:id/{cancel,retry}` | POST | 空 body |
| `DELETE /api/downloads/:id` | DELETE | 删除 |

分页：`page`（`^[1-9]\d*$`，`PAGE_SIZE=20`）；下载 tab：`active|completed|failed`。ID 类参数统一 `^[1-9]\d*$` + `Number.isSafeInteger`。

页面（`src/routes/pages.ts`）：`/`、`/settings`、`/authorizations`、`/channels`、`/notifications`、`/downloads`、`/database`、`/downloads/preview`、`/guide`、`/channels/:id`、`/public/*`（静态）。

### 下载列表 tab → 状态

- `active`：`pending/downloading/running/deleting`
- `completed`：`completed`
- `failed`：`failed/canceled/interrupted`

## 5. 存储与文件系统安全

- 下载根：`validateDownloadRoot(root, mount)` —— 均绝对、realpath 后校验 `mount` ⊇ `root`、可读写执行。
- 文件打开：`validateDownloadFile` 用 `realpath` + `isContained` + `O_NOFOLLOW` + dev/ino 对账（防 TAM）。
- 任务目录在 `.vidharbor-tmp/<id>`，完成时硬链接归档到 `<root>/<id>/` 再删临时目录；缩略图临时 `.thumbnail/`。
- 密码/凭据：代理密码服务端脱敏展示、不落库明文回显；cookie 目录 `0o700`、文件 `0o600`。

## 6. 数据库约定

迁移 `src/db/migrate.ts`：`BEGIN EXCLUSIVE`，先 `integrity_check`/`foreign_key_check`，8 步应用后断言 schema 与最新迁移一致 + 存在 `settings.id=1` 行。外键默认 `ON`，迁移期间临时 `OFF`。`src/db/migrations/*.sql` 编号 001–008，新增迁移需同步更新 `MIGRATIONS` 数组（`noUncheckedIndexedAccess`，显式下标）。
