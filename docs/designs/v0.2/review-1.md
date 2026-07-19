## 整体评价

**结论**：needs-fix

3 条 blocker finding 均获 worker 认可，且分别会造成取消状态与业务记录矛盾、正常停机被误判为故障退出，以及测试失败时套件悬挂。上述问题均有实质后果，需修复后再合入。

---

## 需求覆盖度

| Task | 标题 | 状态 |
|------|------|------|
| N/A | 无已知 task 信息 | N/A |

---

## 问题列表

### [blocker] 管理器直接取消无法阻止下载后处理继续写成功
- **位置**: `src/download-worker.ts:619`
- **问题**: worker 只通过 #cancelingDownloads 判断后处理阶段是否已取消，而该集合仅由 DownloadWorker.cancel() 写入。manager.stop() 会直接调用 YtDlpTaskManager.cancel()；#reportFailure() 在系统故障时也于第 363 行直接取消其他 manager 任务。若取消发生在 downloadMedia/downloadThumbnail 已结束、任务正在校验或归档文件时，AbortSignal 已无在途 yt-dlp 调用可中断，#throwIfCanceling() 又看不到此次取消，因此任务仍会继续归档并把 downloads 记录更新为 completed，随后 manager 因 cancelRequested 将任务快照记为 canceled。
- **建议**: 让 DownloadWorker 的所有取消来源共享同一个可观察的取消状态。在 manager.stop() 和系统故障取消同伴任务时，也必须先标记对应 downloadId；或由 manager 提供给 execute 的任务级取消信号/检查函数，并在校验、每次归档及成功落库前检查。增加覆盖 manager.stop() 与系统故障恰好发生在下载后处理阶段的测试。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会导致已归档文件和业务记录为 completed、任务快照却为 canceled，造成数据与状态矛盾，并直接违反取消后不得归档或写成功的契约。）

### [blocker] 正常停机取消被上报为 runtime 故障
- **位置**: `src/routes/channels.ts:41`
- **问题**: YtDlpTaskManager.cancel/stop 会让 task.result 以普通 Error("yt-dlp task canceled") 拒绝。这里把所有非 BusinessError 都交给 runtime.reportError，因此停机取消正在执行的首次同步会拒绝 RunningServer.failure；同一取消经过 src/scheduler.ts:156 时也不属于 isRecordedChannelFailure，定时 tick 会再次把它作为系统故障上报。取消已经由 manager 快照记录为 canceled，频道业务回调也会落下既有失败状态，它不属于约定中的持久化/管理器系统故障。
- **建议**: 为 manager 取消结果提供当前契约需要的可识别错误类型或判定函数，并在首次同步追踪器与 scheduler 的错误边界显式排除该取消；仍需等待 task.result 收敛并保留 manager canceled 快照及频道业务状态写入。补充停机取消首次同步、定时检查时 RunningServer.failure 不拒绝的测试。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会使正常 SIGTERM/SIGINT 受控停机进入 runtime_failed 路径并设置非零退出码，导致外部进程管理器将成功停机误判为故障。）

### [blocker] 断言失败时悬挂任务无法被清理
- **位置**: `test/integration/pages.test.ts:697`
- **问题**: 该用例用两个永不自行结束、也不响应 manager 取消信号的 Promise 维持 running/queued 状态，但只在所有断言成功后才调用 finishRunning/finishQueued。若第 743 至 782 行任一请求、解析或断言抛错，控制流会跳过释放 gate；afterEach 随后调用 taskManager.stop()，running 任务收到 abort 后仍停在 runningGate，stop() 会一直等待其 settled。
- **建议**: 把两个 gate 的释放及任务收敛放入 try/finally；finally 中无条件调用 finishRunning()、finishQueued()，并 await Promise.allSettled([running.result, queued.result])，确保成功和失败路径都能完成清理。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会在页面行为真实回归时让测试卡在 teardown，掩盖原始断言失败并拖住测试套件，具有明确的测试稳定性和故障定位后果。）
