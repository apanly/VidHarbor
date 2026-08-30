## 整体评价

**结论**：needs-fix

发现 12 条需修问题，修复后再合入。

---

## 问题列表

### [blocker] task-03 未校验子目录真实路径 containment
- **位置**: `src/download-worker.ts:497`
- **问题**: 这里把 join(realDownloadRoot, targetSubdirectory) 当作 realSubdirectory，但没有在 mkdir 后 realpath 校验真实目录仍位于 realDownloadRoot 内。若下载根目录下已有 targetSubdirectory 对应的符号链接，后续 join(realDownloadRoot, targetSubdirectory, String(downloadId)) 会跟随该链接创建最终归档目录。
- **建议**: 复用本文件已有的 ensureDirectoryWithin：先 await mkdir(join(realDownloadRoot, targetSubdirectory), { recursive: true })，再对该目录做 realpath/stat/isContained 校验，并用校验后的真实子目录拼接 downloadId。
- **最终裁定**: 需修（原因：不修复时，队列传入合法的 targetSubdirectory 也可以在已有符号链接目录下把下载成品归档到 realDownloadRoot 外，违反本任务要求的 subdir 仅相对 realDownloadRoot 边界。）

### [blocker] task-11 未清理 src/i18n.ts 重格式漂移
- **位置**: `src/i18n.ts:1`
- **问题**: task-11 要求 src/i18n.ts 回退到干净单引号格式后仅补充 DOWNLOAD_MOVE_* 文案，但当前变更把整个文件从单引号改成双引号并重排多处长行，实际保留了重格式漂移。
- **建议**: 将 src/i18n.ts 恢复到任务基线的单引号格式，只保留 error.DOWNLOAD_MOVE_TARGET_EXISTS 和 error.DOWNLOAD_MOVE_FAILED 的 zh-CN/en 文案增量。
- **最终裁定**: 需修（原因：不修复时 task-11 的核心验收目标未完成，变更集会继续携带 300+ 行无关格式噪音，后续审查无法可靠区分错误码修复和格式漂移。）

### [blocker] task-11 变更集包含范围外 downloads.js 功能改动
- **位置**: `src/public/downloads.js:581`
- **问题**: task-11 的文件范围是 src/public/channel-detail.js、src/i18n.ts、src/public/i18n.js，且要求不改实际功能；但本批 diff 修改了 direct download 提交体，新增 targetSubdirectory 字段并读取 targetSubdirectory 表单元素，这是 task-07/task-10 的功能行为，不属于 task-11。
- **建议**: 从 task-11 批次移除 src/public/downloads.js 改动，或将该改动放回对应 UI 任务批次单独验收。
- **最终裁定**: 需修（原因：不修复时 task-11 不能作为只清理 i18n 映射和格式漂移的独立变更合入，回滚或重跑该任务会连带影响直下载提交行为。）

### [blocker] task-06 move 路由未精确校验 body 形状
- **位置**: `src/routes/downloads.ts:507`
- **问题**: POST /:id/move 直接把 request.body 传给 moveDownload，路由层没有校验 body 必须且只能包含 targetSubdirectory。当前服务实现还显式接受包含额外字段的对象，因此 {"targetSubdirectory":"a","extra":1} 会被放行。
- **建议**: 在 routes/downloads.ts 增加最小的 parseMoveInput：要求普通对象、Object.keys 恰好为 ["targetSubdirectory"]，值只做 null/string 形状检查后透传给服务。
- **最终裁定**: 需修（原因：不修复时 move 接口会接受未知字段，破坏 task-06 的精确输入契约，客户端传错字段也会被当作成功请求处理。）

### [blocker] channel targetSubdirectory 未在服务层校验
- **位置**: `src/services/download.ts:509`
- **问题**: createChannelDownloads/prepareChannelDownloads 接收 targetSubdirectory 后直接写入 PreparedDownload，并在 enqueueDownloads 中传给 worker；只有 direct 和 move 路径调用 validateTargetSubdirectory，channel 路径没有校验 '.', '..', 空段或空字符串。
- **建议**: 在 createChannelDownloads 或 prepareChannelDownloads 入口把非 null 值统一转为 validateTargetSubdirectory(targetSubdirectory)，再写库和入队。
- **最终裁定**: 需修（原因：不修复时 /api/downloads/channel 可以接受非法子目录并创建 pending 下载记录，worker 执行时才失败或把空字符串等非契约值写入 target_subdirectory。）

### [blocker] task-10 直下载页缺少移动入口
- **位置**: `src/public/downloads.js:278`
- **问题**: completed 下载项只渲染 preview 和 download file 按钮，没有渲染移动按钮，也没有 prompt/输入目标文件夹并 POST /api/downloads/:id/move 的逻辑；整个 downloads.js 中没有 /move 调用。
- **建议**: 在 completed 分支增加最小 move 按钮，使用 i18n 文案获取目标子目录，空值转 null，调用 POST /api/downloads/${id}/move，成功后 refreshDownloads。
- **最终裁定**: 需修（原因：不修复时用户无法从直下载页移动已完成下载，task-10 要求的 move 功能在页面上不可用。）

### [blocker] moveDownload 拒绝 null 目标子目录
- **位置**: `src/services/download.ts:1347`
- **问题**: moveDownload 要求 raw.targetSubdirectory 必须是 string，导致 {"targetSubdirectory":null} 被 VALIDATION_ERROR 拒绝；需求上下文定义 move body 为 { targetSubdirectory: string | null }，null 表示移动到根目录。
- **建议**: 把 MoveDownloadInput.targetSubdirectory 改为 string | null，并按 newSubdir ?? '' 计算目标目录；非 null 时再调用 validateTargetSubdirectory。
- **最终裁定**: 需修（原因：不修复时已移动到子目录的 completed 下载无法通过 API 移回根目录，直下载页若按空输入提交 null 会直接失败。）

### [blocker] move 目标已存在时空目录会被覆盖
- **位置**: `src/services/download.ts:1435`
- **问题**: moveDownload 直接 rename(currentArchiveDir, newArchiveDir)，只在 rename 抛 EEXIST 时映射 DOWNLOAD_MOVE_TARGET_EXISTS。在当前 macOS/Node 环境下，把目录 rename 到已存在的空目录会成功，因此空的目标 downloadId 目录不会被拒绝。
- **建议**: 在 rename 前用 mkdir(newArchiveDir) 或 lstat/access 明确检测目标 downloadId 目录不存在；已存在时抛 DOWNLOAD_MOVE_TARGET_EXISTS，再执行 rename。
- **最终裁定**: 需修（原因：不修复时目标目录已经存在但为空时 move 会成功，违反目标存在必须 409 的契约，并会删除原有空目标目录。）

### [blocker] task-12 目标已存在用例断言了错误错误码
- **位置**: `test/integration/download-service.test.ts:1184`
- **问题**: task-05 契约要求移动目标目录已存在时返回 DOWNLOAD_MOVE_TARGET_EXISTS，但新增的负向用例把同一场景断言为 DOWNLOAD_MOVE_FAILED，测试会接受错误实现。
- **建议**: 将该断言改为 DOWNLOAD_MOVE_TARGET_EXISTS；如果当前服务实现不能通过该断言，应在 moveDownload 中把目标目录已存在场景修正为专用错误码。
- **最终裁定**: 需修（原因：不修复时目标冲突会继续以通用移动失败暴露，客户端无法按目标已存在的专用错误和文案处理，task-09/task-12 对移动负向契约的覆盖失效。）

### [blocker] task-05 未完整实现
- **位置**: `src/services/download.ts:1435`
- **问题**: moveDownload 未在 rename 前显式检查目标 downloadId 目录是否已存在，目标非空目录会落到 DOWNLOAD_MOVE_FAILED，空目录还可能被 rename 覆盖，不符合目标已存在必须抛 DOWNLOAD_MOVE_TARGET_EXISTS 的契约。
- **建议**: 在 rename 前检查 newArchiveDir 是否已存在，存在时直接抛 BusinessError('DOWNLOAD_MOVE_TARGET_EXISTS', ...)，再执行 mkdir 父目录和 rename。
- **最终裁定**: 需修（原因：目标目录冲突无法稳定返回契约错误码，且存在覆盖空目标目录的风险。）

### [blocker] task-07 未完整实现
- **位置**: `src/public/downloads.js:289`
- **问题**: completed 下载项操作区只渲染预览和下载文件按钮，没有新增移动按钮，也没有弹出输入并 POST /api/downloads/:id/move。
- **建议**: 在 completed 分支新增移动按钮，使用 i18n 文案弹出目标子目录输入，提交 POST /api/downloads/${download.id}/move，成功后刷新列表。
- **最终裁定**: 需修（原因：用户无法从直下载页移动已完成下载，task-05 的移动能力没有页面入口。）

### [blocker] task-09 未完整实现
- **位置**: `test/integration/download-service.test.ts:1184`
- **问题**: move 目标目录已存在的负向用例断言为 DOWNLOAD_MOVE_FAILED，而 task-05 契约要求该场景必须是 DOWNLOAD_MOVE_TARGET_EXISTS。
- **建议**: 将目标已存在测试断言改为 DOWNLOAD_MOVE_TARGET_EXISTS，并覆盖空目标目录和非空目标目录均不能被移动覆盖。
- **最终裁定**: 需修（原因：测试没有证明目标目录冲突的契约错误码，当前错误实现仍可通过测试。）
