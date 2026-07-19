# Tasks - v0.2

## task-01 · 统一底层 yt-dlp 取消协议
- 状态: done
- 依赖: 无
- 文件范围:
  - src/yt-dlp.ts
  - test/integration/yt-dlp.test.ts
  - test/fixtures/fake-yt-dlp.mjs
- 关键约束:
  - 不能在 `src/yt-dlp.ts` 中引入任务类型、队列、并发配置或业务状态。
  - 必须继续使用参数数组、`shell: false` 和 detached 进程组，并在取消后等待子进程 `close`。
- 任务目的: 为五类任务提供可由统一管理器注入的完整进程组取消能力，同时保持底层模块只负责固定执行协议。
- 实现入口: `src/yt-dlp.ts:18`（`FetchOptions`）、`src/yt-dlp.ts:86`（`runProcess`）、`src/yt-dlp.ts:315`（`fetchJsonLines`）
- 期望行为: 频道列表抓取和单项元数据探测与媒体、缩略图下载一样接受 `AbortSignal`；取消抓取时终止完整进程组并分类为取消，既有超时、退出码、输出解析、脱敏和无 shell 行为不变。
- 范围边界:
  - 必须: `FetchOptions.signal` 传入 `runProcess`，fixture 能稳定验证抓取任务及其派生子进程被取消。
  - 不能: 不能只杀父进程、提前 resolve/reject，或把取消归类为普通成功。
  - 不做: 不新增重试、进程池、任务状态或调度字段。
- 验收标准:
  1. `npx vitest run test/integration/yt-dlp.test.ts` → 全部测试通过，包含抓取取消和完整进程组退出用例。
  2. `rg -n "readonly signal\?: AbortSignal" src/yt-dlp.ts` → 命中抓取选项中的取消信号声明。
  3. `rg -n "shell: false|process\.kill\(-child\.pid" src/yt-dlp.ts` → 同时保留无 shell 与进程组终止实现。

## task-02 · 实现唯一 yt-dlp 任务管理器
- 状态: failed
- 依赖: task-01
- 文件范围:
  - src/yt-dlp-task-manager.ts (新建)
  - test/unit/yt-dlp-task-manager.test.ts (新建)
- 关键约束:
  - 不能接受五类之外的任务类型，也不能接受 `priority`、`pool`、`weight`、`dedupe`、`retry` 等未定义调度字段。
  - 必须使 `succeeded`、`failed`、`canceled` 不可逆，并在任务收敛后释放 controller、执行函数和监听器引用。
- 任务目的: 建立所有业务 yt-dlp 调用的唯一入口、固定状态机、下载 FIFO 调度和统一取消/停机屏障。
- 实现入口: 新建；底层 operations 对接 `src/yt-dlp.ts:339`、`src/yt-dlp.ts:345`、`src/yt-dlp.ts:356`、`src/yt-dlp.ts:437`
- 期望行为: 管理器构造时接收可执行路径、启动时固定的正整数 `download_concurrency` 和脱敏函数；`submit<T>` 返回 `{ id, result }`，ID 从 1 单调递增；媒体任务按 FIFO 和下载并发上限运行，其余四类在提交后的调度轮次直接运行且不占下载额度；快照按 ID 升序只含固定展示字段；`cancel` 与幂等 `stop()` 等待运行任务真正收敛。
- 范围边界:
  - 必须: 覆盖五类类型、五种状态、排队/运行取消、首次合法终态胜出、停止后拒绝提交和相同 stop promise。
  - 不能: 不能读取数据库、解释业务结果、持久化任务、裁剪历史或暴露 URL、参数、payload、结果、PID、controller。
  - 不做: 不实现优先级、自动重试、去重、持久化恢复、全局并发上限或非下载专用队列。
- 验收标准:
  1. `npx vitest run test/unit/yt-dlp-task-manager.test.ts` → 状态机、并发、FIFO、取消、非法输入和停机用例全部通过。
  2. `rg -n "media_download|metadata_probe|channel_initial_sync|channel_manual_check|channel_scheduled_check" src/yt-dlp-task-manager.ts` → 五个固定任务类型均存在。
  3. `rg -n "from './yt-dlp\.js'" src --glob '*.ts'` → 仅 `src/yt-dlp-task-manager.ts` 命中。

## task-03 · 将下载 worker 接入管理器
- 状态: done
- 依赖: task-02
- 文件范围:
  - src/download-worker.ts
  - test/integration/download-worker.test.ts
- 关键约束:
  - 不能在 worker 中保留第二套 FIFO、并发计数、活动 `AbortController`、调度循环或对 `src/yt-dlp.ts` 的直接导入。
  - 必须保留下载记录迁移、临时目录、进度持久化、文件验证、归档、回滚和运行时故障上报边界。
- 任务目的: 让媒体和可选缩略图在同一个 `media_download` 任务及同一取消信号内执行，由管理器独占下载调度权。
- 实现入口: `src/download-worker.ts:249`（`tryDownloadThumbnail`）、`src/download-worker.ts:280`（`DownloadWorker`）、`src/download-worker.ts:317`（`enqueue`）、`src/download-worker.ts:388`（`#run`）
- 期望行为: `enqueue` 提交 `media_download` 并维护 `downloadId -> taskId` 活动映射；取消排队任务不启动进程，取消运行任务等待管理器收敛；媒体与缩略图只经 operations 调用，缩略图普通失败仍可忽略，但取消不能被吞掉且取消后不得归档或写成功。
- 范围边界:
  - 必须: 下载名额覆盖现有完整执行边界，业务终态落库先于管理器任务成功，持久化边界失败继续上报。
  - 不能: 不能自行读取 `download_concurrency`、保存 PID/controller 或调用底层执行函数。
  - 不做: 不改变目录布局、进度字段、失败原因、文件校验和回滚契约。
- 验收标准:
  1. `npx vitest run test/integration/download-worker.test.ts` → 进度、落盘、失败、取消、可选缩略图、回滚及管理器提交用例通过。
  2. `rg -n "from './yt-dlp\.js'|#queue|#activeCount|#activeDownloads" src/download-worker.ts` → 无匹配。
  3. `rg -n "media_download|taskId" src/download-worker.ts` → 命中管理器任务提交与活动映射。

## task-04 · 统一下载服务的探测与取消契约
- 状态: failed
- 依赖: task-02, task-03
- 文件范围:
  - src/services/download.ts
  - test/integration/download-service.test.ts
- 关键约束:
  - 不能在下载记录创建前跳过元数据探测，也不能改变现有输入、响应数据、业务错误码或重试语义。
  - 必须将 `DownloadQueue.cancel` 收紧为异步必需方法并等待取消完成。
- 任务目的: 使直接下载的元数据探测和既有下载取消都通过统一管理器边界执行。
- 实现入口: `src/services/download.ts:43`（`DownloadQueue`）、`src/services/download.ts:525`（`enqueueDownloads`）、`src/services/download.ts:576`（`createDirectDownload`）、`src/services/download.ts:698`（`cancelDownload`）、`src/services/download.ts:851`（`retryDownload`）
- 期望行为: `createDirectDownload` 提交一个 `metadata_probe` 并等待其结果，成功后才校验元数据、写下载记录和提交媒体任务；`cancelDownload` 在业务记录成功变为 `canceled` 后 await 队列取消；频道批量创建及 retry 每次仍提交新的媒体任务。
- 范围边界:
  - 必须: 保持直接下载探测失败映射为 `VIDEO_FETCH_FAILED`，缺少或非法元数据不创建记录。
  - 不能: 不能继续导入 `fetchVideoMetadata`，不能把探测改成后台 fire-and-forget，不能让 `cancel` 可选。
  - 不做: 不增加字段别名、探测 fallback、自动重试或下载状态。
- 验收标准:
  1. `npx vitest run test/integration/download-service.test.ts` → 直接探测、批量入队、取消与重试契约测试通过。
  2. `rg -n "metadata_probe" src/services/download.ts` → 命中固定探测任务提交。
  3. `rg -n "fetchVideoMetadata|cancel\?" src/services/download.ts` → 无匹配。

## task-05 · 将三类频道流程收口为固定任务
- 状态: done
- 依赖: task-02
- 文件范围:
  - src/services/channel.ts
  - test/integration/channel-initial-sync.test.ts
  - test/integration/channel-scheduled-check.test.ts
  - test/integration/channel-notification-api.test.ts
  - test/integration/end-to-end.test.ts
- 关键约束:
  - 不能允许调用方传入任意任务类型，不能把一次频道操作中的列表抓取与逐项探测拆成多个界面任务。
  - 必须保留频道业务校验、`syncing`/检查记录预写、业务失败记录、通知事务和平台解析规则。
- 任务目的: 让首次同步、手动检查、定时检查分别以固定类型进入统一管理器，并共享同一任务取消边界。
- 实现入口: `src/services/channel.ts:957`（`completeChannelCreation`）、`src/services/channel.ts:1133`（`prepareInitialSync`）、`src/services/channel.ts:1203`（`completeInitialSync`）、`src/services/channel.ts:1255`（`acceptInitialChannelSync`）、`src/services/channel.ts:1293`（`checkChannel`）
- 期望行为: 服务不再接收可执行路径或直接调用底层函数；首次同步快速返回 `{ accepted: true }` 并提交 `channel_initial_sync`；手动与定时包装入口分别提交 `channel_manual_check`、`channel_scheduled_check`，共享现有检查准备、operations 执行、数据解释和持久化实现；同一频道任务的全部子进程共享同一 signal。
- 范围边界:
  - 必须: 业务终态落库发生在任务执行函数返回前，普通抓取/解析失败只终止对应任务并沿用现有业务错误映射。
  - 不能: 不能直接导入 `src/yt-dlp.ts`，不能新增频道 `canceled` 业务状态，不能改变首次同步与手动检查的响应时序。
  - 不做: 不把 scheduler 的同频道防重移入管理器，不增加频道级并发限制或重试。
- 验收标准:
  1. `npx vitest run test/integration/channel-initial-sync.test.ts test/integration/channel-scheduled-check.test.ts test/integration/channel-notification-api.test.ts test/integration/end-to-end.test.ts` → 频道状态、通知、错误和固定任务类型测试通过。
  2. `rg -n "channel_initial_sync|channel_manual_check|channel_scheduled_check" src/services/channel.ts` → 三类固定提交入口均命中。
  3. `rg -n "yt-dlp\.js|ytDlpExecutablePath" src/services/channel.ts` → 无匹配。

## task-06 · 收紧 scheduler 与 runtime 生命周期职责
- 状态: done
- 依赖: task-05
- 文件范围:
  - src/scheduler.ts
  - src/runtime.ts
  - test/unit/scheduler.test.ts
  - test/unit/runtime.test.ts
- 关键约束:
  - 不能在 scheduler 或 runtime 中持有 yt-dlp 进程、取消控制器或第二套通用任务生命周期。
  - 必须保留 scheduler 到期计算、同频道防重、错误分类和停止后等待已派发检查的行为。
- 任务目的: 使定时器只派发固定定时检查任务，并移除 runtime 对首次同步任务集合的重复管理。
- 实现入口: `src/scheduler.ts:88`（`ChannelScheduler`）、`src/scheduler.ts:121`（`stop`）、`src/scheduler.ts:129`（`tick`）、`src/runtime.ts:7`（`RuntimeCoordinator`）
- 期望行为: scheduler 回调只调用定时检查包装入口并继续跟踪已派发 promise；`stop()` 先停止计时器再等待已派发检查；runtime 只负责运行时故障上报和下载 SSE，首次同步 promise 的已记录业务失败与系统失败由现有边界区分但不再形成独立停机屏障。
- 范围边界:
  - 必须: 同一频道运行中不重复派发，已记录频道失败不升级为系统故障，持久化失败仍上报。
  - 不能: 不能暗加非下载并发上限，不能保留 `trackInitialSync`/`waitForInitialSyncTasks` 集合职责。
  - 不做: 不改变 60 秒 tick、到期公式、SSE 注册和关闭协议。
- 验收标准:
  1. `npx vitest run test/unit/scheduler.test.ts test/unit/runtime.test.ts` → 调度、防重、停止等待、故障上报和 SSE 测试通过。
  2. `rg -n "trackInitialSync|waitForInitialSyncTasks|#initialSyncTasks" src/runtime.ts` → 无匹配。
  3. `rg -n "#runningChecks|Promise\.allSettled" src/scheduler.ts` → 保留同频道防重与停止收敛机制。

## task-07 · 注入管理器并保持既有下载与频道 API
- 状态: done
- 依赖: task-04, task-05, task-06
- 文件范围:
  - src/app.ts
  - src/routes/downloads.ts
  - src/routes/channels.ts
  - test/integration/download-api.test.ts
  - test/integration/channel-notification-api.test.ts
- 关键约束:
  - 不能改变既有 HTTP 路径、请求体、成功响应、状态码或业务错误码。
  - 必须显式注入同一个管理器，不能通过 `createApiRouter` 默认值隐式创建第二个实例。
- 任务目的: 将下载与频道 HTTP 入口连接到统一管理器，同时维持全部既有接口兼容。
- 实现入口: `src/app.ts:98`（`createApiRouter`）、`src/routes/downloads.ts:331`（`createDownloadsRouter`）、`src/routes/channels.ts:33`（`createChannelsRouter`）
- 期望行为: 路由不再透传 yt-dlp 可执行路径；直接下载仍在探测后返回 202，批量下载仍返回 202，取消 await 管理器后返回 204，retry 返回 202；首次同步仍快速返回 202，手动检查仍等待任务完成后返回现有 202 结果。
- 范围边界:
  - 必须: 所有路由和测试组合根显式共享传入的 manager/worker/runtime 实例。
  - 不能: 不能新增通用创建、重试、取消任务 HTTP 接口，不能给非下载任务增加用户取消入口。
  - 不做: 不在本任务实现任务快照 API 或页面。
- 验收标准:
  1. `npx vitest run test/integration/download-api.test.ts test/integration/channel-notification-api.test.ts` → 既有下载和频道 HTTP 契约测试通过。
  2. `rg -n "ytDlpExecutablePath" src/routes/downloads.ts src/routes/channels.ts src/app.ts` → 无匹配。
  3. `rg -n "new YtDlpTaskManager" src/app.ts` → 无匹配，证明组合函数不隐式创建 manager。

## task-08 · 提供只读任务快照 API
- 状态: done
- 依赖: task-07
- 文件范围:
  - src/app.ts
  - src/routes/yt-dlp-tasks.ts (新建)
  - test/integration/yt-dlp-tasks-api.test.ts (新建)
- 关键约束:
  - 不能提供 `POST /api/yt-dlp/tasks`、通用重试或 `/api/yt-dlp/tasks/:id/cancel`。
  - 必须直接返回管理器同一时刻复制的快照，不能从下载、频道或检查记录推导任务状态。
- 任务目的: 实现 PRD 定义的 `GET /api/yt-dlp/tasks` 只读展示契约。
- 实现入口: `src/app.ts:108`（API 子路由挂载）；新建 `createYtDlpTasksRouter`
- 期望行为: `GET /api/yt-dlp/tasks` 返回 200 JSON `{ tasks }`，任务按 ID 升序且每项仅含 `id`、`type`、`status`、`createdAt`、`startedAt`、`finishedAt`、`failureReason`；时间与 null 规则符合状态机，失败原因已脱敏；意外异常沿用全局 `PERSISTENCE_ERROR` 500 格式。
- 范围边界:
  - 必须: 测试五类 type、五种 status、三种终态、字段集合、排序与凭据不泄露。
  - 不能: 不能返回业务 payload、URL、代理、执行参数、返回值、controller 或进程信息。
  - 不做: 不增加查询参数、筛选、分页、排序选项、自动刷新协议或写接口。
- 验收标准:
  1. `npx vitest run test/integration/yt-dlp-tasks-api.test.ts` → 快照字段、排序、状态、脱敏和禁止写接口用例通过。
  2. `rg -n "router\.get\('/'" src/routes/yt-dlp-tasks.ts` → 恰有只读集合入口。
  3. `rg -n "router\.(post|delete|patch|put)" src/routes/yt-dlp-tasks.ts` → 无匹配。

## task-09 · 迁移 API 组合根的其余测试调用点
- 状态: pending
- 依赖: task-08
- 文件范围:
  - test/integration/database-browser.test.ts
  - test/integration/pages.test.ts
  - test/integration/settings-proxy-api.test.ts
- 关键约束:
  - 不能为方便测试而恢复可选 manager、默认 manager 或旧位置参数兼容层。
  - 必须在每个测试应用中显式构造并共享所需 manager，测试结束时使任务收敛。
- 任务目的: 让所有既有 `createApiRouter` 测试调用点遵守“单例由组合根显式注入”的新契约。
- 实现入口: `test/integration/database-browser.test.ts:27`、`test/integration/pages.test.ts:27`、`test/integration/settings-proxy-api.test.ts:29`
- 期望行为: 数据库浏览器、页面和设置/代理 API 测试使用新的明确构造签名且不生成隐藏 manager；原测试断言不因依赖注入迁移而弱化。
- 范围边界:
  - 必须: 每个测试套件使用可控依赖并清理活动任务。
  - 不能: 不能改动被测生产行为或删除原有断言来绕过新签名。
  - 不做: 不在本任务增加任务状态页面断言。
- 验收标准:
  1. `npx vitest run test/integration/database-browser.test.ts test/integration/settings-proxy-api.test.ts` → 两套 API 回归全部通过。
  2. `rg -n "createApiRouter\(" test/integration/database-browser.test.ts test/integration/pages.test.ts test/integration/settings-proxy-api.test.ts` → 三个调用点均存在并采用新签名。
  3. `rg -n "unused-yt-dlp" test/integration/database-browser.test.ts test/integration/pages.test.ts` → 无匹配。

## task-10 · 以管理器重构服务启动与停机屏障
- 状态: pending
- 依赖: task-03, task-06, task-08, task-09
- 文件范围:
  - src/server.ts
  - test/integration/server-lifecycle.test.ts
  - test/integration/restart-recovery.test.ts
- 关键约束:
  - 不能在数据库关闭后仍允许任务回调访问数据库，也不能依赖 worker 私有 stop 队列或 runtime 首次同步集合收尾。
  - 必须在启动时只读取一次有效 `download_concurrency` 并创建唯一 manager，启动失败清理与正常停机复用其幂等 `stop()`。
- 任务目的: 让任务管理器成为服务停止时唯一的 yt-dlp 收尾屏障，并保持既有重启恢复契约。
- 实现入口: `src/server.ts:156`（`startServer`）、`src/server.ts:212`（worker/scheduler 组合）、`src/server.ts:242`（`RunningServer.stop`）、`src/server.ts:287`（启动失败清理）
- 期望行为: server 将同一 manager 注入 worker、频道服务、scheduler 和 API；停机先停 scheduler 派发并同步触发 manager stop，再关闭 HTTP/SSE，等待 scheduler、manager 及下载业务回调收敛，最后关闭数据库；stop 重复调用复用同一 promise；启动清理也拒绝新任务并取消所有活动任务。
- 范围边界:
  - 必须: 测试停止后拒绝提交、排队/运行任务取消、派生进程退出、业务回调完成、重复停止和关闭顺序。
  - 不能: 不能改变配置需重启后生效的语义，不能新增任务自动续跑、自动重试或断点续传。
  - 不做: 不持久化管理器历史；服务重启后任务 ID 从 1 重新计数且快照清空。
- 验收标准:
  1. `npx vitest run test/integration/server-lifecycle.test.ts test/integration/restart-recovery.test.ts` → 启停、取消收敛、关闭顺序及恢复测试通过。
  2. `npm run build` → TypeScript、Sass 和静态资源构建成功。
  3. `rg -n "waitForInitialSyncTasks|worker\?\.stop|worker\.stop" src/server.ts` → 无匹配。

## task-11 · 实现任务状态页面与导航
- 状态: pending
- 依赖: task-08
- 文件范围:
  - src/routes/pages.ts
  - src/views/partials/header.ejs
  - src/views/yt-dlp-tasks.ejs (新建)
  - src/public/yt-dlp-tasks.js (新建)
  - src/styles/main.scss
- 关键约束:
  - 不能增加筛选、搜索、分页、排序、自动轮询或取消按钮。
  - 必须只消费 `/api/yt-dlp/tasks` 快照，并对五个 type 与五个 status 使用固定中文映射；契约外值视为前端错误而非 fallback。
- 任务目的: 提供统一可刷新查看排队、运行和终态 yt-dlp 任务的独立页面。
- 实现入口: `src/routes/pages.ts:14`（`PAGE_ROUTES`）、`src/views/partials/header.ejs:16`（主导航）、`src/styles/main.scss:1138`（移动端规则）；页面与脚本为新建
- 期望行为: `/yt-dlp-tasks` 页面和主导航入口可访问；页面加载一次只读快照，分别展示活动状态与终态的任务 ID、固定中文任务类型、状态、时间和仅失败时的失败原因；空状态和移动端长文本换行清晰，刷新浏览器取得最新快照。
- 范围边界:
  - 必须: DOM 使用文本节点/`textContent` 展示失败原因，避免把返回文本当 HTML 注入。
  - 不能: 不能从下载或频道记录猜状态，不能静默兼容未知 type/status，不能展示敏感执行数据。
  - 不做: 不实现 SSE、WebSocket、定时轮询、图表、统计或任务操作控件。
- 验收标准:
  1. `npm run build` → 新 EJS、JS 和 Sass 均进入 dist 且构建成功。
  2. `rg -n "yt-dlp-tasks" src/routes/pages.ts src/views/partials/header.ejs src/views/yt-dlp-tasks.ejs src/public/yt-dlp-tasks.js src/styles/main.scss` → 路由、导航、页面、脚本和样式均命中。
  3. `rg -n "setInterval|WebSocket|EventSource|cancel" src/public/yt-dlp-tasks.js` → 无匹配。

## task-12 · 验证任务页面与全仓统一入口契约
- 状态: pending
- 依赖: task-10, task-11
- 文件范围:
  - test/integration/pages.test.ts
- 关键约束:
  - 不能用宽松匹配掩盖未知任务类型/状态，也不能删除既有页面回归断言。
  - 必须证明页面包含五类中文标签、五种状态、三种终态结果、失败原因脱敏和刷新读取同一快照的行为。
- 任务目的: 完成 UI 验收并以全套测试证明五类业务流程没有绕过唯一管理器且既有契约未回归。
- 实现入口: `test/integration/pages.test.ts:65`（`server-rendered pages` 测试套件）
- 期望行为: 页面路由、导航、表格、空状态、移动端换行和静态脚本契约均有机械测试；测试扫描生产源码确认只有 manager 导入底层 `yt-dlp.ts`；全套单元与集成测试通过。
- 范围边界:
  - 必须: 使用包含代理原始凭据的失败样本，断言 API 返回和页面 DOM 均不含原文。
  - 不能: 不能新增浏览器自动刷新或非下载取消入口，不能仅以快照 API 测试替代页面渲染测试。
  - 不做: 不增加端到端浏览器框架、视觉快照工具或新的生产代码。
- 验收标准:
  1. `npx vitest run test/integration/pages.test.ts` → 页面、导航、标签、状态、空状态、移动端及脱敏测试通过。
  2. `test "$(rg -l "from ['\"](?:\.\.?/)*yt-dlp\.js['\"]" src --glob '*.ts' | sort)" = "src/yt-dlp-task-manager.ts"` → 生产代码只有管理器导入底层模块。
  3. `npm test -- --run` → 全部单元与集成测试通过。
