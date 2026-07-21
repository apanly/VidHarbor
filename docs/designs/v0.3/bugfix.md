## bugfix-01 · 授权卡片仅展示契约内配置状态
- 关联 task: task-10
- 描述: `src/views/authorizations.ejs:36` 当前初始渲染“正在加载”，API 失败时会永久保留契约外第三种状态。元数据返回前应隐藏状态区域；成功后仅显示“未配置”或“已配置”，失败时保持隐藏并使用既有页面级固定错误。

## bugfix-02 · 初始化拒绝非普通临时路径
- 关联 task: task-11
- 描述: `src/services/cookie-authorization.ts:261` 清理固定 pending 路径前未用 lstat 验证普通文件，符号链接或 FIFO 会被静默删除并继续启动。仅普通文件允许清理，ENOENT 允许通过，其他类型或文件系统错误必须统一快速失败，并增加对应安全边界测试。

## bugfix-03 · 覆盖已配置 Cookie 的失败替换原子性
- 关联 task: task-12
- 描述: `test/unit/cookie-authorization.test.ts:311` 未证明已配置文件在无效格式替换及 sync、utimes 或 rename 提交失败时保持旧内容、旧状态和旧 mtime。增加不泄露原文的摘要、布尔状态及 mtime 断言，覆盖校验失败和原子提交失败。

## bugfix-04 · 完整拒绝 Cookie 子进程参数与环境变量
- 关联 task: task-13
- 描述: `test/integration/download-api.test.ts:182` 及 task-09 同类 helper 未拒绝 `--cookies=...`、`--cookies-from-browser=...`，也未检查 Cookie 相关环境变量名。所有真实子进程边界测试需覆盖独立与等号参数形式，并只用非敏感布尔结果断言环境变量名不存在。

## bugfix-05 · 下载队列递归检查 Cookie 引用
- 关联 task: task-14
- 描述: `test/integration/download-api.test.ts:199` 只检查排队对象顶层字段和值，无法发现 `advancedOptions` 等嵌套对象中的 Cookie 字段、路径或状态。对完整队列对象递归检查所有字段名与字符串值，或精确断言嵌套固定结构。

## bugfix-06 · 用真正未知的平台值验证数据库开放契约
- 关联 task: task-15
- 描述: `test/integration/database.test.ts:269` 使用已知的 `generic` 代表未知平台，未证明 `downloads.platform` 接受任意非空历史值。保留 Vimeo 样例，并改用明确不属于当前平台集合的固定未知值进行迁移后写入和原值读取断言。

## bugfix-07 · 防止安全测试失败输出敏感原值
- 关联 task: task-16
- 描述: `test/integration/pages.test.ts:682` 与 `test/integration/server-lifecycle.test.ts:122` 将可能含敏感文件名、路径、底层异常或日志内容的原始对象交给 matcher，回归时 Vitest diff 会泄露原值。先转换为布尔值或非敏感摘要再断言，并保留仅对标记存在性的布尔检查。

## bugfix-08 · 接管并完成递归队列隔离测试
- 关联 task: task-17
- 描述: `task-14` worker 已修改 `test/integration/download-api.test.ts`，并通过 `git diff --check`、25 项定向测试及定位检索，但在最终写入 `result.json` 前因 `Selected model is at capacity. Please try a different model.` 异常退出。保留现有改动，复核递归字段名与字符串值检查仅向 matcher 暴露布尔结果，重跑原验收并完成任务。
