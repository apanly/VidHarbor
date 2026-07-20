## 整体评价

**结论**：needs-fix

8 条 finding 均获 worker 认可，且分别涉及取消终态一致性、系统故障保留、固定 API 契约、页面字段可见性及验收测试有效性，均有明确的实质修复价值。当前存在 8 条需修问题，不建议在修复并验证前合入。

---

## 需求覆盖度

| Task | 标题 | 状态 |
|------|------|------|
| Task 12 | 任务状态页面真实加载路径测试 | 未满足 |
| Task 13 | yt-dlp 唯一底层入口约束 | 未满足 |

---

## 问题列表

### [blocker] 完成落库后仍存在可取消的异步窗口
- **位置**: `src/download-worker.ts:503`
- **问题**: 下载记录更新为 completed 后，代码立即将 archivedDirectory 置为 undefined，随后在 finally 中 await 删除临时目录。该 await 期间任务在管理器中仍是 running，manager.stop() 或直接 manager.cancel() 可以将 signal 置为 aborted；清理结束后代码没有再次检查取消并正常返回，因此管理器会把任务终结为 canceled，但下载记录已经是 completed，归档文件也不会回滚。这违反了直接管理器取消也必须使 manager/download 均为 canceled 且不保留归档产物的契约。
- **建议**: 把临时目录清理放到成功落库之前，并在清理完成后、同步执行 completed UPDATE 前做最后一次 signal 检查；在该检查通过并完成业务终态落库之前保留归档回滚信息。同时增加一个在成功路径临时目录 rm 被 gate 阻塞时调用 manager.cancel/stop 的测试。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会使管理器与下载记录形成 canceled/completed 相互矛盾的终态，并遗留归档产物，具有明确的数据与文件状态一致性风险。）

### [blocker] 下载 worker 通过错误消息文本识别取消
- **位置**: `src/download-worker.ts:281`
- **问题**: isCancellationError 仅比较 error.message 是否等于固定英文文本来判断取消，并由缩略图 catch 依赖该判断决定是否重抛。需求明确要求取消错误稳定、可类型识别且不得消息匹配；当前实现也把取消期间进程组终止失败等非该精确消息的异常当成普通缩略图失败静默忽略。
- **建议**: 删除消息字符串判断；缩略图错误边界应依据 operations.signal.aborted 重抛原错误，或使用已确认的类型化取消契约，并继续只忽略未取消时的普通缩略图失败。补充取消期间底层抛出非固定消息错误的负向测试。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会在错误文本变化或进程组终止异常发生时丢失原始失败原因，破坏取消错误的类型化契约和系统故障诊断能力。）

### [blocker] 取消请求会掩盖执行阶段的真实系统故障
- **位置**: `src/yt-dlp-task-manager.ts:321`
- **问题**: 任务一旦设置 cancelRequested，执行器随后以任何错误拒绝都会被无条件改写为 canceled，原始错误被丢弃。这不仅处理正常的进程取消，也会吞掉取消期间发生的 PERSISTENCE_ERROR、归档/清理失败或其他未知系统异常；上层 routes/channels.ts 和 scheduler.ts 看到稳定取消错误后会按正常停机排除上报。该行为违反“持久化失败、其他系统异常仍上报并完整收敛”的明确契约。
- **建议**: 为底层/业务清理建立可类型识别的正常取消结果，只在执行器确认返回该取消结果（或无错误完成但 signal 已取消）时落 canceled；若取消后执行器抛出持久化或其他系统错误，应保留 failed 终态和原始拒绝，让现有 runtime/scheduler 边界继续上报。补充取消与持久化失败同时发生的测试。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会把持久化、归档或清理故障错误记录为正常取消，使业务状态未完整收敛且运维侧无法感知真实系统故障。）

### [blocker] 失败任务可以产生空 failureReason
- **位置**: `src/yt-dlp-task-manager.ts:342`
- **问题**: 失败原因直接采用 errorMessage 经注入函数处理后的返回值，但 errorMessage 对空字符串拒绝值会返回空字符串，且最终结果未校验非空。例如 execute 执行 Promise.reject('') 时快照状态为 failed、failureReason 却为 ''，与“failureReason 仅 failed 非空且脱敏”的固定快照/API 契约冲突。
- **建议**: 在写入终态前将空错误文本规范化为固定非空错误描述，并对脱敏函数的结果执行非空契约校验；增加执行器以空字符串拒绝时的快照测试。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会直接产出契约禁止的空 failureReason，破坏固定快照/API 契约并使调用方和页面失去失败诊断信息。）

### [blocker] 桌面窄宽度下任务表格列被直接裁掉
- **位置**: `src/styles/main.scss:1182`
- **问题**: 表格容器同时使用 Bootstrap 的 table-responsive 和自定义 overflow: hidden；后加载的自定义 shorthand 覆盖了 table-responsive 的 overflow-x: auto。表格又固定 min-width: 68rem，而卡片式移动布局只在 991.98px 以下启用，因此在略高于该断点且仍显示 17rem 侧栏的窗口中，右侧时间和失败原因列超出容器后既被裁剪也无法横向滚动。
- **建议**: 保留横向滚动，例如将容器改为 overflow-x: auto、overflow-y: hidden，或把卡片式布局断点提高到表格在侧栏布局中能完整容纳的宽度。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会导致常见小屏桌面或分屏窗口无法查看结束时间和失败原因，页面不能完整展示契约要求的固定字段。）

### [blocker] 取消请求会掩盖进程组终止失败
- **位置**: `src/yt-dlp-task-manager.ts:321`
- **问题**: 任务一旦设置 cancelRequested，执行函数随后抛出的任何异常都会被无条件改写为 canceled。此次停机流程在 src/server.ts 中直接 await taskManager.stop()，而 src/yt-dlp.ts 会在负 PID 进程组终止失败时明确抛出 yt-dlp process group termination failed；该异常到达这里后仍被丢弃，stop() 也只等待 settled 并成功返回。实际复现中模拟 process.kill(-pid) 抛错后，stop() resolved、任务快照为 canceled 且 failureReason 为 null。相同逻辑还会掩盖取消期间频道业务清理产生的持久化异常。
- **建议**: 仅在执行结果确实是可类型识别的正常取消错误时落为 canceled；进程组终止失败、持久化失败及其他系统异常必须保留为 failed，并让 stop() 或既有 runtime 故障边界感知。补充停机取消时进程组 kill 失败和业务清理持久化失败的测试。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会让服务在进程组未完整终止时仍报告干净停机，可能遗留存活子进程，并同时掩盖持久化故障。）

### [blocker] 页面测试绕过了实际 load 接线
- **位置**: `test/integration/pages.test.ts:741`
- **问题**: 任务页面的核心用例直接请求 /api/yt-dlp/tasks，再由测试代码自行筛选 activeTasks/terminalTasks 并直接调用从脚本中截取的 renderGroup；taskPageHelpers 还明确在 load().catch 之前截断脚本，因此页面模块真实的 load()、fetch、分类和渲染接线从未执行。这与 task-12 明确要求“不以 API 测试替代页面测试”不一致。
- **建议**: 在可控 DOM 环境中执行页面模块的完整加载路径，注入一次性 fetch 响应并等待 load 完成，然后从页面 DOM 断言五类、五态、活动/终态分组和脱敏结果；不要在测试代码中复制生产分类逻辑。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会使生产页面 load、分类或渲染接线失效时测试仍然通过，明确违背 Task 12 的页面测试要求并造成错误验收。）

### [blocker] 唯一底层入口扫描可被动态导入绕过
- **位置**: `test/integration/pages.test.ts:823`
- **问题**: 所谓“只允许 manager 导入底层模块”的检查只匹配静态 from '.../yt-dlp.js' 语法。需求 task-13 明确禁止隐藏、拼接和动态导入规避，但 import('./yt-dlp.js')、require('./yt-dlp.js') 或拼接出的动态 import 都不会进入 importingFiles。
- **建议**: 按已确认契约扫描 manager 之外生产 TypeScript 中所有 yt-dlp.js 字面量/动态导入/require 用法，并为动态 import 和拼接规避增加负向测试；若采用 AST，则显式拒绝这些已禁止的导入形态。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会允许生产代码绕过唯一底层入口约束，使统一取消、并发调度、脱敏和停机屏障失去强制保障，明确违背 Task 13。）
