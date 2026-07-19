# VidHarbor v0.1 技术设计

## 运行边界

- 单进程、单实例 Node.js 24 服务，Express 提供 EJS 页面和同源 JSON API。
- SQLite 使用 WAL 持久化；数据库固定挂载到 `/data`，下载存储固定挂载到 `/downloads`。
- yt-dlp 与 FFmpeg 只通过参数数组启动，`shell=false`；yt-dlp 显式启用 Node JavaScript runtime。
- 服务无登录和权限系统，仅允许部署在访问边界受控的可信内网。

## 模块职责

| 模块 | 职责 |
|---|---|
| `src/app.ts` | HTTP 中间件、同源写请求校验、API 组装和错误响应 |
| `src/server.ts` | 启动检查、迁移、恢复、worker/调度器/runtime 生命周期 |
| `src/runtime.ts` | 跟踪后台首次同步与活动 SSE 连接，保证有序停机 |
| `src/youtube.ts`、`src/bilibili.ts` | 严格解析受支持的频道地址与视频元数据 |
| `src/services/channel.ts` | 频道保存、人工首次同步、定时检查、视频和检查记录 |
| `src/services/download.ts` | 下载创建、重试、取消、删除和文件访问契约 |
| `src/download-worker.ts` | 单 FIFO 下载 worker、临时目录、归档和恢复 |
| `src/filesystem.ts` | 下载根、路径包含关系、真实文件与归档目录校验 |
| `src/yt-dlp.ts` | 固定 yt-dlp 参数协议、超时、取消和输出解析 |
| `src/routes/database.ts` | 数据表枚举与只读 SQL 查询接口 |

## 数据与迁移

- `001-initial.sql` 建立 v0.1 初始结构；`002-manual-channel-sync.sql` 增加人工首次同步状态；`003-generic-direct-downloads.sql` 允许直接下载记录保存 yt-dlp extractor 平台；`004-download-artifacts.sql` 增加时长、缩略图路径和新旧存储布局标记；`005-download-size.sql` 增加主媒体文件大小；`006-bilibili-channels.sql` 将频道、视频和频道下载的平台契约扩展到 Bilibili。
- `schema_migrations` 按版本顺序记录迁移，启动时执行完整性、外键和最终结构校验。
- 所有时间点以 UTC ISO 8601 文本持久化；页面需要时转换为中国时区或本地可读格式。
- 频道首次同步状态固定为 `pending | syncing | succeeded | failed`。
- 下载状态固定为 `pending | downloading | running | completed | failed | canceled | interrupted`。

## 频道流程

1. `POST /api/channels` 只保存频道，返回 `201 {"channel": Channel}`，不调用 yt-dlp。
2. 用户调用 `POST /api/channels/:id/initial-sync`，请求只接受 `historyMonths=1|3|6|12`。
3. 服务在同一事务中把频道改为 `syncing` 并创建检查记录，然后返回 `202 {"accepted":true}`。
4. 后台任务抓取所选 UTC 日期范围内的普通视频。YouTube 通过 `--dateafter` 限制范围，到达边界时 yt-dlp 的退出码 `101` 视为正常结束；Bilibili 以 `--flat-playlist` 获取空间投稿入口，再逐项读取元数据并在发布日期越过边界时停止。
5. 成功时原子写入历史视频且不生成提醒；范围内没有视频允许成功。失败时保留频道、检查记录和脱敏原因，用户可重新触发。
6. 只有 `succeeded` 且未暂停的频道进入每分钟调度器；后续检查沿用各平台的抓取方式并固定筛选最近 1 个月，边界内没有视频允许成功；新发现的视频生成站内提醒，不自动下载。

后台首次同步由 `RuntimeCoordinator` 跟踪。服务停止接收 HTTP 后，会等待已受理的同步完成，再关闭数据库。容器强制终止造成的 `syncing` 状态在下一次启动时恢复为 `failed`。

## 下载流程

- 频道批量下载必须提交非空且不重复的 `videoIds`；服务先验证整批输入，再在一个事务中创建记录。
- 单项直接下载只接受 HTTPS URL，由固定版本 yt-dlp 判断是否支持，并在创建记录前探测恰好一个资源；探测和实际下载都传递 `--no-playlist`。当前验证范围覆盖 YouTube、Bilibili、Vimeo、X、Facebook 公开单视频或 Reel；Bilibili 通过 `?p=<序号>` 选择分 P，未指定时选择第一 P，X 一帖多视频必须通过 `/video/<序号>` 选择具体媒体。抖音的目标格式为固定公开单视频地址，但可能因项目不提供 cookies 来源而失败。
- 直接下载元数据必须提供非空 `extractor_key`、标题和仅含字母、数字、下划线或连字符的归档 ID；平台按小写 `extractor_key` 持久化。HTTP、列表展开和缺少必要元数据均不支持。
- 下载先写入 `<downloadRoot>/.vidharbor-tmp/<downloadId>/`，验证主媒体及附加产物均为非空真实普通文件后，以不覆盖目标的硬链接归档到 `<downloadRoot>/<downloadId>/`。主媒体路径单独持久化用于预览和下载；缩略图使用独立的尽力下载流程，失败不改变主媒体的成功结果。旧记录通过存储布局字段继续按原单文件路径访问和删除。
- 用户可以取消活动任务、手工重试失败/取消/中断任务、删除终态下载，以及预览或下载已完成的主文件。删除已完成下载时先把已验证的归档文件移入同盘隔离目录，再在事务中删除记录和文件；记录删除失败时恢复原文件。失败、取消和中断任务没有归档文件，只删除记录。
- 下载列表通过 SSE 每 10 秒检查一次当前快照，只在数据变化时发送。前端按下载 ID 复用卡片，只更新变化字段、状态操作区以及新增或删除的下载项。活动 SSE 响应由 `RuntimeCoordinator` 登记；定时读取失败会关闭连接并进入运行时失败边界，服务停机也会主动关闭连接。
- 下载页面按标题在服务端搜索，并固定提供“已完成”“下载中”和“失败”三个视图。`completed` 进入已完成，`pending|downloading|running` 进入下载中，`failed|canceled|interrupted` 进入失败；卡片展示持久化的平台值。无任务、当前视图为空和搜索无结果分别显示明确空状态。新任务完成时持久化主媒体字节数，旧记录保持 `NULL`。同平台、同视频 ID 的等待、下载中、运行中或已完成记录会阻止新任务插入；失败、取消和中断记录不阻止用户重建。
- 频道视频查询通过 `downloads.video_id = videos.id` 选择按创建时间和 ID 倒序的最新下载记录，返回下载 ID、状态、完成时间、主媒体字节数和失败原因；完成记录提供预览与文件下载链接。
- yt-dlp 进度同时从 stdout 和 stderr 的固定模板读取；运行态持久化百分比、速度和 ETA，进入完成、失败、取消或中断终态时清除不再适用的速度和 ETA，重试时清空全部旧进度字段。

## 列表分页

- 下载、频道、频道视频、频道检查记录和提醒查询接受可选的 `page`，默认值为 `1`，每页固定 `20` 条。代理列表保持不分页。
- 页码只接受不带前导零的正十进制安全整数；无效值返回 `400 VALIDATION_ERROR`。超过总页数时保留请求页码并返回空 `items`。
- 分页响应固定为 `{"items":[],"pagination":{"page":1,"pageSize":20,"totalItems":0,"totalPages":0}}`。提醒响应额外返回全局 `unreadCount`，下载响应额外返回全局 `statusCounts`。
- 下载查询额外接受 `tab=active|completed|failed` 和可选标题 `q`；频道视频查询接受可选标题 `q`。筛选在 SQL 的 `COUNT` 与分页查询中使用同一条件，先筛选再执行 `LIMIT/OFFSET`。
- 下载 SSE 使用与当前页面相同的 `page`、`tab` 和 `q`，每 10 秒比较一次当前分页快照，仅在快照变化时发送。
- 频道详情由“视频列表”和“检查记录”两个页签组成，两个页签分别渲染表格和分页；视频页签保留标题筛选、代理选择和当前页批量下载。
- “全部标记已读”使用独立的全局更新接口，不提交当前页 ID，因此跨页生效。

## 文件访问

- `GET /api/downloads/:id/media` 支持单段 `Range`，用于浏览器内联播放。
- `GET /api/downloads/:id/file` 以附件形式返回同一主文件。
- 文件服务只接受 `completed` 记录；路径必须位于真实下载挂载内，并在打开后复核文件句柄对应的设备和 inode。
- 无效或不可满足的 Range 返回 `416 DOWNLOAD_RANGE_NOT_SATISFIABLE`，不可用文件返回 `404 DOWNLOAD_FILE_UNAVAILABLE`。

## 数据库浏览

- `GET /api/database/tables` 按名称返回 SQLite 中的全部数据表。
- `POST /api/database/query` 只接受非空 `sql` 字符串；SQLite 预编译语句的 `readonly` 必须为真，否则返回 `400 VALIDATION_ERROR`。
- 查询响应固定为列名数组、二维行数组和行数。接口不改写 SQL、不自动添加 `LIMIT`，页面仅在点击表名时生成 `SELECT * FROM <table> LIMIT 200`。
- 数据库浏览没有字段脱敏或独立权限边界，必须与整个无登录服务一起限制在可信内网。

## 错误边界

- 请求字段、状态、枚举和 URL 严格按固定契约校验，不支持别名、宽松解析或自动 fallback。
- 业务错误由 `BusinessError` 映射到固定 HTTP 状态；未知内部错误不向客户端暴露堆栈、绝对路径或代理凭据。
- 代理错误在持久化、API 和生命周期日志边界统一脱敏。
- SQLite 写入使用参数化语句；多表状态转换使用显式事务并在失败时回滚。

## 验证

```sh
npm test -- --run
npm run build
docker compose config --quiet
git diff --check
docker compose up -d --build
```

默认测试使用临时 SQLite、临时下载目录和假 yt-dlp/FFmpeg，不访问公网。真实 YouTube、Bilibili 频道、目标直接下载站点与代理只作为部署前的独立冒烟验证。
