## 整体评价

**结论**：needs-fix

Step 2 worker 对 5 条 findings 均无异议，且各问题均有明确的功能、测试或接口契约后果。5 条问题全部裁定为需修，当前不建议合入。

---

## 需求覆盖度

| Task | 标题 | 状态 |
|------|------|------|
| N/A | 无完整 task 清单信息 | N/A |

---

## 问题列表

### [blocker] 停机在取消管理器任务前等待 scheduler，运行中的频道检查会使 stop 永久阻塞
- **位置**: `src/server.ts:300`
- **问题**: 正常停机先 `await schedulerBoundary`，之后才调用 `taskManager.stop()`；但 `ChannelScheduler.stop()` 会等待 `#runningChecks` 全部 settled，而 scheduled check 正通过同一个 manager 运行 yt-dlp。若检查进程仍在运行或卡住，scheduler 等待任务结束，manager 又尚未收到取消，形成无法收敛的等待链。同时 manager 也没有按契约在关闭 HTTP/SSE 前先拒绝新任务。
- **建议**: 在开始关闭 HTTP/SSE 前同时启动 `scheduler.stop()` 与 `taskManager.stop()`，先停止两者派发并触发 manager 取消；随后关闭 HTTP/SSE，再等待 scheduler、manager 和 worker 的业务清理全部 settled，最后关闭数据库。补充一个运行中 `channel_scheduled_check` 阻塞时调用 `server.stop()` 的回归测试。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会使存在未结束定时频道检查时的 `server.stop()` 永久阻塞，服务无法正常退出或重启，具有明确的功能与稳定性后果。）

### [blocker] 停机聚合错误测试断言了错误的异常形状
- **位置**: `test/integration/channel-notification-api.test.ts:539`
- **问题**: 该用例期望 taskManager.stop() 直接拒绝为带 code 的 BusinessError，但 task-28 明确要求 stop() 在等待全部取消任务收敛后使用 AggregateError 汇总全部失败。当前实现按契约返回 AggregateError，导致新增测试稳定失败（本批次测试结果为 1 failed / 70 passed）。
- **建议**: 将断言改为校验拒绝值是 AggregateError，并检查 errors 中包含 code 为 PERSISTENCE_ERROR 的 BusinessError；同时保留后续 runtimeErrors 和任务失败快照断言。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会导致相关集成测试和完整 CI 稳定失败，反向修改生产行为还会破坏 task-28 的多失败聚合契约。）

### [blocker] 停机失败测试断言违背聚合错误契约
- **位置**: `test/integration/yt-dlp.test.ts:288`
- **问题**: 该用例断言 manager.stop() 直接以原始进程组终止错误拒绝，但 YtDlpTaskManager.stop() 按 task-28 的明确契约始终在等待全部取消任务收敛后以 AggregateError 汇总失败。当前实现返回 AggregateError，因此这条新增验收测试稳定失败。
- **建议**: 保留 stop() 的 AggregateError 行为，将断言改为验证拒绝值是 AggregateError，且 errors 精确包含 failure（与已有 manager 单元测试的断言一致）。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会使指定集成验收稳定失败，若修改生产代码迎合错误断言则会破坏 task-28 的多失败聚合契约。）

### [blocker] 唯一入口扫描可被带类型标注的常量绕过
- **位置**: `test/integration/pages.test.ts:285`
- **问题**: 变量绑定收集只识别紧邻的 `const Identifier =` token 序列，没有按 TypeScript 语法解析 VariableDeclaration。实际输入 `const suffix: string = 'dlp.js'; await import('../yt-' + suffix)` 时，`lowLevelYtDlpReferences` 返回空数组；同名 const 出现在不同作用域时，当前全文件 Map 还会把该名称统一置为 undefined。现有负样本只覆盖无类型标注且名称唯一的最简单变量拼接，因此没有证明 task-23/task-29 要求的动态路径绕过扫描。
- **建议**: 使用 TypeScript AST 按作用域解析静态 import、import()、require() 及其参数，对 const 初始化器做受限常量求值，并增加带类型标注和不同作用域同名绑定的负样本。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会允许生产源码绕过唯一 YtDlpTaskManager 入口扫描，使下载并发限制、统一取消和停机屏障失去保证。）

### [blocker] 页面失败用例仍未使用固定 API 错误体
- **位置**: `test/integration/pages.test.ts:935`
- **问题**: 任务快照 API 的意外错误契约是 `500 {error:{code:"PERSISTENCE_ERROR",message:"internal server error"}}`，但该 load 路径用例伪造并断言了 `message: "database unavailable"`。状态码和错误码虽已修正，响应体仍不是需求确认的固定契约。
- **建议**: 把模拟响应及最终 DOM 断言中的 message 改为 `internal server error`，与 `/api/yt-dlp/tasks` 的全局意外错误映射完全一致。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 明确认可；不修复会将非契约错误消息固化为可接受行为，无法验证页面遵循固定 API 响应，并可能放过内部持久化细节泄露的回归。）
