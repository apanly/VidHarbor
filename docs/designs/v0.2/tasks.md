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
- 状态: done
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
- 状态: done
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
  3. `test -z "$(rg -n "from ['\"](?:\.\.?/)*yt-dlp\.js['\"]|cancel\\?" src/services/download.ts)"` → 无底层直连且 cancel 为异步必需方法；`rg -n "type: 'metadata_probe'|operations\.fetchVideoMetadata" src/services/download.ts` → 固定探测任务及受控 operation 调用均命中。

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
- 状态: done
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
- 状态: done
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
- 状态: done
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
- 状态: done
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

## task-13 · 复验唯一 yt-dlp 底层导入
- 状态: done
- 依赖: task-03
- 文件范围:
  - src/download-worker.ts
  - src/yt-dlp-task-manager.ts
- 关键约束:
  - 不能为通过静态验收而隐藏、拼接或间接构造导入路径，也不能改动相邻无关功能。
  - 必须基于当前最终代码验证 `src/yt-dlp-task-manager.ts` 是生产代码中唯一直接导入 `yt-dlp.js` 的模块。
- 任务目的: 修复 bugfix-01 描述的问题
- 实现入口: `src/download-worker.ts`（已由 task-03 移除的旧底层直连）、`src/yt-dlp-task-manager.ts:1`（唯一底层导入）
- 问题描述原文: task-02 的管理器实现及测试均通过，但执行当时 src/download-worker.ts 仍直接导入 src/yt-dlp.ts；该旧导入已由后续 task-03 移除，需要按当前最终代码重新执行唯一入口静态验收并关闭失败状态。
- 期望行为: 当前生产源码的底层 `yt-dlp.js` 直接导入列表仅包含 `src/yt-dlp-task-manager.ts`，`src/download-worker.ts` 不再绕过管理器。
- 范围边界:
  - 必须: 使用覆盖 `src/**/*.ts` 的静态命令按文件名精确复验唯一入口。
  - 不能: 不能改动与本 bug 无关的模块，不能通过字符串拼接、改名或动态导入规避检查。
  - 不做: 不重构管理器、下载 worker 或 yt-dlp 执行协议，不新增兼容逻辑。
- 验收标准:
  1. `test "$(rg -l "from ['\"](?:\.\.?/)*yt-dlp\.js['\"]" src --glob '*.ts' | sort)" = "src/yt-dlp-task-manager.ts"` → 唯一底层导入复验通过。
  2. `test -z "$(rg -n "yt-dlp\.js" src/download-worker.ts)"` → 下载 worker 不含底层模块直连。

## task-14 · 精确验收下载服务的受控元数据探测
- 状态: done
- 依赖: task-04
- 文件范围:
  - src/services/download.ts
  - src/yt-dlp-task-manager.ts
  - test/integration/download-service.test.ts
- 关键约束:
  - 不能为通过静态验收而拆分 `fetchVideoMetadata` 字符串、重命名已确认的 operation 或改动相邻无关功能。
  - 必须区分下载服务对底层函数的直接导入与通过管理器注入的 `operations.fetchVideoMetadata` 受控调用。
- 任务目的: 修复 bugfix-02 描述的问题
- 实现入口: `src/services/download.ts:582`（`createDirectDownload`）、`src/services/download.ts:594`（`metadata_probe` 提交及受控 operation 调用）、`src/yt-dlp-task-manager.ts:42`（`YtDlpOperations.fetchVideoMetadata` 契约）
- 问题描述原文: task-04 已移除下载服务对底层 fetchVideoMetadata 的直接导入和可选 cancel，并通过 20 个集成测试；失败来自静态命令同时匹配管理器契约要求的 operations.fetchVideoMetadata 方法名，需要在不使用字符串拼接等投机规避的前提下，使验收检查准确区分底层直连与受控 operation 调用。
- 期望行为: 静态验收只拒绝 `src/services/download.ts` 对 `yt-dlp.js` 的直接导入和可选 `cancel` 声明，同时允许且确认 `metadata_probe` 内的 `operations.fetchVideoMetadata` 调用；既有 20 个下载服务集成测试继续通过。
- 范围边界:
  - 必须: 分别验证无底层导入、无可选 cancel，以及存在固定的受控元数据探测调用。
  - 不能: 不能改动与本 bug 无关的模块，不能删除或绕开 `operations.fetchVideoMetadata`，不能放宽下载服务行为测试。
  - 不做: 不改变直接下载输入、响应、错误码、重试语义或管理器 operations 契约。
- 验收标准:
  1. `npx vitest run test/integration/download-service.test.ts` → 下载服务集成测试全部通过。
  2. `test -z "$(rg -n "from ['\"](?:\.\.?/)*yt-dlp\.js['\"]|cancel\\?" src/services/download.ts)"` → 下载服务无底层直连且 cancel 为异步必需方法。
  3. `rg -n "type: 'metadata_probe'|operations\.fetchVideoMetadata" src/services/download.ts` → 固定探测任务及受控 operation 调用均命中。

## task-15 · 取消下载时阻断后处理成功落库
- 状态: done
- 依赖: task-02, task-03
- 文件范围:
  - src/yt-dlp-task-manager.ts
  - src/download-worker.ts
  - test/unit/yt-dlp-task-manager.test.ts
  - test/integration/download-worker.test.ts
- 关键约束:
  - 不能只在 `DownloadWorker.cancel` 中记录取消，也不能让管理器直接取消与 worker 取消形成两个不可互见的状态源。
  - 不能在取消已请求后继续归档文件或将下载记录写为 `completed`。
- 任务目的: 修复 bugfix-03 描述的问题
- 实现入口: `src/yt-dlp-task-manager.ts:238`（`cancel`）、`src/yt-dlp-task-manager.ts:350`（`#createOperations`）、`src/download-worker.ts:336`（`cancel`）、`src/download-worker.ts:379`（`#run`）、`src/download-worker.ts:619`（后处理取消检查）
- 问题描述原文: review-1 在 src/download-worker.ts:619 发现管理器直接取消只设置 task cancelRequested，DownloadWorker 的后处理检查无法观察该取消；若取消发生在 yt-dlp 完成后的校验或归档阶段，下载仍可能归档并写为 completed，而管理器快照为 canceled。所有取消来源必须共享可观察取消状态，并在校验、归档和成功落库前阻断。
- 期望行为: 无论取消来自 `DownloadWorker.cancel` 还是管理器直接取消，运行中的下载在媒体进程结束后的校验、归档及成功落库边界都能观察同一取消状态；取消任务最终保持管理器快照 `canceled`、下载记录 `canceled`，且不保留归档产物或写入 `completed`。
- 范围边界:
  - 必须: 统一取消可观察状态，并覆盖取消发生在校验、归档和成功落库前的回滚与状态收敛测试。
  - 不能: 不能改动与本 bug 无关的模块，不能新增第二套取消控制器、调度队列或下载状态。
  - 不做: 不改变下载目录布局、进度字段、普通失败映射或管理器并发协议。
- 验收标准:
  1. `npx vitest run test/unit/yt-dlp-task-manager.test.ts test/integration/download-worker.test.ts` → 管理器取消与下载后处理取消、回滚及状态收敛用例全部通过。
  2. `rg -n "cancelRequested|signal\.aborted|throwIfCancel" src/yt-dlp-task-manager.ts src/download-worker.ts` → 管理器取消状态与 worker 后处理取消检查均有明确实现。

## task-16 · 正常停机取消不得上报 runtime 故障
- 状态: done
- 依赖: task-02, task-05, task-06
- 文件范围:
  - src/yt-dlp-task-manager.ts
  - src/routes/channels.ts
  - src/scheduler.ts
  - test/unit/scheduler.test.ts
  - test/integration/channel-notification-api.test.ts
- 关键约束:
  - 不能通过错误消息字符串匹配识别取消，也不能吞掉业务失败、持久化失败或非取消系统异常。
  - 不能让正常停机触发的首次同步或定时检查取消进入 runtime 故障上报。
- 任务目的: 修复 bugfix-04 描述的问题
- 实现入口: `src/yt-dlp-task-manager.ts:101`（`cancellationError`）、`src/yt-dlp-task-manager.ts:238`（`cancel`）、`src/routes/channels.ts:40`（首次同步任务错误边界）、`src/scheduler.ts:148`（定时检查结果分类）
- 问题描述原文: review-1 在 src/routes/channels.ts:41 发现管理器取消以普通 Error 拒绝，首次同步和 scheduler 会把正常停机取消当作系统故障上报，可能让 RunningServer.failure 拒绝并导致非零退出。必须提供可识别的取消错误，并在这些错误边界排除正常取消，同时保留任务和频道业务状态收敛。
- 期望行为: 管理器以稳定、可类型识别的取消错误拒绝任务结果；首次同步与 scheduler 在正常停机取消时不调用 runtime 故障上报，而业务失败、持久化失败和其他系统异常继续沿现有边界上报，任务及频道业务状态仍完整收敛。
- 范围边界:
  - 必须: 为管理器取消错误提供明确识别契约，并在首次同步与定时检查错误分类处仅排除该取消错误。
  - 不能: 不能改动与本 bug 无关的模块，不能使用消息文本、宽松 catch 或静默忽略未知错误。
  - 不做: 不新增频道 `canceled` 业务状态，不改变 scheduler 到期、防重、停止等待或 runtime failure 协议。
- 验收标准:
  1. `npx vitest run test/unit/scheduler.test.ts test/integration/channel-notification-api.test.ts` → 正常取消不报告故障，业务与持久化失败仍按原契约报告。
  2. `rg -n "cancel|cancell" src/yt-dlp-task-manager.ts src/routes/channels.ts src/scheduler.ts` → 可识别取消契约及两个错误边界均有明确处理。

## task-17 · 页面任务测试失败路径必须释放 gate
- 状态: done
- 依赖: task-12
- 文件范围:
  - test/integration/pages.test.ts
- 关键约束:
  - 不能仅在断言成功路径释放 `runningGate` 与 `queuedGate`，也不能删除或弱化现有页面、快照和脱敏断言。
- 任务目的: 修复 bugfix-05 描述的问题
- 实现入口: `test/integration/pages.test.ts:697`（固定任务类型与状态快照用例）、`test/integration/pages.test.ts:794`（gate 释放与任务等待）
- 问题描述原文: review-1 在 test/integration/pages.test.ts:697 发现任务页面用例只在断言成功后释放两个 gate；任一断言失败会让 afterEach 的 taskManager.stop() 永久等待。必须用 try/finally 无条件释放 gate 并等待两个任务 allSettled。
- 期望行为: 固定任务类型与状态快照用例无论断言成功或抛错都释放两个 gate，并等待运行与排队任务全部 settled，使 `afterEach` 的 `taskManager.stop()` 不会永久阻塞，同时保留原断言覆盖范围。
- 范围边界:
  - 必须: 使用 `try/finally` 包围可能失败的断言路径，在 `finally` 中无条件释放两个 gate 并等待两个任务 `Promise.allSettled`。
  - 不能: 不能改动与本 bug 无关的模块，不能以超时、跳过清理或捕获并吞掉断言错误规避挂起。
  - 不做: 不改变生产代码、任务页面契约或测试套件的全局清理顺序。
- 验收标准:
  1. `npx vitest run test/integration/pages.test.ts` → 页面任务快照及其余页面回归测试全部通过且进程正常退出。
  2. `rg -n "try|finally|Promise\.allSettled" test/integration/pages.test.ts` → gate 用例包含无条件清理与任务收敛逻辑。

## task-18 · 收紧下载后处理的取消边界
- 状态: done
- 依赖: task-15
- 文件范围:
  - src/download-worker.ts
  - test/integration/download-worker.test.ts
- 关键约束:
  - 不能依赖错误消息字符串识别取消，不能在 `completed` 落库后留下仍可改写管理器终态的异步清理窗口。
  - 不能改动下载目录布局、普通失败映射或相邻无关功能。
- 任务目的: 修复 bugfix-06 描述的问题；修复 bugfix-07 描述的问题
- 实现入口: `src/download-worker.ts:260`（`tryDownloadThumbnail`）、`src/download-worker.ts:281`（`isCancellationError`）、`src/download-worker.ts:379`（`DownloadWorker.#run`）、`src/download-worker.ts:503`（完成落库与临时目录清理边界）、`src/download-worker.ts:617`（`#throwIfCanceled`）
- 问题描述原文:
  - bugfix-06: review-2 在 src/download-worker.ts:503 发现 completed 落库后仍 await 临时目录清理，任务保持 running 且可被取消，最终可能出现下载记录 completed、管理器 canceled 且归档文件保留。必须在成功落库前完成清理并作最后一次取消检查，在业务终态确定前保留归档回滚信息。
  - bugfix-07: review-2 在 src/download-worker.ts:281 发现 isCancellationError 依赖固定英文 message，可能在取消期间把进程组终止等非固定消息异常当普通缩略图失败吞掉。必须使用任务 signal 或类型化取消契约判断，并覆盖取消期间底层抛出其他错误的负向测试。
- 期望行为: 下载成功路径在临时目录清理完成并通过最后一次取消检查后才写入 `completed`，在此之前保留归档回滚信息；缩略图阶段依据同一任务 signal 或类型化取消契约传播取消，取消期间底层抛出的其他错误不会被误当成可忽略的普通缩略图失败。
- 范围边界:
  - 必须: 覆盖清理期间取消、成功落库前取消、归档回滚，以及取消期间底层非固定消息错误不得被吞掉的负向测试。
  - 不能: 不能改动与本 bug 无关的模块，不能新增第二套取消状态或通过消息文本、宽松 catch 猜测取消。
  - 不做: 不改变下载目录布局、进度字段、下载状态集合、普通缩略图失败可忽略的既有契约或管理器调度协议。
- 验收标准:
  1. `npx vitest run test/integration/download-worker.test.ts` → 下载成功、后处理取消、回滚、缩略图普通失败及取消期间异常用例全部通过。
  2. `test -z "$(rg -n 'error\.message.*yt-dlp download cancelled' src/download-worker.ts)"` → 下载 worker 不再以固定错误消息识别取消。
  3. `rg -n "signal\.aborted|throwIfCanceled|status = 'completed'" src/download-worker.ts` → 同一 signal 的取消检查与成功落库边界均有明确实现。

## task-19 · 取消时保留真实系统故障
- 状态: done
- 依赖: task-15, task-16
- 文件范围:
  - src/yt-dlp-task-manager.ts
  - test/unit/yt-dlp-task-manager.test.ts
  - test/integration/yt-dlp.test.ts
  - test/unit/scheduler.test.ts
  - test/integration/channel-notification-api.test.ts
- 关键约束:
  - 不能仅凭 `cancelRequested` 将执行器随后抛出的任意异常改写为 `canceled`，也不能吞掉进程组终止、持久化、归档、清理或未知系统故障。
  - 不能使用错误消息字符串或宽松异常匹配识别正常取消，不能改动相邻无关功能。
- 任务目的: 修复 bugfix-08 描述的问题；修复 bugfix-11 描述的问题
- 实现入口: `src/yt-dlp-task-manager.ts:114`（`cancellationError`）、`src/yt-dlp-task-manager.ts:238`（`cancel`）、`src/yt-dlp-task-manager.ts:304`（`#startTask` 的执行结果分类）、`src/yt-dlp-task-manager.ts:329`（`#finishTask`）
- 问题描述原文:
  - bugfix-08: review-2 在 src/yt-dlp-task-manager.ts:321 发现 cancelRequested 会把执行器随后抛出的任何持久化、归档、清理或未知系统错误改写为 canceled。只有可类型识别的正常取消结果才能落 canceled；真实系统错误必须保留 failed 终态和原始拒绝并继续上报。
  - bugfix-11: review-2 在 src/yt-dlp-task-manager.ts:321 复现取消期间 process.kill(-pid) 失败后 stop 仍成功且任务为 canceled；进程组终止失败和频道清理持久化失败必须保留 failed 并让 stop 或 runtime 故障边界感知。
- 期望行为: 取消请求后，只有执行成功收敛或抛出可类型识别的正常取消错误时任务进入 `canceled`；进程组终止、频道持久化、归档、清理及未知执行异常进入 `failed`，任务结果保留原始拒绝，并由 `stop()` 或既有 runtime 故障边界感知。
- 范围边界:
  - 必须: 覆盖取消成功、取消期间执行成功、进程组终止失败、频道清理持久化失败和未知系统异常的终态、拒绝值及故障上报。
  - 不能: 不能改动与本 bug 无关的模块，不能用 `cancelRequested` 单独决定拒绝路径终态，不能吞掉或重写真实系统异常。
  - 不做: 不新增任务状态、频道 `canceled` 业务状态、重试、兼容错误类型或新的 runtime 故障通道。
- 验收标准:
  1. `npx vitest run test/unit/yt-dlp-task-manager.test.ts test/integration/yt-dlp.test.ts test/unit/scheduler.test.ts test/integration/channel-notification-api.test.ts` → 正常取消、终止失败、持久化失败及故障上报用例全部通过。
  2. `rg -n "isYtDlpTaskCancellationError|cancelRequested|status.*failed|#finishTask" src/yt-dlp-task-manager.ts` → 类型化取消与失败终态分类均有明确实现。

## task-20 · 保证失败快照原因非空
- 状态: done
- 依赖: task-19
- 文件范围:
  - src/yt-dlp-task-manager.ts
  - test/unit/yt-dlp-task-manager.test.ts
- 关键约束:
  - 不能允许 `failed` 快照的 `failureReason` 为 `''`，也不能暴露脱敏前的原始失败文本。
  - 不能为未知错误格式增加字段别名、递归解析或猜测式 fallback。
- 任务目的: 修复 bugfix-09 描述的问题
- 实现入口: `src/yt-dlp-task-manager.ts:117`（`errorMessage`）、`src/yt-dlp-task-manager.ts:329`（`#finishTask` 的失败原因写入）
- 问题描述原文: review-2 在 src/yt-dlp-task-manager.ts:342 发现执行器以空字符串拒绝或脱敏函数返回空字符串时可产生 failed 且 failureReason 为空，违反固定快照/API 契约。必须规范化并校验为固定非空失败描述。
- 期望行为: 执行器以空字符串拒绝、空消息错误拒绝或脱敏函数返回空字符串时，任务仍进入 `failed`，且快照获得固定、非空、已脱敏的失败描述；其他失败原因沿用既有脱敏结果。
- 范围边界:
  - 必须: 对原始空字符串、空消息 `Error` 和脱敏后空字符串分别覆盖负向测试，并断言 `failureReason` 非空。
  - 不能: 不能改动与本 bug 无关的模块，不能返回原始敏感文本，不能把失败任务改写成其他终态。
  - 不做: 不改变快照字段集合、API 返回结构、脱敏函数契约或非空失败文本的现有格式。
- 验收标准:
  1. `npx vitest run test/unit/yt-dlp-task-manager.test.ts` → 空失败值、空错误消息、脱敏为空及既有脱敏用例全部通过。
  2. `rg -n "failureReason|errorMessage|redactFailureReason" src/yt-dlp-task-manager.ts` → 失败原因规范化与脱敏边界均有明确实现。

## task-21 · 恢复窄桌面任务表格横向可达性
- 状态: done
- 依赖: task-11
- 文件范围:
  - src/styles/main.scss
  - test/integration/pages.test.ts
- 关键约束:
  - 不能通过隐藏、删除或压缩掉固定任务字段解决裁切，也不能改变任务页面的数据与交互契约。
  - 不能改动相邻无关页面样式。
- 任务目的: 修复 bugfix-10 描述的问题
- 实现入口: `src/styles/main.scss:1181`（`.yt-dlp-tasks-table-shell`）、`src/styles/main.scss:1189`（`.yt-dlp-tasks-table`）、`test/integration/pages.test.ts:811`（任务表格响应式样式验收）
- 问题描述原文: review-2 在 src/styles/main.scss:1182 发现自定义 overflow: hidden 覆盖 Bootstrap table-responsive 的横向滚动，略高于移动断点且有侧栏时会裁掉时间与失败原因列。必须保留横向滚动或调整卡片断点，确保固定字段可见。
- 期望行为: 在移动卡片断点以上但可用宽度不足的窄桌面布局中，任务表格可横向滚动查看任务 ID、类型、状态、三个时间字段和失败原因；移动卡片布局及圆角视觉保持现有行为。
- 范围边界:
  - 必须: 保留所有固定列，并以机械样式断言证明表格容器允许横向滚动且移动断点规则仍存在。
  - 不能: 不能改动与本 bug 无关的模块，不能隐藏固定字段、增加新断点交互或依赖页面脚本补偿布局。
  - 不做: 不改变任务 API、页面文案、表格列集合、筛选、分页、轮询或任务操作能力。
- 验收标准:
  1. `npx vitest run test/integration/pages.test.ts` → 任务页面桌面、窄桌面和移动布局契约测试通过。
  2. `rg -n "yt-dlp-tasks-table-shell|overflow-x: auto|yt-dlp-tasks-table" src/styles/main.scss` → 任务表格容器及横向滚动规则均命中。

## task-22 · 通过真实 load 路径验收任务页面
- 状态: done
- 依赖: task-17
- 文件范围:
  - test/integration/pages.test.ts
- 关键约束:
  - 不能在测试中复制生产分类逻辑或绕过 `load()` 直接调用 `renderGroup` 代替核心接线验收。
  - 不能删除或弱化既有页面、快照、固定映射和脱敏断言。
- 任务目的: 修复 bugfix-12 描述的问题
- 实现入口: `test/integration/pages.test.ts:109`（任务页面可控 DOM helper）、`test/integration/pages.test.ts:697`（固定类型与状态快照用例）、`src/public/yt-dlp-tasks.js:81`（被测试执行的 `load` 路径）
- 问题描述原文: review-2 在 test/integration/pages.test.ts:741 发现核心页面用例自行请求 API、复制分类逻辑并直接调用 renderGroup，未执行生产模块的 load、fetch、分类与渲染接线。必须在可控 DOM 中执行完整加载路径并从最终 DOM 断言。
- 期望行为: 核心任务页面用例在可控 DOM 和 fetch 环境中执行生产脚本的完整 `load()` 路径，由真实 fetch、响应校验、固定类型/状态校验、活动/终态分类和渲染接线生成最终 DOM，并仅从最终 DOM 验证标签、计数、空状态和脱敏结果。
- 范围边界:
  - 必须: 可控环境执行真实生产加载入口，并覆盖成功快照、未知 type/status 错误和 fetch/API 失败的最终 DOM 表现。
  - 不能: 不能改动与本 bug 无关的模块，不能复制生产分类条件，不能直接调用 `renderGroup` 作为核心加载路径的替代。
  - 不做: 不引入浏览器端到端框架、自动刷新、轮询、生产测试钩子或新的页面行为。
- 验收标准:
  1. `npx vitest run test/integration/pages.test.ts` → 真实加载接线、最终 DOM、未知契约值和脱敏用例全部通过且正常退出。
  2. `rg -n "fetch|load|final|document|taskPage" test/integration/pages.test.ts` → 可控 DOM 中的生产加载路径测试有明确实现。

## task-23 · 强化唯一底层入口的绕过扫描
- 状态: done
- 依赖: task-12
- 文件范围:
  - test/integration/pages.test.ts
- 关键约束:
  - 不能只匹配静态 `from` 导入，也不能通过改名、字符串拼接或动态加载隐藏底层依赖。
  - 不能误伤管理器中唯一合法的静态直接导入。
- 任务目的: 修复 bugfix-13 描述的问题
- 实现入口: `test/integration/pages.test.ts:158`（`typeScriptFiles`）、`test/integration/pages.test.ts:822`（唯一 yt-dlp 底层入口测试）
- 问题描述原文: review-2 在 test/integration/pages.test.ts:823 发现唯一底层入口检查只匹配静态 from 语法，无法发现 import()、require() 或拼接动态导入。必须按确认契约覆盖并拒绝这些绕过形态，增加负向测试。
- 期望行为: 全部 `src/**/*.ts` 只允许 `src/yt-dlp-task-manager.ts` 使用确认的静态 `from './yt-dlp.js'` 导入；扫描会拒绝其他文件中的静态导入、`import()`、`require()` 以及字符串拼接构造的底层模块加载，并由负向样本证明各绕过形态可被发现。
- 范围边界:
  - 必须: 扫描完整生产 TypeScript 源码，并为静态导入、动态 import、require 和拼接加载提供机械负向测试。
  - 不能: 不能改动与本 bug 无关的模块，不能允许动态加载白名单，不能以重命名或字符串变形规避扫描。
  - 不做: 不引入通用 AST 工具、修改生产导入结构、扫描测试或构建产物、扩大到未确认的其他模块路径。
- 验收标准:
  1. `npx vitest run test/integration/pages.test.ts` → 唯一合法入口及各类绕过负向样本测试全部通过。
  2. `rg -n "importPattern|import\(|require\(|yt-dlp" test/integration/pages.test.ts` → 静态与动态绕过扫描规则及负向样本均有明确实现。

## task-24 · 统一底层与管理器的类型化取消契约
- 状态: done
- 依赖: task-19
- 文件范围:
  - src/yt-dlp-task-cancellation.ts (新建)
  - src/yt-dlp.ts
  - src/yt-dlp-task-manager.ts
  - test/integration/yt-dlp.test.ts
- 关键约束:
  - 不能用错误消息字符串或仅凭 `signal.aborted` 识别正常取消，不能把进程组终止失败或启动失败转换为取消。
  - 不能改动与本 bug 无关的模块，不能造成 `src/yt-dlp.ts` 与管理器之间的循环依赖。
- 任务目的: 修复 bugfix-18 描述的问题；修复 bugfix-21 描述的问题；修复 bugfix-23 描述的问题；修复 bugfix-26 描述的问题
- 实现入口: `src/yt-dlp.ts:239`（`runProcess` 的 close 结果分类）、`src/yt-dlp-task-manager.ts:105`（现有取消错误契约）、`test/integration/yt-dlp.test.ts:51`（进程树退出断言）
- 问题描述原文:
  - bugfix-18: review-3 在 src/server.ts:290 发现 yt-dlp 正常中止在底层被重构为普通 Error，运行中下载停机使 manager.stop 拒绝。必须跨进程边界保留可识别取消类型，真实 kill 等错误不转换。
  - bugfix-21: review-3 在 src/yt-dlp.ts:239 发现真实 operation 取消返回普通 Error，manager.cancel 将任务标为 failed。底层固定协议必须返回管理器可识别的共享取消类型，并用真实 operation 集成测试证明。
  - bugfix-23: review-3 在 src/yt-dlp.ts:239 发现 signal 已取消且 executable ENOENT 时先返回取消。spawnError 必须优先保留并增加预取消叠加启动失败测试。
  - bugfix-26: review-3 在 test/integration/yt-dlp.test.ts:51 发现 close 后立即 kill(pid,0) 会因僵尸回收时序随机失败。应有界轮询 ESRCH，超时才失败。
- 期望行为: yt-dlp 收到取消并正常完成进程组终止时拒绝共享的类型化取消错误，管理器据此将任务收敛为 `canceled`；终止失败与 ENOENT 启动失败保留原失败，其中预取消与启动失败叠加时启动失败优先；进程树测试在有界时间内轮询至 PID 返回 ESRCH。
- 范围边界:
  - 必须: 共享取消类型可被底层和管理器直接引用，真实 operation 取消、启动失败优先级和 PID 有界消失均有集成测试。
  - 不能: 不能改动与本 bug 无关的模块，不能把 kill、spawn 或未知异常包装成取消，不能使用固定消息文本判断取消。
  - 不做: 不改变 yt-dlp 参数、超时、输出解析、进程组终止协议或管理器状态集合。
- 验收标准:
  1. `npx vitest run test/integration/yt-dlp.test.ts` → 真实 operation 的正常取消、启动失败优先级和进程树退出用例全部通过。
  2. `rg -n "YtDlpTaskCancellationError|isYtDlpTaskCancellationError" src/yt-dlp-task-cancellation.ts src/yt-dlp.ts src/yt-dlp-task-manager.ts` → 共享取消类型及两层使用均命中。

## task-25 · 按错误类型收紧下载 worker 失败边界
- 状态: done
- 依赖: task-24
- 文件范围:
  - src/download-worker.ts
  - src/yt-dlp-task-cancellation.ts
  - test/integration/download-worker.test.ts
- 关键约束:
  - 不能仅凭 `signal.aborted` 将任意异常写成 `canceled`，不能吞掉缩略图目录清理、kill、回滚、清理或持久化故障。
  - 不能改动与本 bug 无关的模块，不能改变普通缩略图下载失败可忽略的既有契约。
- 任务目的: 修复 bugfix-14 描述的问题；修复 bugfix-15 描述的问题；修复 bugfix-16 描述的问题
- 实现入口: `src/download-worker.ts:252`（`tryDownloadThumbnail`）、`src/download-worker.ts:281`（当前普通取消错误）、`src/download-worker.ts:375`（`DownloadWorker.#run`）、`src/download-worker.ts:530`（失败状态收敛）、`src/download-worker.ts:634`（`#throwIfCanceled`）
- 问题描述原文:
  - bugfix-14: review-3 在 src/download-worker.ts:281 发现 worker 主动取消及底层正常中止仍抛普通 Error，导致正常取消被管理器记为 failed。必须统一为 YtDlpTaskCancellationError，真实终止错误保持原异常。
  - bugfix-15: review-3 在 src/download-worker.ts:530 发现 catch 仅凭 signal.aborted 写 canceled，会把 kill、回滚、清理和持久化故障伪装为取消。只有类型化正常取消写 canceled，其余写 failed 并上报。
  - bugfix-16: review-3 在 src/download-worker.ts:276 发现 finally 无条件吞掉缩略图目录 rm 异常。普通缩略图下载失败仍可忽略，但清理失败必须保留 rejection 并进入系统故障边界。
- 期望行为: worker 主动取消和底层正常取消统一传播共享类型，下载记录仅在该类型下写为 `canceled`；其他异常写为 `failed` 并沿既有故障边界上报；缩略图普通下载失败仍可忽略，但缩略图目录清理失败保留 rejection。
- 范围边界:
  - 必须: 覆盖类型化正常取消、取消期间真实故障、缩略图普通失败与目录清理失败的任务快照、下载记录和故障上报。
  - 不能: 不能改动与本 bug 无关的模块，不能通过错误消息、宽松 catch 或 signal 状态猜测错误类型，不能吞掉清理错误。
  - 不做: 不改变下载目录布局、进度字段、状态集合、归档协议或调度并发协议。
- 验收标准:
  1. `npx vitest run test/integration/download-worker.test.ts` → worker 取消、真实故障和缩略图清理边界用例全部通过。
  2. `rg -n "YtDlpTaskCancellationError|isYtDlpTaskCancellationError|failedStatus" src/download-worker.ts` → 类型化取消创建与状态分类均有明确实现。
  3. `test -z "$(rg -n "rm\(thumbnailDirectory.*catch" src/download-worker.ts)"` → 缩略图目录清理不再无条件吞错。

## task-26 · 让排队媒体取消持久化业务终态
- 状态: failed
- 依赖: task-25
- 文件范围:
  - src/download-worker.ts
  - src/server.ts
  - test/integration/download-worker.test.ts
  - test/integration/server-lifecycle.test.ts
- 关键约束:
  - 不能让排队任务在未进入 `DownloadWorker.#run` 时残留 `pending`，不能为此启动排队任务或新增第二套调度状态。
  - 不能改动与本 bug 无关的模块，不能吞掉排队取消终态的持久化失败。
- 任务目的: 修复 bugfix-17 描述的问题；修复 bugfix-20 描述的问题
- 实现入口: `src/download-worker.ts:309`（`enqueue` 的 task result 收敛）、`src/server.ts:242`（正常停机顺序）、`src/server.ts:290`（管理器停机屏障）
- 问题描述原文:
  - bugfix-17: review-3 在 src/download-worker.ts:321 发现 execute 前取消的排队媒体任务不会运行 #run，数据库记录残留 pending。worker 观察到类型化排队取消时必须原子更新 pending 为 canceled，持久化失败上报。
  - bugfix-20: review-3 在 src/server.ts:290 发现 manager.stop 直接取消排队媒体任务后数据库仍为 pending。停机后排队和运行下载都必须收敛为 canceled。
- 期望行为: worker 观察到排队媒体任务以类型化取消结束时，将对应下载记录从 `pending` 原子更新为 `canceled`；正常服务停机后排队与运行下载都收敛为 `canceled`，持久化失败继续进入 worker/runtime 故障边界。
- 范围边界:
  - 必须: 覆盖直接取消和 manager stop 两种排队取消来源，以及取消终态持久化失败上报。
  - 不能: 不能改动与本 bug 无关的模块，不能启动已取消的排队任务，不能新增下载状态、控制器或队列。
  - 不做: 不改变运行中下载取消协议、FIFO、下载并发、重启恢复或数据库 schema。
- 验收标准:
  1. `npx vitest run test/integration/download-worker.test.ts test/integration/server-lifecycle.test.ts` → 排队/运行取消、停机收敛和持久化失败用例全部通过。
  2. `rg -n "status = 'canceled'|status = \?" src/download-worker.ts` → 排队取消的原子业务状态更新有明确实现。

## task-27 · 频道流程保留类型化取消身份
- 状态: done
- 依赖: task-24
- 文件范围:
  - src/services/channel.ts
  - src/yt-dlp-task-cancellation.ts
  - test/integration/channel-notification-api.test.ts
- 关键约束:
  - 不能把类型化取消重写为 `CHANNEL_FETCH_FAILED` 或元数据业务错误，不能吞掉记录频道失败状态时的持久化错误。
  - 不能改动与本 bug 无关的模块，不能用错误消息字符串识别取消。
- 任务目的: 修复 bugfix-19 描述的问题；修复 bugfix-24 描述的问题
- 实现入口: `src/services/channel.ts:973`、`src/services/channel.ts:1003`（首次同步抓取与元数据边界）、`src/services/channel.ts:1321`、`src/services/channel.ts:1348`（定时检查抓取与元数据边界）、`test/integration/channel-notification-api.test.ts:439`（停机取消断言）
- 问题描述原文:
  - bugfix-19: review-3 在 src/services/channel.ts:981 发现频道抓取和元数据 catch 将取消重写为 BusinessError，导致 runtime/scheduler 排除分支失效。记录既有频道失败状态后应重抛原取消类型；记录失败则抛 PERSISTENCE_ERROR。
  - bugfix-24: review-3 在 test/integration/channel-notification-api.test.ts:439 发现测试期待 stop 以 CHANNEL_FETCH_FAILED 拒绝并将任务记 failed，与正常取消契约冲突。应断言 stop 成功、快照 canceled 且使用类型判断。
- 期望行为: 首次同步与定时检查遇到共享类型化取消时，先按既有契约记录频道检查失败，再重抛原取消类型，使正常 stop 成功且任务快照为 `canceled`；若记录失败则抛 `PERSISTENCE_ERROR`，其他业务和系统异常保持原分类。
- 范围边界:
  - 必须: 抓取与逐项元数据两个 catch 边界均保留取消身份，并测试正常停机与记录失败两条路径。
  - 不能: 不能改动与本 bug 无关的模块，不能新增频道 `canceled` 状态，不能静默忽略持久化失败或未知错误。
  - 不做: 不改变频道响应时序、scheduler 防重、检查记录结构、通知事务或 runtime failure 协议。
- 验收标准:
  1. `npx vitest run test/integration/channel-notification-api.test.ts` → 正常停机取消及持久化失败边界用例全部通过。
  2. `rg -n "isYtDlpTaskCancellationError|PERSISTENCE_ERROR|CHANNEL_FETCH_FAILED" src/services/channel.ts` → 类型化取消和既有错误边界均有明确处理。

## task-28 · stop 等待全部取消任务收敛
- 状态: pending
- 依赖: task-24
- 文件范围:
  - src/yt-dlp-task-manager.ts
  - test/unit/yt-dlp-task-manager.test.ts
- 关键约束:
  - 不能在首个取消失败时提前结束 `stop()`，不能吞掉任何任务的取消失败。
  - 不能改动与本 bug 无关的模块，不能改变幂等 stop promise、终态不可逆或停止后拒绝提交的契约。
- 任务目的: 修复 bugfix-22 描述的问题
- 实现入口: `src/yt-dlp-task-manager.ts:279`（`stop` 的取消等待与错误聚合）
- 问题描述原文: review-3 在 src/yt-dlp-task-manager.ts:279 发现 Promise.all 在首个取消失败后立即拒绝，其他任务仍可能 running。stop 必须先等待全部 cancel settled，再聚合抛错。
- 期望行为: `stop()` 在取消任务出现一个或多个失败时仍等待所有活动任务 settled，随后成功返回或以包含全部取消失败的错误拒绝；返回时不存在 `queued` 或 `running` 任务。
- 范围边界:
  - 必须: 覆盖首个取消失败而其他任务延迟收敛、多个取消失败和无失败三种情况。
  - 不能: 不能改动与本 bug 无关的模块，不能提前 reject、吞错或修改任务原始终态。
  - 不做: 不改变调度并发、取消类型、快照字段、错误脱敏或任务历史保留协议。
- 验收标准:
  1. `npx vitest run test/unit/yt-dlp-task-manager.test.ts` → stop 全量等待与失败聚合用例全部通过。
  2. `rg -n "allSettled|AggregateError|stop" src/yt-dlp-task-manager.ts` → 全量等待及错误聚合实现均命中。

## task-29 · 修正唯一入口扫描与页面错误测试契约
- 状态: pending
- 依赖: task-23
- 文件范围:
  - test/integration/pages.test.ts
- 关键约束:
  - 不能只扫描原始字面量文本，不能复制一个不解析转义、模板插值或变量拼接的猜测式兼容器。
  - 不能改动与本 bug 无关的模块，不能在页面错误测试中发明未定义的状态码或错误码。
- 任务目的: 修复 bugfix-25 描述的问题；修复 bugfix-27 描述的问题
- 实现入口: `test/integration/pages.test.ts:158`（`typeScriptFiles`）、`test/integration/pages.test.ts:169`（`lowLevelYtDlpReferences`）、`test/integration/pages.test.ts:823`（唯一入口与页面 API 失败测试）
- 问题描述原文:
  - bugfix-25: review-3 在 test/integration/pages.test.ts:169 发现扫描未解码转义字面量，也不分析模板插值和变量拼接。必须使用受限常量求值或 TypeScript parser 拒绝这些绕过方式。
  - bugfix-27: review-3 在 test/integration/pages.test.ts:823 发现页面测试伪造 503/TASK_SNAPSHOT_FAILED。必须改为固定 500/PERSISTENCE_ERROR 并断言最终 DOM。
- 期望行为: 唯一入口扫描通过受限常量求值或 TypeScript parser 解析确认范围内的字符串表达式，拒绝转义字面量、模板插值和变量拼接形成的 `yt-dlp.js` 动态路径；页面 API 失败测试使用固定 `500/PERSISTENCE_ERROR` 响应并从最终 DOM 断言。
- 范围边界:
  - 必须: 为转义字面量、模板插值和变量拼接分别提供负向样本，并保留合法静态导入白名单。
  - 不能: 不能改动与本 bug 无关的模块，不能执行待扫描源码，不能允许动态加载白名单或使用宽松正则漏掉已确认绕过形态。
  - 不做: 不扫描测试/构建产物，不修改生产导入结构、页面行为、API 错误契约或引入端到端浏览器框架。
- 验收标准:
  1. `npx vitest run test/integration/pages.test.ts` → 动态路径绕过负向样本及固定 API 错误 DOM 用例全部通过。
  2. `rg -n "PERSISTENCE_ERROR|500|TemplateExpression|BinaryExpression|yt-dlp" test/integration/pages.test.ts` → 固定错误契约与受限表达式解析测试均有明确实现。
