## 整体评价

**结论**：needs-fix

14 条 finding 均获 worker 认可，且不修复会导致取消状态错误、真实故障被掩盖、停机竞态、数据状态不一致或验收测试失真。上述问题均具有实质影响，当前不建议合入。

---

## 需求覆盖度

| Task | 标题 | 状态 |
|------|------|------|
| N/A | 未提供完整 task 信息 | N/A |

---

## 问题列表

### [blocker] 正常取消未使用管理器认可的类型化取消错误
- **位置**: `src/download-worker.ts:281`
- **问题**: worker 新增的 cancellationError() 返回普通 Error，#throwIfCanceled() 因而把管理器发起的正常取消重新抛成非类型化异常；同时 operations.downloadMedia/downloadThumbnail 的正常中止异常也未经类型化转换直接作为 taskFailure 抛回。YtDlpTaskManager 只把 YtDlpTaskCancellationError 判为 canceled，所以正常运行中取消会被任务管理器记为 failed，cancel() 还会以原异常拒绝。定向运行 download-worker 测试已使正常取消及 validation/archive/completion 取消用例失败，并产生未处理拒绝。
- **建议**: 让底层正常中止与 worker 的主动取消检查统一抛出同一个 YtDlpTaskCancellationError（例如在确认进程组已正常收敛后传播 signal.reason），不要依赖错误消息；真实终止错误仍保留原异常。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会使用户取消和正常停机被记录为 failed，并导致 cancel()/stop() 拒绝，属于任务状态与停机流程的实质功能错误。）

### [blocker] 仅凭 signal.aborted 将真实系统故障持久化为 canceled
- **位置**: `src/download-worker.ts:530`
- **问题**: catch 分支使用 operations.signal.aborted 决定下载记录状态，因此只要取消请求已经发生，进程组 kill 失败、回滚失败或清理失败等非取消异常也会写成 canceled。新增的“thumbnail termination exploded”测试实际走到该路径：下载记录被写为 canceled，而管理器正确把非类型化终止错误判为 failed；该异常又不是 DownloadWorkerBoundaryError，handle.result 的拒绝回调不会上报 worker.failure。
- **建议**: 只在 failure 是稳定的类型化正常取消错误时写 canceled；所有 kill、持久化、归档、回滚、清理和未知异常写 failed，并按系统故障边界上报，不能以 signal.aborted 代替错误分类。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会把真实系统故障伪装成用户取消，并造成管理器与下载记录状态矛盾及故障漏报。）

### [blocker] 缩略图目录清理错误被无条件吞掉
- **位置**: `src/download-worker.ts:276`
- **问题**: tryDownloadThumbnail() 的 finally 对 rm(thumbnailDirectory) 无条件 catch 后返回 undefined。契约只允许既有的可选缩略图普通下载失败静默，真实清理错误必须使任务 failed 并上报；这里即使缩略图操作成功或任务正处于取消流程也会隐藏清理失败。
- **建议**: 不要吞掉 finally 中的 rm 异常；将缩略图普通下载失败与目录清理失败分开处理，后者保留原始 rejection 并进入 worker/runtime 的系统故障边界。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会隐藏真实清理失败、遗留临时文件，并阻止 runtime 接收契约要求的故障上报。）

### [blocker] 排队中的媒体任务取消后下载记录仍保持 pending
- **位置**: `src/download-worker.ts:321`
- **问题**: handle.result 的拒绝回调只结束 taskId 跟踪，不处理任务在 execute() 启动前被取消的情况。排队任务由管理器直接终结，#run() 从未执行，因此没有任何路径把对应下载记录改成 canceled；新增测试甚至在第 472 行断言记录仍为 pending。这与排队取消及最终 manager/download 均为 canceled 的契约不符，manager.stop() 取消排队任务时同样会发生。
- **建议**: 在 worker 观察到排队任务的类型化取消时，以明确的 pending -> canceled 持久化转换收敛下载记录；持久化失败必须进入边界故障上报。同步修正测试，断言任务快照和下载记录都为 canceled。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会在数据库中遗留 pending 下载，导致重启恢复误判异常中断，并使用户状态与任务快照不一致。）

### [blocker] 正常进程取消未收敛为类型化取消
- **位置**: `src/server.ts:290`
- **问题**: 停机直接依赖 taskManager.stop() 正常取消所有运行任务，但当前管理器传入 AbortController 的 YtDlpTaskCancellationError 在 src/yt-dlp.ts 进程边界被重新构造成普通 Error('yt-dlp download cancelled')；管理器因此把真实的运行中下载取消判为 failed，并让 stop() 以该错误拒绝。实测 test/integration/server-lifecycle.test.ts 的运行中下载停机用例正因该错误失败。
- **建议**: 在管理器与底层 yt-dlp 的固定取消协议边界保留 AbortSignal.reason，或由管理器 operations 仅将已确认的底层正常取消转换为 YtDlpTaskCancellationError；kill、持久化、归档、清理及未知错误仍必须保留原始 rejection 并判为 failed。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会令含运行中下载的正常服务器停机抛出 AggregateError，被调用方误判为系统故障。）

### [blocker] 频道服务重写并吞掉正常取消类型
- **位置**: `src/services/channel.ts:981`
- **问题**: 首次同步和频道检查的 fetchChannelEntries/fetchVideoMetadata catch 会把所有异常无条件改写为 CHANNEL_FETCH_FAILED 或 CHANNEL_METADATA_INVALID；即使底层按契约抛出 YtDlpTaskCancellationError，类型身份也会在这里丢失，routes/channels.ts 与 scheduler.ts 新增的 isYtDlpTaskCancellationError 排除分支无法命中。当前首次同步停机测试已表现为 BusinessError 并使 taskManager.stop() 拒绝。
- **建议**: 在四处外部操作异常边界显式识别 YtDlpTaskCancellationError：仍按既有频道契约完成失败记录，但在记录成功后重新抛出原类型化取消；若失败记录本身发生持久化错误，则抛出 PERSISTENCE_ERROR。同步更新仍断言取消被改写为失败的旧测试。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会使首次同步、手动检查和定时检查的正常取消均被标为 failed，并破坏服务器正常停机及取消故障排除逻辑。）

### [blocker] 排队下载停机后仍保留 pending 状态
- **位置**: `src/server.ts:290`
- **问题**: manager.stop() 会直接终结尚未启动的 media_download，DownloadWorker 的 execute 因而不会运行，也没有任何路径把对应 downloads 记录从 pending 更新为 canceled。新增生命周期测试在停机后明确期望 ['canceled','pending']，这与“排队/运行取消均到 canceled”的契约相反。
- **建议**: 让 DownloadWorker 在其已跟踪任务收到管理器的类型化排队取消结果时，将仍为 pending 的对应下载原子更新为 canceled；继续以 manager 作为唯一取消源，不新增第二套 controller 或队列。测试应断言两个下载均为 canceled。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会使停机时的排队下载残留 pending，并在重启时被错误转换为 interrupted，破坏可观察终态。）

### [blocker] 底层正常取消未使用管理器可识别的类型
- **位置**: `src/yt-dlp.ts:239`
- **问题**: runProcess 在 AbortSignal 取消并成功收敛进程组后拒绝一个普通 Error，但 YtDlpTaskManager 只在收到 YtDlpTaskCancellationError 时进入 canceled。通过真实 operations.downloadMedia 路径调用 manager.cancel() 时，当前实现会让 cancel() 拒绝，并把快照写成 failed，failureReason 为 yt-dlp download cancelled。单元测试通过 mock 直接拒绝 signal.reason，未覆盖真实底层返回类型。
- **建议**: 让底层取消协议返回与管理器共享且可稳定识别的类型化取消错误，并补充通过真实 yt-dlp operation 执行 manager.cancel/stop 的集成测试；不得用消息匹配识别取消。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会使真实 yt-dlp 进程的用户取消和正常停机被记录为失败，并误触发 runtime/scheduler 故障路径。）

### [blocker] stop 在首个取消失败后未等待其余任务收敛
- **位置**: `src/yt-dlp-task-manager.ts:279`
- **问题**: stop 使用 Promise.all 聚合 cancel；任一任务因真实系统、持久化或清理错误拒绝后，stopPromise 会立即拒绝，即使其他任务仍处于 running。实测一个任务立即失败、另一个任务仍等待业务清理时，stop 已经 settled 而第二个快照仍为 running。
- **建议**: 先等待所有 cancel promise 全部 settled，再在全部任务、回调和进程组收敛后保留并抛出失败；同时增加多任务中一项失败、另一项延迟清理的停机屏障测试。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会在任务和业务回调尚未收敛时关闭数据库，形成停机竞态、持久化失败和进程清理不完整。）

### [blocker] 取消标志会掩盖 yt-dlp 启动失败
- **位置**: `src/yt-dlp.ts:239`
- **问题**: close 处理先判断 cancelled，直到第 261 行才判断 spawnError。若 signal 已取消且 executable 不存在，spawn 会产生真实 ENOENT，但当前返回 yt-dlp download cancelled；已用预先 abort 的 signal 和不存在的 executable 复现。该行为违反取消期间真实系统错误必须 failed 并保留原始 rejection 的契约。
- **建议**: 在取消分类前优先保留独立发生的 spawnError，并增加预先取消叠加 executable 启动失败的负向测试，确保结果不是正常取消。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会把 yt-dlp 缺失或 executable 配置损坏等真实部署故障归类为正常取消，导致根因漏报。）

### [blocker] 正常停机取消被测试固化为失败
- **位置**: `test/integration/channel-notification-api.test.ts:439`
- **问题**: 该用例明确期待 taskManager.stop() 以 CHANNEL_FETCH_FAILED 拒绝，并在随后断言 channel_initial_sync 快照为 failed、failureReason 为取消消息。这与总状态机契约“排队/运行取消均到 canceled”及 task-16 的“正常停机取消不得上报故障”相冲突；同批 yt-dlp 用例还只按错误消息识别取消，因此当前普通 Error 会穿过业务层并被管理器当作真实失败。实际执行 npm test -- --run 时，server lifecycle 和 download worker 的正常取消均因此失败，快照从预期 canceled 变成 failed。
- **建议**: 让底层取消沿 AbortSignal 的类型化取消原因收敛，频道业务层识别后原样抛出 YtDlpTaskCancellationError；将本用例改为断言 stop 正常完成、任务快照为 canceled，并用 isYtDlpTaskCancellationError 或具体类型断言取消，不能用消息字符串或 CHANNEL_FETCH_FAILED 固化当前错误行为。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；测试当前固化了与状态机和 task-16 相反的行为，会放任正常停机被当作系统失败并阻断验收。）

### [blocker] 唯一底层入口扫描仍可被动态路径绕过
- **位置**: `test/integration/pages.test.ts:169`
- **问题**: lowLevelYtDlpReferences 只拼接相邻的原始字符串字面量，既不解码转义，也不分析模板插值或变量拼接。有效加载如 import('../yt\\x2ddlp.js')、import(`../yt-${'dlp'}.js`) 以及 const suffix = 'dlp.js'; import('../yt-' + suffix) 都返回空引用，因而不会进入 violatingFiles；这不满足 task-23 对 import()、require() 和字符串拼接加载均应拒绝的明确要求。
- **建议**: 围绕 import/require 调用及静态 import 语句解析模块说明符，对字符串常量表达式做受限求值或使用项目现有 TypeScript parser，并把转义字面量、模板插值和变量拼接加入负向样本；仍只允许 manager 的一条固定静态 import。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会允许生产代码绕过唯一任务管理器入口，使并发限制、取消和停机屏障失效，同时测试仍会错误通过。）

### [blocker] 进程树取消用例在 close 后立即检查 PID，存在已复现竞态
- **位置**: `test/integration/yt-dlp.test.ts:51`
- **问题**: helper 在操作 promise 刚完成后立即用 process.kill(childPid, 0) 断言子 PID 已消失。进程组收到 SIGKILL 后，后代进程仍可能短暂处于可查询的僵尸/待回收状态，因此该瞬时断言不等价于进程仍在运行。该文件单独运行通过，但 npm test -- --run 已在“cancels the complete channel fetch process tree”处复现此断言失败。
- **建议**: 在有界超时内轮询 process.kill(pid, 0) 直到 ESRCH，并在超时后再判失败；清理路径继续确保残留进程被终止，同时保留对操作已等待 close 和取消错误类型的断言。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会造成已复现的测试竞态，使全仓测试随系统回收时序随机失败并阻断合入。）

### [blocker] 任务页面错误用例使用了契约外错误码和状态码
- **位置**: `test/integration/pages.test.ts:823`
- **问题**: 任务快照 API 的固定异常契约是 500 PERSISTENCE_ERROR，但页面 load 测试伪造了 503 TASK_SNAPSHOT_FAILED。该测试既没有覆盖已确认的错误映射，又为未定义错误码建立了测试契约，违反契约优先、最小实现以及 task-08/task-22 的联合验收要求。
- **建议**: 将模拟响应改为 500 且 error.code 为 PERSISTENCE_ERROR，并断言最终 DOM 显示该固定错误；若要证明真实 API 映射，应通过路由可控故障路径触发，而不是发明新的错误码。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会漏检 PERSISTENCE_ERROR 的页面展示回归，并错误固化未确认的 TASK_SNAPSHOT_FAILED/503 契约。）
