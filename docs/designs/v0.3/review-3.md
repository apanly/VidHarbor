## 整体评价

**结论**：needs-fix

5 条 finding 均获 worker 认可，且分别涉及敏感信息泄露、元数据事实源不一致、明确安全边界缺少测试、失败反馈契约缺少验证以及测试无依据扩大实现约束，均有实质修复价值。合入前需完成全部 5 条修复。

---

## 需求覆盖度

| Task | 标题 | 状态 |
|------|------|------|
| task-10 | 上传失败固定反馈与文件内容读取边界 | 未充分覆盖 |
| task-11 | pending 路径非普通文件安全边界 | 未充分覆盖 |
| task-13 | yt-dlp 调用记录敏感信息隔离 | 未满足 |
| task-18 | yt-dlp matcher 敏感信息隔离 | 未满足 |
| N/A | 保存响应以最终文件 mtime 为事实源 | 未满足 |

---

## 问题列表

### [blocker] yt-dlp 隔离夹具仍记录原始参数数组
- **位置**: `test/integration/channel-initial-sync.test.ts:164`
- **问题**: task-13 和 task-18 明确要求调用记录与 matcher 仅保留非敏感布尔值，但四个子进程夹具都把 `sanitizedArgs` 写入记录或返回结果；该过滤仅移除 Cookie 相关参数，不移除 `--proxy` 后的代理 URL 等其他敏感参数。相同模式还存在于 channel-scheduled-check.test.ts、download-worker.test.ts 和 yt-dlp.test.ts。
- **建议**: 不要记录 `args` 数组；在子进程内把需要验证的非敏感协议事实（例如是否含 `--dateafter`、`--no-playlist`、媒体/缩略图调用类型）分别转换成布尔值后，只输出这些布尔值以及 Cookie 引用检测布尔值。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 无异议；不修复会使带凭据的代理 URL 进入测试临时日志或断言 diff，造成明确的敏感信息泄露风险。）

### [blocker] 保存响应的 updatedAt 未从最终文件 mtime 读取
- **位置**: `src/services/cookie-authorization.ts:344`
- **问题**: 契约规定普通最终文件及其 mtime 是唯一事实源，但 rename 成功后直接返回调用 `utimes` 时构造的 `Date`，没有对最终文件执行 lstat。文件系统若对时间戳进行精度舍入，保存响应中的 updatedAt 会与紧接着 listConfigurations 读取到的真实 mtime 不一致。
- **建议**: rename 成功后对最终路径执行 lstat，确认仍为普通文件，并使用其 `mtime.toISOString()` 构造返回值；读取失败按固定持久化错误处理。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 无异议；不修复会导致同一上传在保存响应与后续查询中返回不同时间，违反唯一事实源契约并造成可见的数据不一致。）

### [blocker] pending 路径的 FIFO 边界没有测试覆盖
- **位置**: `test/integration/server-lifecycle.test.ts:281`
- **问题**: task-11 明确要求初始化时对固定 pending 路径拒绝 symlink、FIFO、目录及其他文件系统错误。当前生命周期测试只覆盖 symlink 和 lstat 错误；现有单元测试也只参数化了 symlink 与目录，仓库中没有创建 FIFO 并验证固定 PERSISTENCE_ERROR、禁止监听及原对象保留的用例。
- **建议**: 新增 FIFO pending 路径用例（可用 mkfifo 创建），断言 startServer 以 cookie persistence failed 失败、Server.listen 未调用、FIFO 未被删除且敏感路径不进入 matcher/log；或在单元测试中覆盖同等边界并保留生命周期层的禁止监听断言。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 无异议；FIFO 是 task-11 明确要求的安全边界，缺少测试将无法防止初始化逻辑错误删除、跟随或接受 FIFO 的回归。）

### [blocker] 上传失败的固定错误反馈未被断言
- **位置**: `test/integration/pages.test.ts:729`
- **问题**: 浏览器交互夹具让第二次 YouTube 上传返回 400 VALIDATION_ERROR，但随后只检查文件控件被清空和既有“已配置”状态保留，没有检查卡片错误节点是否显示固定错误文本、是否保持非敏感，也没有证明失败没有产生第三种状态。因而删除或破坏上传失败提示的实现仍会通过该测试。
- **建议**: 从 makeCard 返回 error 节点，在失败上传后断言其固定公开错误文本和可见状态，同时以布尔摘要断言其中不含 sensitiveMarker，并继续断言状态仍为“已配置”。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 无异议；不修复会使上传失败提示缺失、泄露敏感内容或出现未定义第三状态时仍能通过测试，无法证明 task-10 的明确反馈契约。）

### [suggest] 测试无依据地禁止所有 text() 调用
- **位置**: `test/integration/pages.test.ts:767`
- **问题**: 契约只禁止读取所选 File 的内容（File.text()/file.text()），但正则中的通用分支 `\.text\(\)` 会同时拒绝 Response.text() 等与 Cookie 文件读取无关的合法调用，扩大了前端实现契约。
- **建议**: 将断言限定到所选文件变量的 text 调用，或通过 fake File 的 text 方法设置调用标记并断言其为 false；保留 localStorage/sessionStorage 的独立禁止断言。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 无异议；该断言会阻止 Response.text() 等契约允许的合法实现，实质扩大已确认需求并可能造成后续功能实现被错误拦截。）
