## 整体评价

**结论**：needs-fix

7 条 finding 均获 worker 认可，且不修复会造成明确的契约违背、安全风险、状态错误或关键回归边界缺失。全部问题均需修复后再合入。

---

## 需求覆盖度

| Task | 标题 | 状态 |
|------|------|------|
| N/A | 无已知 task 信息 | N/A |

---

## 问题列表

### [blocker] 授权卡片暴露了契约外的第三种状态
- **位置**: `src/views/authorizations.ejs:36`
- **问题**: 需求明确限定 UI 配置状态只能是“未配置”或“已配置”，但模板把五个平台的初始状态渲染为“正在加载”。该文本不仅在正常请求期间可见；当 GET /api/authorizations/cookies 失败时，前端只显示页面错误而不会更新卡片，因此五张卡会永久停留在这个未确认状态。
- **建议**: 不要把加载过程建模为配置状态；在元数据返回前隐藏状态区域，成功后仅由 renderConfiguration 写入“未配置”或“已配置”，加载失败时保持状态区域隐藏并展示既有页面级固定错误。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 已认可；不修复会使 API 失败时页面永久展示契约外状态，用户无法按约定判断平台配置状态，具有明确的功能与接口契约影响。）

### [blocker] 初始化会静默删除非普通临时路径
- **位置**: `src/services/cookie-authorization.ts:261`
- **问题**: initialize() 对固定临时路径直接调用 unlink，没有先用 lstat 验证其为普通文件。符号链接、FIFO 等可被 unlink 的非普通条目会被删除后继续初始化；本地复现中 .youtube.cookies.txt.pending 为符号链接时 initialize() 成功且链接被移除。这违反了使用 lstat 拒绝非普通文件以及安全初始化失败必须快速失败的固定契约。现有测试虽然导入了 lstat 并覆盖最终文件符号链接，却没有覆盖临时路径的同一边界。
- **建议**: 清理每个精确临时路径前先 lstat；仅普通文件允许 unlink，ENOENT 视为无残留，其他类型或文件系统错误统一抛出 cookie persistence failed。补充临时路径为符号链接或其他非普通文件时 initialize() 失败且条目不被静默接受的测试。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 已认可；不修复会让存储篡改场景绕过快速失败并继续启动 HTTP，破坏明确的安全初始化和启动边界。）

### [blocker] 失败测试未覆盖已配置文件的校验失败和原子提交失败
- **位置**: `test/unit/cookie-authorization.test.ts:311`
- **问题**: 当前替换失败测试通过预先创建同名临时目录，让 open(..., 'wx') 在候选文件创建前就失败；所有格式错误用例又都从未配置状态开始。因此测试没有证明已配置文件在无效替换时保持旧内容和 mtime，也没有让失败发生在 sync、utimes 或 rename 的原子提交阶段，未覆盖任务明确要求的任一校验或持久化失败保持旧状态和原子失败边界。
- **建议**: 增加已配置状态下的无效格式替换测试，并用可控流或文件系统故障让候选文件完成写入校验后在提交阶段失败；只用摘要、布尔状态和 mtime 比较旧文件、旧状态、旧时间完全不变。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 已认可；缺失的测试无法防止失败替换误删、截断旧文件或推进 mtime，Cookie 配置的核心原子替换状态机缺少必要回归保护。）

### [blocker] Cookie 子进程负向断言可被等号参数和环境变量名绕过
- **位置**: `test/integration/download-api.test.ts:182`
- **问题**: 五个 task-09 测试中的同类 helper 只用 args.includes() 排除独立参数 --cookies 与 --cookies-from-browser，因此不会识别 --cookies-from-browser=chrome 这类合法 CLI 写法；伪 yt-dlp 对环境变量也只检查 value 是否包含测试 Cookie 原文或存储目录，不检查 Cookie 相关的变量名。需求明确要求断言真实子进程 argv 中无 --cookies-from-browser，且无 Cookie 环境变量或其他引用，当前断言并未完整覆盖该契约。
- **建议**: 在所有重复 helper 中按参数名同时拒绝独立形式和 --name=... 形式，并让子进程记录、断言 Cookie 相关环境变量名不存在；继续只对布尔结果断言，避免失败输出泄露值。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 已认可；当前断言可被合法等号参数或 Cookie 相关环境变量绕过，无法证明已保存 Cookie 与真实下载子进程隔离，存在明确的安全与需求违背风险。）

### [blocker] 下载队列的 Cookie 字段检查仅覆盖顶层
- **位置**: `test/integration/download-api.test.ts:199`
- **问题**: expectNoCookieQueueFields 只遍历 QueuedDownload 的顶层 key 和顶层字符串 value。queuedDownload.advancedOptions 是嵌套对象；若 Cookie 路径、状态或字段被加入该对象，顶层 key 列表仍完全不变，当前 helper 也不会检查到嵌套内容。需求明确要求队列对象不得新增 Cookie 字段，并禁止向下载流程注入 Cookie 路径或状态。
- **建议**: 对完整队列对象递归检查所有字段名和字符串值，或对 advancedOptions 也做固定结构的精确断言，确保任意层级新增 Cookie 字段都会使测试失败。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 已认可；不修复会允许 Cookie 路径或配置状态通过嵌套对象进入下载队列而测试仍通过，队列隔离验收边界没有被固化。）

### [blocker] 数据库开放契约测试把已知 generic 平台当成未知值
- **位置**: `test/integration/database.test.ts:269`
- **问题**: 需求要求在迁移后显式插入并读取 Vimeo 和另一个非空未知平台值，但测试使用了 generic。generic 不是未知值：当前直接下载实现会把 yt-dlp 的 extractor_key: Generic 持久化为 platform: generic，现有 download-service 集成测试也把它作为受支持的通用 HTTPS 平台。因此这组断言只覆盖了两个现有平台，没有证明 downloads.platform 对任意非空未知值保持开放。
- **建议**: 把 generic 样例改为明确不属于当前平台集合的固定历史值（例如 unknown-platform），并继续在迁移后的数据库中插入后按原值查询断言；Vimeo 样例保持不变。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 已认可；当前测试无法阻止 migration 将字段错误收紧为已知枚举，可能导致未知历史平台记录无法写入或迁移，直接破坏开放兼容契约。）

### [blocker] 敏感边界测试在回归时会把原始值打印到失败输出
- **位置**: `test/integration/pages.test.ts:682`
- **问题**: 页面测试把包含敏感标记的文件名直接传给 expect(value).toBe('')；若清空逻辑回归，Vitest 会在 diff 中打印完整文件名。相同问题还出现在 test/integration/server-lifecycle.test.ts:122-125：它直接断言原始 failure、failure.message 和捕获的 records，若初始化错误或日志回归为包含 Cookie 路径、内容或底层异常，测试会在执行后面的 includes 布尔检查之前先把敏感值输出。该行为违反 Cookie 内容、文件名、路径、底层异常即使在测试失败时也不得泄露的明确契约。
- **建议**: 所有含敏感值的断言先转换为布尔值或无敏感内容的摘要再断言，例如 expect(fileControl.value === '').toBe(true)、expect(failure instanceof Error && failure.message === 'cookie persistence failed').toBe(true) 和 expect(records.length === 0).toBe(true)；保留现有 includes(...).toBe(false) 方式检查标记，不把原对象或字符串交给 matcher。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 已认可；安全回归发生时测试失败输出会泄露 Cookie 文件名、保存路径、底层异常或日志内容，使回归检测自身形成敏感信息泄露风险。）
