# VidHarbor v0.2 技术设计

## 1. 整体方案概述

新增进程内单例 `YtDlpTaskManager` 作为业务代码调用 yt-dlp 的唯一入口：业务服务只提交固定的五类任务和任务执行函数，执行函数只能通过管理器提供的受控 operations 调用底层 `src/yt-dlp.ts`；管理器为每个任务建立单调递增 ID 和 `queued -> running -> succeeded|failed|canceled` 状态机，以独立 FIFO 下载队列落实 `download_concurrency`，其余四类任务在提交后的调度轮次直接启动。管理器为运行任务持有统一的 `AbortController`，取消与停机均通过同一路径终止完整进程组并等待任务收敛；终态只保留脱敏后的轻量内存快照，供新增只读 API 和独立状态页面展示。该方案复用现有业务服务、下载落盘逻辑、频道状态和重启恢复契约，不新增数据库、外部依赖、重试、优先级或持久化任务系统。

## 2. 涉及模块与改动范围

- **新建 `src/yt-dlp-task-manager.ts`**
  - 定义唯一且封闭的任务类型 `media_download`、`metadata_probe`、`channel_initial_sync`、`channel_manual_check`、`channel_scheduled_check`，以及唯一状态集合 `queued`、`running`、`succeeded`、`failed`、`canceled`。
  - 实现任务提交、下载 FIFO 调度、非下载任务立即调度、不可逆终态转换、快照、按任务 ID 取消及幂等 `stop()`。
  - 管理器构造时接收 yt-dlp 可执行文件路径、启动时读取的 `download_concurrency` 和现有脱敏函数；不读取业务表、不解释业务结果。
  - `submit<T>` 返回 `{ id, result }` 句柄。任务执行函数取得由管理器绑定当前 `AbortSignal` 的 operations（频道列表抓取、单项元数据探测、媒体下载、缩略图下载），不能自行传入可执行文件或取消信号。运行任务的 controller、执行函数和监听器在收敛后释放，任务集合仅保留只读展示字段。

- **修改 `src/yt-dlp.ts`**
  - `FetchOptions` 增加由管理器注入的 `signal`，使频道抓取和元数据探测与下载一样可被统一取消。
  - 所有公开执行函数继续只负责固定参数数组、无 shell 子进程、超时/无输出超时、进程组终止、stdout/stderr 处理和结果解析；不引入任务类型、状态、队列或并发配置。
  - 保留现有进程组终止和凭据脱敏逻辑；管理器成为生产代码中唯一导入这些执行函数的模块。

- **修改 `src/download-worker.ts`**
  - 保留下载记录状态迁移、临时目录、进度持久化、文件校验/归档/回滚和可选缩略图等业务执行职责。
  - 删除自有 FIFO、并发计数、活动 `AbortController`、停止调度逻辑以及对 `src/yt-dlp.ts` 的直接导入；`enqueue` 改为向管理器提交 `media_download`，并维护 `downloadId -> taskId` 的活动映射供现有取消入口使用。
  - 主媒体与可选缩略图都通过同一个媒体任务的 operations 执行，共享同一取消信号；缩略图失败仍按现有可选行为处理，媒体任务的下载名额覆盖整个现有下载执行边界。
  - 排队取消只移除管理器任务；运行取消等待进程退出。下载业务记录仍由现有下载服务/worker 按 `canceled` 契约写入，业务持久化边界失败仍进入现有运行时故障上报。

- **修改 `src/services/download.ts`**
  - 将元数据探测从直接调用 `fetchVideoMetadata` 改为提交 `metadata_probe` 并等待结果，再按原契约校验元数据、写下载记录和入下载队列。
  - `DownloadQueue.cancel` 改为异步且必需，`cancelDownload` 在现有业务状态成功改为 `canceled` 后等待管理器取消完成；创建、重试、错误码和响应数据不变。

- **修改 `src/services/channel.ts`**
  - 删除对 `src/yt-dlp.ts` 的直接导入以及可执行路径参数，频道抓取和逐项元数据探测统一使用当前任务的 operations。
  - 首次同步在现有校验及 `syncing`/检查记录落库后提交 `channel_initial_sync`；现有 202 接受响应不变，任务失败继续由现有业务边界更新频道和检查记录。
  - 将当前检查入口收紧为固定的手动检查和定时检查两个包装入口，分别提交 `channel_manual_check` 与 `channel_scheduled_check`，共享现有检查准备、数据解释和持久化实现，避免调用方传入任意任务类型。
  - 一次频道任务内发生的频道列表抓取和逐视频元数据探测属于同一个管理器任务，避免把一个业务检查拆成多个界面任务，同时保证其所有实际子进程都受同一信号控制。

- **修改 `src/routes/downloads.ts`、`src/routes/channels.ts`**
  - 注入同一个任务管理器，移除 yt-dlp 可执行路径透传。
  - 保持既有下载创建/取消/重试、频道首次同步和手动检查的 HTTP 路径、请求体、成功响应及业务错误码不变；下载取消等待统一取消完成后仍返回 204。

- **修改 `src/scheduler.ts`**
  - 保留到期计算和同频道防重；回调固定调用定时检查包装入口，不持有进程和取消控制器。
  - `stop()` 仍先停计时器并等待已派发检查，但其等待对象现在最终由任务管理器取消并收敛。

- **修改 `src/runtime.ts`**
  - 移除首次同步任务集合及其停机等待职责，避免与管理器形成第二套任务生命周期。
  - 保留运行时故障上报和下载 SSE 连接管理；首次同步的后台 promise 只在此边界区分已记录的业务失败与需要上报的系统失败。

- **修改 `src/server.ts`**
  - 启动时读取一次现有 `download_concurrency`，创建唯一任务管理器，再将同一实例注入下载 worker、频道服务、scheduler 和 API router；保持现有“配置变更重启后生效”的并发语义。
  - 停机先停止 scheduler 继续派发并同步调用管理器 `stop()`，使其立即拒绝新任务、取消排队/运行任务；随后关闭 HTTP/SSE，并等待 scheduler、管理器及下载业务收尾完成，最后关闭数据库。
  - 启动失败清理也调用同一个幂等 `stop()`；移除对下载 worker 私有停止队列的依赖。

- **修改 `src/app.ts`，新建 `src/routes/yt-dlp-tasks.ts`**
  - 将管理器注入 API 组合根并挂载只读任务快照路由。
  - 不提供通用任务创建、重试或取消 HTTP 接口；本版唯一用户取消入口仍是既有下载取消 API。

- **修改 `src/routes/pages.ts`、`src/views/partials/header.ejs`，新建 `src/views/yt-dlp-tasks.ejs`、`src/public/yt-dlp-tasks.js`**
  - 新增 `/yt-dlp-tasks` 页面和主导航入口。
  - 页面加载只读快照，按活动状态与终态展示任务 ID、五类任务的固定中文标签、状态、时间和失败原因；刷新页面即可取得最新快照，不新增筛选、搜索、分页、排序、自动轮询或取消按钮。

- **修改 `src/styles/main.scss`**
  - 增加任务状态表格、状态标记、空状态以及移动端换行样式，复用现有 Bootstrap 和页面壳层。

- **新建 `test/unit/yt-dlp-task-manager.test.ts`**
  - 覆盖完整状态转换、终态不可改写、下载 FIFO/并发上限、四类非下载任务不占下载额度、无优先级、排队/运行取消、拒绝未知类型与调度字段、幂等停止及停止后拒绝提交。

- **修改 `test/integration/yt-dlp.test.ts`、`test/fixtures/fake-yt-dlp.mjs`**
  - 补充抓取类任务取消、完整进程组退出及输出解析失败分类所需的可控 fixture，继续验证无 shell 参数和脱敏行为。

- **修改 `test/integration/download-worker.test.ts`、`test/integration/download-service.test.ts`、`test/integration/download-api.test.ts`**
  - 将构造方式切换到统一管理器，保留现有下载限流、进度、落盘、失败、取消、重试和文件操作回归；增加元数据探测与媒体/缩略图均经过管理器、排队取消不启动进程的断言。

- **修改 `test/integration/channel-initial-sync.test.ts`、`test/integration/channel-scheduled-check.test.ts`、`test/integration/channel-notification-api.test.ts`**
  - 注入统一管理器并断言首次同步、手动检查、定时检查的固定任务类型；保留业务状态、检查结果、通知和错误码回归。

- **修改 `test/unit/runtime.test.ts`、`test/unit/scheduler.test.ts`、`test/integration/server-lifecycle.test.ts`、`test/integration/restart-recovery.test.ts`**
  - 更新职责边界与关闭顺序测试，覆盖停止时拒绝提交、取消所有活动任务、等待子进程/业务回调收敛、重复停止以及既有重启恢复。

- **修改 `test/integration/pages.test.ts`，新建 `test/integration/yt-dlp-tasks-api.test.ts`**
  - 覆盖页面和导航、五类标签、五种状态、三种终态、刷新读取同一快照、响应字段、失败原因脱敏，以及不提供非下载取消入口。

- **删除：无。**

## 3. 数据设计

不涉及，跳过。

## 4. 接口设计

### 4.1 获取 yt-dlp 任务快照

- **路径 / 方法**：`GET /api/yt-dlp/tasks`
- **请求**：无路径参数、无查询参数、无请求体。
- **鉴权要求**：项目当前没有登录鉴权；沿用现有 `/api` 中间件。该接口只读，同源校验仍仅作用于写方法。
- **成功响应**：`200 application/json`。`tasks` 是管理器同一时刻复制出的只读快照，按任务 ID（即提交顺序）升序返回；前端不从下载记录或频道记录推导状态。

```json
{
  "tasks": [
    {
      "id": 17,
      "type": "media_download",
      "status": "running",
      "createdAt": "2026-07-19T12:00:00.000Z",
      "startedAt": "2026-07-19T12:00:00.010Z",
      "finishedAt": null,
      "failureReason": null
    },
    {
      "id": 18,
      "type": "channel_scheduled_check",
      "status": "failed",
      "createdAt": "2026-07-19T12:01:00.000Z",
      "startedAt": "2026-07-19T12:01:00.001Z",
      "finishedAt": "2026-07-19T12:01:02.000Z",
      "failureReason": "yt-dlp exited with exit code 1: request failed via http://***:***@proxy.example:8080"
    }
  ]
}
```

- **字段约束**：
  - `id`：本进程内从 1 开始单调递增的安全整数，服务重启后重新计数。
  - `type`：只能是五个固定值之一；不接受别名。
  - `status`：只能是 `queued`、`running`、`succeeded`、`failed`、`canceled`。
  - `createdAt` 必填；`startedAt` 仅在任务实际启动后非空；`finishedAt` 仅终态非空；`failureReason` 仅 `failed` 时为脱敏后的非空字符串，其余状态为 `null`。
- **错误码**：无新增业务错误码。不可预期的服务内部错误沿用全局 `500`：

```json
{
  "error": {
    "code": "PERSISTENCE_ERROR",
    "message": "internal server error"
  }
}
```

### 4.2 既有接口兼容

以下接口的路径、方法、请求/响应结构、鉴权和业务错误码不变，仅内部改为提交统一任务：

- `POST /api/downloads/direct`：先等待 `metadata_probe`，成功后创建下载记录并提交 `media_download`，仍返回 202 和 `{ "download": ... }`。
- `POST /api/downloads/channel`：创建记录后提交一个或多个 `media_download`，仍返回 202 和 `{ "downloads": [...] }`。
- `POST /api/downloads/:id/cancel`：更新既有下载取消字段并等待管理器取消，仍返回 204。
- `POST /api/downloads/:id/retry`：新一轮媒体执行生成新任务，仍返回 202 空响应。
- `POST /api/channels/:id/initial-sync`：提交 `channel_initial_sync`，仍返回 202 和 `{ "accepted": true }`。
- `POST /api/channels/:id/check`：提交 `channel_manual_check` 并沿用当前完成后返回检查结果的行为，仍返回 202 和既有结果结构。

不新增 `POST /api/yt-dlp/tasks`、通用重试接口或 `DELETE/POST /api/yt-dlp/tasks/:id/cancel`。

## 5. 关键技术决策

### 5.1 进程内管理器，而非数据库任务表

PRD 明确要求统一当前执行状态，但未要求任务历史跨重启保存；现有下载、频道与检查表已经是业务事实来源，并有既定重启恢复规则。新增持久化任务表会引入双写一致性、迁移、恢复和历史清理契约，因此本版只在当前进程保留管理器快照：刷新可见，重启清空，业务记录仍按原规则恢复。

### 5.2 一个业务操作对应一个管理器任务，而非一个子进程对应一个任务

频道同步/检查可能先抓频道列表，再逐项探测元数据；媒体下载还可能追加缩略图进程。把每个子进程拆成独立任务会让界面无法表达用户触发的一次操作，也会割裂取消边界。管理器因此为任务提供绑定同一 `AbortSignal` 的 operations，一个任务可顺序启动其当前业务所需的多个 yt-dlp 子进程；所有子进程仍只能由管理器 operations 启动，任一未被业务契约允许忽略的执行或解析失败都会使该任务进入 `failed`。

### 5.3 管理器调度执行函数，而不接管业务持久化

下载文件校验/归档、下载记录迁移、频道元数据解释和频道检查事务继续留在原模块。管理器只控制“何时执行、用什么任务类型执行、如何取消、状态如何收敛”，并提供底层 yt-dlp operations。这样既能让输出处理失败进入统一任务终态，又不会把业务表、业务错误码或平台规则塞进 `src/yt-dlp.ts` 或调度器。

### 5.4 单一下载队列与独立非下载调度

只有 `media_download` 进入 FIFO 队列并占用启动时固定读取的 `download_concurrency`；每次媒体任务终止后立即按提交顺序补位。其他四类任务在提交后的微任务调度点从可观察的 `queued` 转为 `running`，不检查或修改下载活动数。管理器不接受 priority、pool、weight、dedupe、retry 等调度字段，未知任务类型或额外调度格式直接抛错。

### 5.5 取消是状态机操作，不是业务模块杀进程

`cancel(id)` 对 `queued` 任务先移出下载队列并直接固定为 `canceled`，保证执行函数永不被调用；对 `running` 任务只触发其 controller，一直等待底层 `close` 和执行函数清理结束后才固定为 `canceled`。终态转换使用单一内部方法并拒绝二次转换；任务正常完成与取消竞争时，以首次合法进入的终态为准。业务模块只保存 task ID，不保存 controller、ChildProcess 或 PID。

### 5.6 停机以管理器为唯一 yt-dlp 收尾屏障

`stop()` 首次调用原子地设置 stopping，之后提交立即失败；它清空并取消排队任务、同时 abort 全部运行任务，再等待全部任务 promise 收敛。后续调用返回同一个 promise。server 在数据库关闭前同时等待 scheduler 已派发检查、管理器和下载业务清理，从而保证任务回调不会访问已关闭的数据库，也不会在停止后启动新进程。

### 5.7 快照只暴露固定展示契约

快照不包含 URL、代理地址、执行参数、业务 payload、返回值、controller 或进程信息。失败文本在写入终态快照前复用现有脱敏规则，API 只复制已经脱敏的字符串。页面只翻译五个固定 type 和五个固定 status；遇到契约外值视为前端错误，不做别名或兜底映射。

### 5.8 不可逾越的边界

- 生产代码中只有 `src/yt-dlp-task-manager.ts` 可以导入 `src/yt-dlp.ts` 的执行函数；测试可直接测试底层协议。
- `src/yt-dlp.ts` 不读取数据库或 `download_concurrency`，不识别任务类型，不保存状态。
- 管理器不修改下载、频道、视频、通知或检查记录，不实现业务去重。
- 不新增任务优先级、自动重试、自动续跑、断点续传、全局并发上限或非下载取消 UI。
- 不接受未定义的任务类型、状态、字段别名或调度选项；缺少必需输入立即失败。

## 6. 风险与注意事项

- **任务与业务状态不是同一状态机**：管理器的 `succeeded` 只表示该任务执行函数完成；下载 `completed`、频道同步状态和检查结果仍由现有事务写入。实现时必须保证业务终态落库发生在任务 promise 成功返回之前，避免管理器先显示成功而业务记录仍处于活动状态。
- **停止时的业务状态兼容**：运行中的下载沿用现有 `canceled` 写入；尚未启动的下载记录仍按现有重启恢复契约处理为 `interrupted`，不能为了统一任务状态擅自增加下载状态。频道表没有 `canceled` 业务状态，停机取消仍由现有失败/重启恢复边界收敛，但管理器任务显示 `canceled`。
- **取消与完成竞争**：必须在 manager 内串行决定终态，并在底层进程 `close` 前保持 `running`；不能在发出 SIGKILL 时提前展示 `canceled`。下载取消 API 也必须等待该边界，防止响应返回后仍有派生进程。
- **完整进程组终止依赖 POSIX detached 进程组语义**：现有 `process.kill(-pid, 'SIGKILL')` 必须保留，并继续用会派生子进程的 fixture 验证；单杀父进程不是可接受降级。
- **非下载任务无并发上限是明确契约**：大量频道同时到期会同时启动任务，不能暗加 semaphore 或复用下载额度。scheduler 的同频道防重仍需保留，以免同一频道重复派发。
- **进程内终态历史会随进程运行时间增长**：PRD 未给历史保留期限、分页或清理规则，本版不得自行裁剪；快照必须只留轻量字段并释放执行引用。若真实运行证明历史量造成问题，应另立需求确定持久化或清理契约。
- **失败原因只脱敏一次后保存**：所有进入快照的异常路径，包括启动失败、退出码、超时、解析失败、业务输出处理失败和进程组终止异常，都必须经过现有凭据脱敏；测试需使用代理凭据原文断言响应和 DOM 均不泄露。
- **可选缩略图的既有语义必须保留**：缩略图失败目前不使媒体下载失败；重构为 operations 后不能因管理器统一状态而改变这一已承载行为，但取消信号不能被该 catch 吞掉，取消后必须阻止归档和成功落库。
- **系统级故障与单任务失败要分开**：yt-dlp/解析/业务校验失败只终止当前任务并让队列继续；只有管理器无法维护内部状态或业务持久化边界失效才进入现有运行时故障上报，不能因为普通任务失败停止独立任务。
- **构造与测试注入必须保持单例事实**：`createApiRouter` 的测试默认值不能隐式再创建第二个 manager。生产组合根和测试都应显式构造并共享实例，静态导入检查与集成并发测试共同证明不存在绕行路径。
- **既有接口时序不能误改**：首次同步继续快速返回接受结果，手动检查继续沿用当前等待完成后响应的行为，元数据探测仍发生在直下载记录创建前；统一管理器不是把所有接口强制改成 fire-and-forget 的理由。
