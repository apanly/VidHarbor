# v0.5 bugfix

## bugfix-01 · task-09 测试更新未完成

- 关联 task: task-10 (补完 task-07 直下载页), task-11 (清理重格式漂移 + i18n 错误码映射), task-12 (task-09 既有契约测试 + 新增用例), task-13 (parseChannelInput 契约导致的测试失败)
- 来源 task: task-09
- 描述: task-09 worker 超时/中断后未产出 `.cc-drive-agent/runs/v0.5/task-09/result.json`，CLI 标记失败。已留下部分测试与前端/i18n 修改，需要完成 task-09 验收：补齐 `targetSubdirectory` 相关测试、保证必要测试通过，并清理非必要格式漂移。
## bugfix-02 · task-03 未校验子目录真实路径 containment

- 关联 task: task-14
- 来源 review: review-1.md
- 描述: `src/download-worker.ts:497` 这里把 join(realDownloadRoot, targetSubdirectory) 当作 realSubdirectory，但没有在 mkdir 后 realpath 校验真实目录仍位于 realDownloadRoot 内。若下载根目录下已有 targetSubdirectory 对应的符号链接，后续 join(realDownloadRoot, targetSubdirectory, String(downloadId)) 会跟随该链接创建最终归档目录。

## bugfix-03 · task-11 未清理 src/i18n.ts 重格式漂移

- 关联 task: task-15
- 来源 review: review-1.md
- 描述: `src/i18n.ts:1` task-11 要求 src/i18n.ts 回退到干净单引号格式后仅补充 DOWNLOAD_MOVE_* 文案，但当前变更把整个文件从单引号改成双引号并重排多处长行，实际保留了重格式漂移。

## bugfix-04 · task-11 变更集包含范围外 downloads.js 功能改动

- 关联 task: task-16
- 来源 review: review-1.md
- 描述: `src/public/downloads.js:581` task-11 的文件范围是 src/public/channel-detail.js、src/i18n.ts、src/public/i18n.js，且要求不改实际功能；但本批 diff 修改了 direct download 提交体，新增 targetSubdirectory 字段并读取 targetSubdirectory 表单元素，这是 task-07/task-10 的功能行为，不属于 task-11。

## bugfix-05 · task-06 move 路由未精确校验 body 形状

- 关联 task: task-17
- 来源 review: review-1.md
- 描述: `src/routes/downloads.ts:507` POST /:id/move 直接把 request.body 传给 moveDownload，路由层没有校验 body 必须且只能包含 targetSubdirectory。当前服务实现还显式接受包含额外字段的对象，因此 {"targetSubdirectory":"a","extra":1} 会被放行。

## bugfix-06 · channel targetSubdirectory 未在服务层校验

- 关联 task: task-18
- 来源 review: review-1.md
- 描述: `src/services/download.ts:509` createChannelDownloads/prepareChannelDownloads 接收 targetSubdirectory 后直接写入 PreparedDownload，并在 enqueueDownloads 中传给 worker；只有 direct 和 move 路径调用 validateTargetSubdirectory，channel 路径没有校验 '.', '..', 空段或空字符串。

## bugfix-07 · task-10 直下载页缺少移动入口

- 关联 task: task-19
- 来源 review: review-1.md
- 描述: `src/public/downloads.js:278` completed 下载项只渲染 preview 和 download file 按钮，没有渲染移动按钮，也没有 prompt/输入目标文件夹并 POST /api/downloads/:id/move 的逻辑；整个 downloads.js 中没有 /move 调用。

## bugfix-08 · moveDownload 拒绝 null 目标子目录

- 关联 task: task-20
- 来源 review: review-1.md
- 描述: `src/services/download.ts:1347` moveDownload 要求 raw.targetSubdirectory 必须是 string，导致 {"targetSubdirectory":null} 被 VALIDATION_ERROR 拒绝；需求上下文定义 move body 为 { targetSubdirectory: string | null }，null 表示移动到根目录。

## bugfix-09 · move 目标已存在时空目录会被覆盖

- 关联 task: task-21
- 来源 review: review-1.md
- 描述: `src/services/download.ts:1435` moveDownload 直接 rename(currentArchiveDir, newArchiveDir)，只在 rename 抛 EEXIST 时映射 DOWNLOAD_MOVE_TARGET_EXISTS。在当前 macOS/Node 环境下，把目录 rename 到已存在的空目录会成功，因此空的目标 downloadId 目录不会被拒绝。

## bugfix-10 · task-12 目标已存在用例断言了错误错误码

- 关联 task: task-22
- 来源 review: review-1.md
- 描述: `test/integration/download-service.test.ts:1184` task-05 契约要求移动目标目录已存在时返回 DOWNLOAD_MOVE_TARGET_EXISTS，但新增的负向用例把同一场景断言为 DOWNLOAD_MOVE_FAILED，测试会接受错误实现。

## bugfix-11 · task-05 未完整实现

- 关联 task: task-21
- 来源 review: review-1.md
- 描述: `src/services/download.ts:1435` moveDownload 未在 rename 前显式检查目标 downloadId 目录是否已存在，目标非空目录会落到 DOWNLOAD_MOVE_FAILED，空目录还可能被 rename 覆盖，不符合目标已存在必须抛 DOWNLOAD_MOVE_TARGET_EXISTS 的契约。

## bugfix-12 · task-07 未完整实现

- 关联 task: task-19
- 来源 review: review-1.md
- 描述: `src/public/downloads.js:289` completed 下载项操作区只渲染预览和下载文件按钮，没有新增移动按钮，也没有弹出输入并 POST /api/downloads/:id/move。

## bugfix-13 · task-09 未完整实现

- 关联 task: task-22
- 来源 review: review-1.md
- 描述: `test/integration/download-service.test.ts:1184` move 目标目录已存在的负向用例断言为 DOWNLOAD_MOVE_FAILED，而 task-05 契约要求该场景必须是 DOWNLOAD_MOVE_TARGET_EXISTS。


## review-2 说明

- review-2 的 i18n 格式问题复核为误判：`main` 中英文目录本身为长行，本分支 `src/i18n.ts` 仅新增本需求所需翻译键；`npx vitest run test/unit/i18n.test.ts` 已通过。

## bugfix-14 · review-3 i18n 格式漂移复核

- 关联 task: task-23
- 来源 review: review-3.md
- 描述: `src/i18n.ts:313` review-3 判定英文 catalog 仍有格式漂移，要求恢复原有排版并只保留本次翻译键增量。已人工复核并清理前端/服务端格式漂移，保留必要功能改动。

## bugfix-15 · 恢复 moveDownload ponytail 边界注释

- 关联 task: task-24
- 来源 review: review-4.md
- 描述: `src/services/download.ts:1246` review-4 判定 moveDownload 前缺少 task-05 要求保留的 `ponytail:` 无跨进程锁边界注释，需要恢复该注释，说明当前移动依赖进程内串行化，外部 mutator 落地时再补跨进程锁。
