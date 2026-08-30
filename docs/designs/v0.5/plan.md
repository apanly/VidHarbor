# v0.5 · 下载支持自定义分类文件夹

来源：Gitea #21

---

## 1. 需求契约

### 1.1 直下载指定目标文件夹

- **触发**：`POST /api/downloads/direct`，请求体新增必填键 `targetSubdirectory`。
- **输入**：
  - `url` string（既有）
  - `proxyId` number | null（既有）
  - `advancedOptions` object（既有）
  - `targetSubdirectory` **string | null**（新增，必填键；`null` 表示保存到下载根目录，保持当前行为）
- **输出**：`202` + `{ download }`（既有结构，无新增字段）。
- **落库**：`downloads.target_subdirectory` 写入校验后的相对路径或 `null`（不再固定写 `NULL`）。

### 1.2 频道批量下载指定目标文件夹

- **触发**：`POST /api/downloads/channel`，请求体新增必填键 `targetSubdirectory`。
- **输入**：
  - `videoIds` number[]（既有）
  - `proxyId` `'channel' | number | null`（既有）
  - `targetSubdirectory` **string | null**（新增，必填键）
- 该目录对本次批量所有 downloadId 生效（同一批共用一个 target_subdirectory）。

### 1.3 已完成下载移动到另一个文件夹

- **触发**：新增 `POST /api/downloads/:id/move`，请求体 `{ targetSubdirectory: string | null }`（必填键）。
- **前置条件**：下载 `status = 'completed'` 且 `archive_layout = 'download_directory'`。
- **行为**：把整个 `downloadId` 目录从 `join(root, 旧subdir, id)` 移动（rename）到 `join(root, 新subdir, id)`，随后更新该行的 `output_path`、`thumbnail_path`、`target_subdirectory`。
- **输出**：`204`。

### 1.4 最近文件夹选项

- **触发**：新增 `GET /api/downloads/folders`。
- **行为**：返回历史使用过的、非空 `target_subdirectory` 去重列表，按最近使用（`MAX(id)` 降序）排序，最多 20 条。
- **输出**：`{ folders: string[] }`。UI 用作输入框的 datalist / 快捷选项。

### 1.5 target_subdirectory 校验契约（相对路径）

对所有写入 `target_subdirectory` 的入口（直下载、频道下载、移动）统一执行：

- `null` → 合法，表示根目录行为。
- string → 按 `/` 切分为路径段，**每一段**必须满足既有单路径段安全规则（复用 `validateChannelName`，见 §3）：非空、无前后空白、NFC 归一、不等于 `.` 或 `..`、不含 `/`、`\\`、控制字符、代理对，段长 ≤ 80 字符且 ≤ 255 字节。
- 由此天然拒绝：绝对路径（前导 `/` 产生空段）、`..`、`.`、空路径段（`a//b`）、路径逃逸。
- 任一段非法 → 抛 `BusinessError('VALIDATION_ERROR', ...)`（400），**显式失败，不做规范化/兜底/静默忽略**。
- 校验通过后回写各段 `join('/')` 作为存储值。

### 1.6 错误处理

| 场景 | 处理 |
| ------ | ------ |
| `targetSubdirectory` 键缺失 / 类型非 string\|null | `VALIDATION_ERROR`(400)，快速失败 |
| 路径段非法（`..`/空段/绝对/超长等） | `VALIDATION_ERROR`(400)，快速失败 |
| 下载时最终 `downloadId` 目录已存在 | worker 内既有 `'final download directory already exists'` 失败路径（保持） |
| move 目标 `downloadId` 目录已存在 | `DOWNLOAD_MOVE_TARGET_EXISTS`(409) |
| move 对象非 completed / 非 download_directory | `VALIDATION_ERROR`(400) `download is not movable` |
| move 目标与当前目录相同 | `VALIDATION_ERROR`(400) `target folder is unchanged` |
| move rename / FS 失败或落库 changes≠1 | `DOWNLOAD_MOVE_FAILED`(422)，尽力回滚 rename |
| 未知输入键 | 沿用既有“精确键集合校验”（键数量与集合必须完全匹配） |

---

## 2. 范围边界

### 做

- 直下载、频道批量下载写入并使用 `target_subdirectory`。
- 下载 worker 将成品归档到 `join(root, subdir, downloadId)`，subdir 不存在时自动递归创建；`downloadId` 目录已存在仍失败。
- 已完成下载的“移动到另一个文件夹”接口与入口。
- 最近文件夹列表接口。
- 删除流程正确定位含 subdir 的成品目录。
- 重试保持原 `target_subdirectory`。
- 直下载 / 频道页 UI 增加“保存到文件夹”输入框（含最近文件夹 datalist）；完成项增加“移动”入口。

### 不做（显式排除）

- ❌ 不新增数据库列 / 不新增迁移 SQL（`downloads.target_subdirectory`、`archive_layout` 已存在，见 §3）。
- ❌ 不做自动作者分类、分类表、文件夹管理页、标签系统、磁盘目录树扫描。
- ❌ 不支持绝对路径、`.`、`..`、空段、路径逃逸（一律显式报错）。
- ❌ 不为 `legacy_file` 布局的旧下载提供移动能力（显式拒绝）。
- ❌ 不改变“每个 downloadId 一个独立目录”的既有约定。
- ❌ 不新增任何格式兼容 / 别名字段 / fallback。

### 验收标准（版本级）

1. `npx tsc -p tsconfig.json --noEmit` 无类型错误。
2. `npx vitest run` 全绿（含新增/更新用例）。
3. 直下载 / 频道下载传入合法相对多级路径时，成品目录为 `root/<subdir>/<id>/...`，`downloads.target_subdirectory` 落库对应值。
4. 传入 `..`/空段/绝对路径返回 400；move 到已存在目标目录返回 409。

---

## 3. 实现设计

### 3.1 复用的现有能力（禁止重复实现）

| 能力 | 位置 | 用途 |
| ------ | ------ | ------ |
| 单路径段安全校验 | `src/filesystem.ts` `validateChannelName`（约 55 行） | 逐段校验 subdirectory，**不得**另写等价段校验 |
| 下载根 / 挂载校验 | `src/filesystem.ts` `validateDownloadRoot` | 计算 realRoot |
| 成品文件校验 | `src/filesystem.ts` `validateDownloadFile` | 删除/移动前证明成品可达（既有调用保持） |
| `target_subdirectory` 列 | `src/db/migrations/003`、`008`（列已在 downloads 表） | 直接复用，无需迁移 |
| `archive_layout` 列 | `src/db/migrations/004`、`008` | 区分 `download_directory` / `legacy_file` |
| FS 原语 | `download.ts` 已 import `rename`、`mkdir`、`realpath`、`basename`、`join`、`dirname` | 移动/路径拼接直接复用 |

方案层级判定：需求全部落在**仓库现有能力**层（列已存在、段校验函数已存在、FS 原语已 import），**在第一层即满足契约，不引入任何新依赖或新抽象**。

### 3.2 涉及文件与改动

**数据库**：不涉及。`target_subdirectory`、`archive_layout` 均为既有列，无 schema 变更 → **不生成 `docs/database/v0.5.sql`**（无 SQL 变更不建空文件）。

**`src/filesystem.ts`**

- 新增导出 `validateTargetSubdirectory(input: string): string`：`input.split('/').map(validateChannelName).join('/')`。非法段由 `validateChannelName` 抛 `VALIDATION_ERROR`。（`null` 由各调用方在外层判定，不进本函数。）

**`src/errors.ts`**

- `ERROR_HTTP_STATUS` 新增：`DOWNLOAD_MOVE_TARGET_EXISTS: 409`、`DOWNLOAD_MOVE_FAILED: 422`。

**`src/services/download.ts`**

- `QueuedDownload` 新增可选 `targetSubdirectory?: string`。
- `PreparedDownload` 新增 `targetSubdirectory: string | null`。
- 新增 `parseTargetSubdirectory(value: unknown): string | null`：`null`→`null`；string→`validateTargetSubdirectory`；其他类型→`VALIDATION_ERROR`。
- `parseDirectInput`：键集合由 `{url,proxyId,advancedOptions}` 改为含 `targetSubdirectory` 的 4 键（数量与集合精确匹配），产出 `targetSubdirectory`。
- `createDirectDownload` / `prepareChannelDownloads`：把 `targetSubdirectory` 写入 `PreparedDownload`（频道批量由入参统一传入）。
- `insertDownloads`：`target_subdirectory` 由固定 `NULL` 改为绑定 `value.targetSubdirectory`。
- `enqueueDownloads`：`targetSubdirectory !== null` 时带入 `QueuedDownload`。
- `RetryDownloadRow` + 重试查询：`SELECT ... d.target_subdirectory`；重试 `QueuedDownload` 带上原值（重试 UPDATE 不改该列）。
- 删除流程：`DeletingDownloadRow` 增加 `target_subdirectory`；`finalizeDeletingDownload` 与 `deleteDownload` 中 `download_directory` 的目录由 `join(realDownloadRoot, id)` 改为 `join(realDownloadRoot, subdir ?? '', id)`。
- 新增 `moveDownload(database, downloadsMountPath, downloadId, input)`：见 §1.3；`completed` + `download_directory` 才可移动；校验当前目录=`realpath(dirname(output_path))`；目标已存在→`DOWNLOAD_MOVE_TARGET_EXISTS`；`mkdir(join(root,新subdir),{recursive:true})` 自动建目录；`rename`；用 `basename(output_path)` / `basename(thumbnail_path)` 重算并 `UPDATE ... WHERE id=? AND status='completed'`，`changes≠1` 时回滚 rename 并抛 `DOWNLOAD_MOVE_FAILED`。
  - `ponytail:` 无跨进程锁，依赖 SQLite 单写入 + `status='completed'` 守卫；若未来并发移动/删除同一项成为瓶颈，再引入状态过渡（参考 delete 的 `deleting` 机制）。
- 新增 `listDownloadFolders(database): string[]`：`SELECT target_subdirectory FROM downloads WHERE target_subdirectory IS NOT NULL GROUP BY target_subdirectory ORDER BY MAX(id) DESC LIMIT 20`。

**`src/download-worker.ts`**

- `#run` 中 `targetDirectory` 由 `join(realDownloadRoot, String(downloadId))` 改为：subdir 存在则 `mkdir(join(realDownloadRoot, subdir), {recursive:true})`（校验 `isContained`），再 `targetDirectory = join(realDownloadRoot, subdir, String(downloadId))`；`mkdir(targetDirectory)` 仍非递归，`EEXIST` 保持 `'final download directory already exists'` 失败。

**`src/routes/downloads.ts`**

- `parseChannelInput`：键集合改为 `{videoIds, proxyId, targetSubdirectory}`（3 键精确匹配），透传 `targetSubdirectory`。
- `createChannelDownloads` 调用链传入 `targetSubdirectory`。
- 新增 `GET /api/downloads/folders`（**注册在 `/:id` 之前**）→ `listDownloadFolders`。
- 新增 `POST /api/downloads/:id/move` → `moveDownload`，`204`。
- `DownloadRow` + `toDownloadSnapshot`：增加 `target_subdirectory` → `targetSubdirectory`，供 UI 显示当前文件夹并预填移动弹窗。

**`src/services/download.ts` ↔ 路由/入参**：`createChannelDownloads` 增加 `targetSubdirectory` 形参并向下传递。

**UI**

- `src/views/downloads.ejs`：直下载表单增加 `name="targetSubdirectory"` 输入框 + 关联 datalist（最近文件夹）。
- `src/public/downloads.js`：直下载提交带 `targetSubdirectory`；加载 `/api/downloads/folders` 填充 datalist；完成项操作区增加“移动”入口（弹窗/输入 → `POST /:id/move`），成功后刷新。
- `src/views/channel-detail.ejs`：下载工具条增加 `name="targetSubdirectory"` 输入框 + datalist。
- `src/public/channel-detail.js`：频道下载提交带 `targetSubdirectory`；加载最近文件夹。
- `src/i18n.ts`：新增文案键（保存到文件夹、移动、移动确认、目标已存在等）。

**测试**

- 既有契约测试需更新：`test/integration/pages.test.ts` 断言 `name="targetSubdirectory"` 不存在与直下载 POST 体形状（约 1177、1210 行）；`test/integration/download-service.test.ts` 的 `directInput` 助手需补 `targetSubdirectory`。
- 新增：`validateTargetSubdirectory` 单测（含负向：`..`、空段、绝对、超长）；service 层 move / folders / 含 subdir 的删除；worker 层 subdir 目录自动创建与 `downloadId` 目录已存在失败。

### 3.3 风险

- **删除定位**：删除依赖 `target_subdirectory` 计算成品目录，旧数据该列为 `NULL`（等价根目录），逻辑与既有一致，无回归。
- **move 原子性**：非事务性 FS + DB，采用“先 rename 后 UPDATE，失败回滚 rename”，并用 `ponytail:` 标注锁定上限。
- **既有负向测试**：新增字段会命中现有“断言不存在”的测试，必须同步更新（已在测试 task 列明）。
