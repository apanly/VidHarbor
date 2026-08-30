# Tasks - v0.5

> 需求：下载支持自定义分类文件夹（Gitea #21）。复用既有列 `downloads.target_subdirectory` / `archive_layout`，无 schema 变更、无 SQL 产物。

## task-01 · 相对子目录校验函数

- 状态: done
- 依赖: 无
- 文件范围:
  - src/filesystem.ts
- 关键约束:
  - 不能另写等价的单路径段校验逻辑，必须逐段复用 `validateChannelName`
  - 不能在函数内做规范化、去空白、`.`/`..` 折叠或任何 fallback
  - 不能处理 `null`（`null` 由调用方外层判定）
- 任务目的: 对应 plan §1.5 target_subdirectory 相对路径校验契约
- 实现入口: src/filesystem.ts `validateChannelName`（约第 55 行，复用）
- 期望行为: 新增导出 `validateTargetSubdirectory(input: string): string`，按 `/` 切分逐段过 `validateChannelName`，全部合法则返回各段 `join('/')`；任一段（含空段/`.`/`..`/绝对前导空段/超长）非法时抛 `BusinessError('VALIDATION_ERROR', ...)`
- 范围边界:
  - 必须: 拒绝绝对路径、`..`、`.`、空段、路径逃逸、超长段
  - 不能: 静默忽略非法段或返回被“修正”后的路径
  - 不做: 不校验目录是否存在、不触碰文件系统
- 验收标准:
  1. `grep -n "export function validateTargetSubdirectory" src/filesystem.ts` → 命中 1 行
  2. `grep -c "validateChannelName" src/filesystem.ts` → ≥ 2（定义 + 复用调用）
  3. `npx tsc -p tsconfig.json --noEmit` → 无新增错误

## task-02 · 新增移动相关错误码

- 状态: done
- 依赖: 无
- 文件范围:
  - src/errors.ts
- 关键约束:
  - 不能修改既有错误码的 HTTP 状态值
  - 不能新增本需求未用到的其它错误码
- 任务目的: 对应 plan §1.6 移动接口的错误处理
- 实现入口: src/errors.ts `ERROR_HTTP_STATUS`（对象字面量）
- 期望行为: `ERROR_HTTP_STATUS` 新增 `DOWNLOAD_MOVE_TARGET_EXISTS: 409` 与 `DOWNLOAD_MOVE_FAILED: 422`
- 范围边界:
  - 必须: 两个码可被 `getHttpStatus` 正确解析
  - 不能: 改动 `toErrorResponse` / `BusinessError` 逻辑
  - 不做: 不新增其它状态码
- 验收标准:
  1. `grep -c "DOWNLOAD_MOVE_TARGET_EXISTS: 409\|DOWNLOAD_MOVE_FAILED: 422" src/errors.ts` → 2
  2. `npx tsc -p tsconfig.json --noEmit` → 无新增错误

## task-03 · 下载 worker 归档到子目录

- 状态: done
- 依赖: task-01
- 文件范围:
  - src/download-worker.ts
  - src/services/download.ts
- 关键约束:
  - 不能改变“每个 downloadId 一个独立目录”约定
  - 不能让 `downloadId` 目录已存在时静默复用（必须仍失败）
  - 不能用绝对路径拼接，subdir 仅相对 realDownloadRoot
- 任务目的: 对应 plan §2「worker 归档到 join(root, subdir, downloadId)」
- 实现入口: src/download-worker.ts `DownloadWorker.#run`（`const targetDirectory = join(realDownloadRoot, String(download.downloadId));` 一行）；src/services/download.ts `QueuedDownload` 接口
- 期望行为: `QueuedDownload` 新增可选 `targetSubdirectory?: string`；`#run` 在 subdir 存在时先 `mkdir(join(realDownloadRoot, subdir), {recursive:true})` 并 `isContained` 校验，再把成品目录设为 `join(realDownloadRoot, subdir, String(downloadId))`；`mkdir(targetDirectory)` 保持非递归，`EEXIST` 仍抛 `'final download directory already exists'`
- 范围边界:
  - 必须: subdir 为 undefined 时行为与现状完全一致
  - 不能: 移除既有 `isContained` 容器校验
  - 不做: 不在 worker 内做 subdir 字符串校验（由 task-01 入口保证）
- 验收标准:
  1. `grep -n "targetSubdirectory" src/services/download.ts` → 命中 `QueuedDownload` 定义
  2. `grep -n "recursive: true" src/download-worker.ts` → 命中新增 subdir mkdir
  3. `npx tsc -p tsconfig.json --noEmit` → 无新增错误

## task-04 · 下载服务：入参解析、落库、重试、删除定位

- 状态: done
- 依赖: task-01, task-03
- 文件范围:
  - src/services/download.ts
- 关键约束:
  - `parseDirectInput` 必须精确匹配 4 键集合（`url,proxyId,advancedOptions,targetSubdirectory`），键不符即报错
  - 不能把 `target_subdirectory` 继续固定写 `NULL`
  - 不能对未知类型的 `targetSubdirectory` 做猜测解析，必须 `VALIDATION_ERROR` 快速失败
  - 删除路径不能丢失对 subdir 的定位（旧 NULL 行为等价根目录）
- 任务目的: 对应 plan §1.1/§1.2 落库与 §3.2 删除/重试改动
- 实现入口: src/services/download.ts `parseDirectInput`(约 200 行)、`insertDownloads`(约 480-510 行 `target_subdirectory ... NULL`)、`PreparedDownload`/`QueuedDownload`/`enqueueDownloads`、`RetryDownloadRow`+`retryDownload`、`DeletingDownloadRow`+`finalizeDeletingDownload`+`deleteDownload`
- 期望行为:
  - 新增 `parseTargetSubdirectory(value): string | null`（null→null；string→`validateTargetSubdirectory`；其它→`VALIDATION_ERROR`）
  - `PreparedDownload` 增 `targetSubdirectory: string | null`；`parseDirectInput` 解析该键；`createDirectDownload`/`prepareChannelDownloads` 写入
  - `insertDownloads` 绑定 `value.targetSubdirectory` 代替固定 `NULL`；`enqueueDownloads` 在非 null 时带入 `QueuedDownload`
  - 重试查询 `SELECT d.target_subdirectory` 并带入重试 `QueuedDownload`
  - `DeletingDownloadRow` 增 `target_subdirectory`；`download_directory` 目录由 `join(root, id)` 改为 `join(root, subdir ?? '', id)`
- 范围边界:
  - 必须: `prepareChannelDownloads` 接收 `targetSubdirectory` 形参并写入每个 PreparedDownload
  - 不能: 引入格式兼容 / 别名 / fallback
  - 不做: 不在此 task 写 move / folders（见 task-05）
- 验收标准:
  1. `grep -n "parseTargetSubdirectory" src/services/download.ts` → ≥ 2（定义+调用）
  2. `grep -n "value.targetSubdirectory" src/services/download.ts` → 命中 `insertDownloads` 绑定
  3. `grep -c "NULL, ?, 'download_directory'" src/services/download.ts` → 0（不再固定 NULL）
  4. `npx tsc -p tsconfig.json --noEmit` → 无新增错误

## task-05 · 下载服务：移动与最近文件夹

- 状态: done
- 依赖: task-01, task-02, task-04
- 文件范围:
  - src/services/download.ts
- 关键约束:
  - 只允许 `completed` + `archive_layout='download_directory'` 移动，其余显式 `VALIDATION_ERROR`
  - `legacy_file` 布局必须拒绝
  - 目标 downloadId 目录已存在必须失败（`DOWNLOAD_MOVE_TARGET_EXISTS`）
  - FS 移动失败或落库 changes≠1 必须尽力回滚 rename 并抛 `DOWNLOAD_MOVE_FAILED`
  - 必须写 `ponytail:` 注释标注无跨进程锁的上限
- 任务目的: 对应 plan §1.3 移动 与 §1.4 最近文件夹
- 实现入口: src/services/download.ts（新增 `moveDownload`、`listDownloadFolders`，复用已 import 的 `rename`/`mkdir`/`realpath`/`basename`/`join`/`dirname` 及 `validateDownloadRoot`）
- 期望行为:
  - `moveDownload(database, downloadsMountPath, downloadId, input)`：校验 downloadId 与 `targetSubdirectory`；加载行；校验状态/布局；校验当前目录=`realpath(dirname(output_path))`；目标目录相同→`VALIDATION_ERROR`；目标已存在→`DOWNLOAD_MOVE_TARGET_EXISTS`；`mkdir(join(root,新subdir),{recursive:true})`→`rename`→用 `basename` 重算 `output_path`/`thumbnail_path` 并 `UPDATE ... WHERE id=? AND status='completed'`，`changes≠1` 回滚 rename 并抛 `DOWNLOAD_MOVE_FAILED`
  - `listDownloadFolders(database): string[]`：`SELECT target_subdirectory FROM downloads WHERE target_subdirectory IS NOT NULL GROUP BY target_subdirectory ORDER BY MAX(id) DESC LIMIT 20`
- 范围边界:
  - 必须: 移动后 output_path/thumbnail_path/target_subdirectory 三者一致更新
  - 不能: 对同名不同类型输入做兜底；不能吞掉 FS 错误
  - 不做: 不引入状态过渡列（deleting 式机制），以 ponytail 注释记录上限
- 验收标准:
  1. `grep -n "export async function moveDownload" src/services/download.ts` → 命中 1 行
  2. `grep -n "export function listDownloadFolders\|export async function listDownloadFolders" src/services/download.ts` → 命中 1 行
  3. `grep -n "ponytail:" src/services/download.ts` → 命中 1 行
  4. `npx tsc -p tsconfig.json --noEmit` → 无新增错误

## task-06 · 路由：channel 入参、move、folders、snapshot 字段

- 状态: done
- 依赖: task-04, task-05
- 文件范围:
  - src/routes/downloads.ts
- 关键约束:
  - `parseChannelInput` 必须精确匹配 3 键集合（`videoIds,proxyId,targetSubdirectory`）
  - `GET /folders` 必须注册在 `/:id` 之前，避免被参数路由吞掉
  - 不能给 move 路由放行空/未知 body 形状之外的输入
- 任务目的: 对应 plan §3.2 路由改动
- 实现入口: src/routes/downloads.ts `parseChannelInput`(约 190 行)、`createDownloadsRouter`(路由注册段)、`DownloadRow`+`toDownloadSnapshot`(约 210-250 行)
- 期望行为:
  - `parseChannelInput` 解析并透传 `targetSubdirectory`，`createChannelDownloads` 调用带上该值
  - 新增 `router.get('/folders', ...)` → `listDownloadFolders`，返回 `{ folders }`；注册在 `/:id` 之前
  - 新增 `router.post('/:id/move', ...)` → `moveDownload`，成功 `204`
  - `DownloadRow` 查询增加 `target_subdirectory`，`toDownloadSnapshot` 输出 `targetSubdirectory`
- 范围边界:
  - 必须: move 路由解析 body `{ targetSubdirectory }` 后调用服务
  - 不能: 在路由层重复实现 subdir 字符串校验（由服务层保证）
  - 不做: 不改动既有 media/file/thumbnail/cancel/retry/delete 路由行为
- 验收标准:
  1. `grep -n "'/folders'" src/routes/downloads.ts` → 命中，且行号早于 `'/:id'` 的 get 注册
  2. `grep -n "/:id/move" src/routes/downloads.ts` → 命中 1 行
  3. `grep -n "targetSubdirectory: row.target_subdirectory" src/routes/downloads.ts` → 命中 snapshot 映射
  4. `npx tsc -p tsconfig.json --noEmit` → 无新增错误

## task-07 · UI：直下载页文件夹输入与移动入口

- 状态: done
- 依赖: task-06
- 文件范围:
  - src/views/downloads.ejs
  - src/public/downloads.js
  - src/i18n.ts
- 关键约束:
  - 直下载提交必须带 `targetSubdirectory`（空输入映射为 `null`）
  - 移动入口只对 `completed` 项渲染
  - 不能新增未在 i18n 定义的裸文案（须走 `t()`）
- 任务目的: 对应 plan §3.2 UI（直下载页）
- 实现入口: src/views/downloads.ejs 直下载表单 `name="url"` 段；src/public/downloads.js 直下载 `form.addEventListener('submit')`（文件末尾）、`renderActions`（completed 分支）、`load()`；src/i18n.ts 文案表
- 期望行为:
  - 表单新增 `name="targetSubdirectory"` 输入框 + 关联 `<datalist>`；`load()` 拉取 `/api/downloads/folders` 填充 datalist
  - 提交体加入 `targetSubdirectory`（空→`null`）
  - completed 项操作区新增“移动”按钮，弹出输入 → `POST /api/downloads/:id/move`，成功刷新
  - i18n 新增：保存到文件夹标签/占位、移动、移动确认/输入、目标已存在等键
- 范围边界:
  - 必须: 空文件夹输入提交 `null`，保持根目录行为
  - 不能: 破坏既有直下载字段与高级选项结构
  - 不做: 不做文件夹管理页 / 目录树浏览
- 验收标准:
  1. `grep -c 'name="targetSubdirectory"' src/views/downloads.ejs` → 1
  2. `grep -n "/api/downloads/folders" src/public/downloads.js` → 命中
  3. `grep -n "/move" src/public/downloads.js` → 命中移动请求
  4. `npx vitest run test/unit/i18n.test.ts` → 通过

## task-08 · UI：频道详情页文件夹输入

- 状态: done
- 依赖: task-06
- 文件范围:
  - src/views/channel-detail.ejs
  - src/public/channel-detail.js
  - src/i18n.ts
- 关键约束:
  - 频道下载提交必须带 `targetSubdirectory`（空→`null`）
  - 不能新增未在 i18n 定义的裸文案
- 任务目的: 对应 plan §3.2 UI（频道页）
- 实现入口: src/views/channel-detail.ejs 下载工具条（`channel-video-toolbar`，约 20-30 行）；src/public/channel-detail.js 下载 `form.addEventListener('submit')`（约 236-247 行）、`load()`
- 期望行为:
  - 工具条新增 `name="targetSubdirectory"` 输入框 + datalist；`load()` 拉取 `/api/downloads/folders` 填充
  - 提交体 `{ videoIds, proxyId, targetSubdirectory }`（空→`null`）
- 范围边界:
  - 必须: 空输入提交 `null`
  - 不能: 改动 proxyId 既有选择逻辑
  - 不做: 不加目录浏览
- 验收标准:
  1. `grep -c 'name="targetSubdirectory"' src/views/channel-detail.ejs` → 1
  2. `grep -n "targetSubdirectory" src/public/channel-detail.js` → 命中提交体
  3. `npx tsc -p tsconfig.json --noEmit` → 无新增错误

## task-09 · 测试：更新既有契约测试并补新用例

- 状态: done
- 依赖: task-01, task-04, task-05, task-06, task-07
- 文件范围:
  - test/integration/pages.test.ts
  - test/integration/download-service.test.ts
  - test/integration/download-worker.test.ts
  - test/unit/filesystem.test.ts (新建)
- 关键约束:
  - 必须更新命中新字段的既有断言（`name="targetSubdirectory"` 不存在、直下载 POST 体形状、`directInput` 助手）
  - 测试必须包含负向用例（`..`/空段/绝对/超长、move 目标已存在、非 completed 不可移动）
  - 不能为了让旧断言通过而回退功能
- 任务目的: 对应 plan §3.2 测试与 §2 验收标准
- 实现入口: test/integration/pages.test.ts（约 1177、1210 行断言）；test/integration/download-service.test.ts `directInput` 助手（约 48 行）；test/integration/download-worker.test.ts；新建 test/unit/filesystem.test.ts
- 期望行为:
  - 更新 pages.test.ts：断言直下载/频道表单含 `name="targetSubdirectory"`，直下载提交体含 `targetSubdirectory`
  - 更新 download-service.test.ts：`directInput` 与 channel 输入补 `targetSubdirectory`；新增 move / folders / 含 subdir 删除用例
  - 更新 download-worker.test.ts：subdir 目录自动创建、`downloadId` 目录已存在失败
  - 新建 filesystem.test.ts：`validateTargetSubdirectory` 正向与负向
- 范围边界:
  - 必须: 负向用例证明“不支持什么”
  - 不能: 引入新测试框架 / fixture 体系
  - 不做: 不做端到端浏览器测试
- 验收标准:
  1. `grep -rn "validateTargetSubdirectory" test/unit/filesystem.test.ts` → 命中
  2. `grep -n "targetSubdirectory" test/integration/pages.test.ts` → 命中（含正向断言）
  3. `npx vitest run` → 全绿

## task-10 · 补完 task-07 直下载页 targetSubdirectory / move / folders

- 状态: done
- 依赖: task-01, task-04, task-05, task-06
- 文件范围:
  - src/views/downloads.ejs
  - src/public/downloads.js
  - src/i18n.ts
- 关键约束:
  - 这是 task-07 的未完成部分：`src/views/downloads.ejs` 与 `src/public/downloads.js` 目前**零** targetSubdirectory / `/move` / `/folders` 逻辑（`grep -c` 结果均为 0），但 task-09 验收要求 `pages.test.ts` 断言**直下载表单含 `name="targetSubdirectory"`、直下载 POST 体含 `targetSubdirectory`**，故直下载页功能必须实际存在，测试才成立
  - 参照 channel-detail.ejs（已实现）的做法：工具条加 `targetSubdirectory` 输入框 + datalist（`/api/downloads/folders` 填充）；`downloads.js` 提交体带 `targetSubdirectory`（空→null）、接 `/move`、`/folders`、subdir 删除
  - 不能新增未在 i18n 定义的裸文案；新增文案写入 `src/i18n.ts` 的 zhCN/enUS
- 任务目的: 对应 plan §3.2 UI（直下载页），补全 task-07 未实现的入口，使 task-09 验收可用的功能先存在
- 实现入口: src/views/downloads.ejs 直下载工具条；src/public/downloads.js `form.addEventListener('submit')`、`load()`
- 期望行为:
  - 直下载页新增 `name="targetSubdirectory"` 输入框 + datalist；`load()` 拉 `/api/downloads/folders` 填充
  - 提交体 `{ videoIds, targetSubdirectory }`（空→null）；实现 `/move`（生成归档 zip）、`/folders`（目录列表）、subdir 删除
  - `src/i18n.ts` 补充对应 zhCN/enUS 文案
- 范围边界:
  - 必须: 空输入提交 null；直下载页可提交 targetSubdirectory
  - 不能: 改动 proxyId 既有选择逻辑；直下载页加目录浏览对话框
  - 不做: 不在本任务写测试（归 task-12）
- 验收标准:
  1. `grep -c 'name="targetSubdirectory"' src/views/downloads.ejs` → 命中
  2. `grep -n "targetSubdirectory" src/public/downloads.js` → 命中提交体与 `/move` `/folders`

## task-11 · 清理重格式漂移 + 补 i18n 错误码映射

- 状态: done
- 依赖: task-09
- 文件范围:
  - src/public/channel-detail.js
  - src/i18n.ts
  - src/public/i18n.js
- 关键约束:
  - **重格式漂移**：`src/public/channel-detail.js` 的未提交改动几乎全部是单引号→双引号、长行换行的重格式化（`git diff -w` 仅余 targetSubdirectory 内容，而 HEAD 已含 targetSubdirectory → 整个改动即纯漂移）。它导致两处失败：① `i18n.test.ts` 的 `t()` 解析器在多行 `t(fixedValue(...))` 的换行中引入 depth-0 尾逗号而抛错；② `pages.test.ts` 以单引号字符模式 grep 该文件而失败。**修复方式**：`src/public/channel-detail.js` 直接回退到 HEAD（HEAD 已含 targetSubdirectory 且为干净单引号格式）。
  - `src/i18n.ts` 同样存在单引号→双引号重格式漂移，需回退干净格式；并补全 task-02 漏接的错误码：zhCN/enUS 目录缺少 `error.DOWNLOAD_MOVE_FAILED` 与 `error.DOWNLOAD_MOVE_TARGET_EXISTS`（`git show HEAD:src/i18n.ts` grep 为 0）。
  - **i18n 错误码映射缺口**（task-02 遗留、HEAD 即存在、与格式漂移无关）：`src/public/i18n.js` 的 `API_ERROR_KEYS` 缺 `DOWNLOAD_MOVE_FAILED`/`DOWNLOAD_MOVE_TARGET_EXISTS`，而 `src/errors.ts` 的 `ERROR_HTTP_STATUS` 含此二键（30 键）。`i18n.test.ts > maps every current API error code` 断言 `Object.keys(API_ERROR_KEYS).sort() === Object.keys(ERROR_HTTP_STATUS).sort()`。须在 `API_ERROR_KEYS` 补这两键，并在 `i18n.ts` 目录补对应文案，`formatApiError` 才不返回 undefined。
- 任务目的: 对应 task-09 验收（清理非必要格式漂移 + 保证必要测试通过，i18n 相关）
- 实现入口: src/public/channel-detail.js（回退 HEAD）；src/i18n.ts（回退重格式 + 补文案）；src/public/i18n.js `API_ERROR_KEYS`
- 期望行为:
  - `src/public/channel-detail.js` 回退 HEAD，`git diff` 清空
  - `src/i18n.ts` 回退干净单引号格式并补 `error.DOWNLOAD_MOVE_*` 文案
  - `src/public/i18n.js` 的 `API_ERROR_KEYS` 补 `DOWNLOAD_MOVE_FAILED`（422）与 `DOWNLOAD_MOVE_TARGET_EXISTS`（409）
- 范围边界:
  - 必须: 三重文件回归干净且保留 targetSubdirectory / 错误码
  - 不能: 为回退改动任何实际功能
  - 不做: 不在本任务改动测试文件
- 验收标准:
  1. `git diff --stat src/public/channel-detail.js` → 无改动
  2. `npx vitest run test/unit/i18n.test.ts` → 全绿（含“maps every current API error code”）

## task-12 · 补并修正 task-09 既有契约测试 + 新增用例

- 状态: done
- 依赖: task-10, task-11
- 文件范围:
  - test/integration/pages.test.ts
  - test/integration/download-service.test.ts
  - test/integration/download-worker.test.ts
  - test/unit/filesystem.test.ts
- 关键约束:
  - **task-09 未完成（根因）**：「在配置时间不到一分钟时线程池 worker 超时退出，任务被打断未完成（前端与 i18n 测试已部分提交但未完成，无 result.json）」。本次按同一需求补齐并保证通过。
  - `pages.test.ts`：当前 2 个失败来自 channel-detail.js 重格式漂移（回退后自动修复，归 task-11）；其余按 task-09 期望行为修正 —— 断言直下载/频道表单含 `name="targetSubdirectory"`（需 task-10 功能已存在）、直下载提交体含 `targetSubdirectory`。
  - `download-service.test.ts`：`directInput` 助手与 channel 输入补 `targetSubdirectory`；新增 move / folders / 含 subdir 删除用例；当前该文件虽因重格式漂移存在但**未测**新功能，需补齐。
  - `download-worker.test.ts`：新增 subdir 目录自动创建、`downloadId` 目录已存在即失败的用例。
  - `filesystem.test.ts`：新建（或在现有文件补）`validateTargetSubdirectory` 的**正向 + 负向**（`..`、空段、绝对路径、超长）。
  - 必须包含负向用例证明“不支持什么”；不能为了让旧断言通过而回退功能（task-07 的直下载页功能先由 task-10 补齐）。
- 任务目的: 对应 task-09 明确的需求——更新既有契约测试、补新用例、覆盖 targetSubdirectory
- 实现入口: test/integration/pages.test.ts（约 1177、1210 行断言）；test/integration/download-service.test.ts `directInput` 助手（约 48 行）；test/integration/download-worker.test.ts；test/unit/filesystem.test.ts
- 期望行为:
  - 更新 pages.test.ts：直下载/频道表单含 `name="targetSubdirectory"`、直下载提交体含 `targetSubdirectory`
  - 更新 download-service.test.ts：`directInput` 与 channel 输入补 `targetSubdirectory`；新增 move / folders / 含 subdir 删除用例
  - 更新 download-worker.test.ts：subdir 目录自动创建、`downloadId` 目录已存在失败
  - 新建/补 filesystem.test.ts：`validateTargetSubdirectory` 正向与负向
- 范围边界:
  - 必须: 负向用例；targetSubdirectory 在各层的覆盖
  - 不能: 引入新测试框架 / fixture 体系
  - 不做: 不做端到端浏览器测试；不动 download-api.test.ts / server-lifecycle.test.ts（归 task-13）
- 验收标准:
  1. `grep -rn "validateTargetSubdirectory" test/unit/filesystem.test.ts` → 命中
  2. `grep -n "targetSubdirectory" test/integration/pages.test.ts` → 命中（含正向断言）
  3. `npx vitest run` → 全绿

## task-13 · 修正 parseChannelInput 契约导致的全局测试失败

- 状态: done
- 依赖: task-06
- 文件范围:
  - test/integration/download-api.test.ts
  - test/integration/server-lifecycle.test.ts
- 关键约束:
  - **同根因**：`src/routes/downloads.ts` 的 `parseChannelInput` 要求请求体**精确匹配三键集合 `[videoIds, proxyId, targetSubdirectory]`**（task-06 契约）。`download-api.test.ts`（11 失败）与 `server-lifecycle.test.ts`（2 失败）中的 channel 提交测试体缺少 `targetSubdirectory`，导致 `parseChannelInput` 先因形状不匹配返回 400，而非预期的 202；其中 `download-api.test.ts` 第 524 行（unknown proxy → 期望 404）也因此在代理校验之前先触发 400。
  - 这是 task-06 契约变更（done）后**既有测试未同步**的遗留；task-09 未完成时未被补上。修复方向是**更新测试体**补 `targetSubdirectory`（空→null），而非削弱 `parseChannelInput` 契约（契约是 design 硬要求，task-06 §3.2）。
  - 两文件的失败是同一根因（channel 提交体缺键），按“同根因合并”处理为单一任务。
- 任务目的: 保证必要测试通过（task-09 验收之“全绿”），同步 task-06 契约
- 实现入口: test/integration/download-api.test.ts（channel 提交助手、unknown proxy 用例）；test/integration/server-lifecycle.test.ts（channel 提交用例）
- 期望行为:
  - 两处 channel 提交测试体补 `targetSubdirectory`，故发送 202 且 unknown proxy 经代理校验返回 404
- 范围边界:
  - 必须: 三键集合契约不变，测试体对齐契约
  - 不能: 改 `parseChannelInput` 放宽校验
  - 不做: 不动非 contract 无关的失败项
- 验收标准:
  1. `npx vitest run test/integration/download-api.test.ts test/integration/server-lifecycle.test.ts` → 全绿

## task-14 · worker 归档子目录 mkdir 后 realpath containment

- 状态: done
- 依赖: 无
- 文件范围:
  - src/download-worker.ts
- 关键约束:
  - 描述原文：`src/download-worker.ts:497` 这里把 join(realDownloadRoot, targetSubdirectory) 当作 realSubdirectory，但没有在 mkdir 后 realpath 校验真实目录仍位于 realDownloadRoot 内。若下载根目录下已有 targetSubdirectory 对应的符号链接，后续 join(realDownloadRoot, targetSubdirectory, String(downloadId)) 会跟随该链接创建最终归档目录。
  - 源码确认：`#run` 在 `targetSubdirectory !== undefined` 时先 `join(realDownloadRoot, targetSubdirectory)` 赋给 `realSubdirectory`，只做字符串级 `isContained`，再 `mkdir(..., { recursive: true })`；本文件已有 `ensureDirectoryWithin`（约第 172 行）会 `realpath` + `stat` + `isContained`
  - 不能另写一套 containment 实现，必须复用已有 `ensureDirectoryWithin`
  - 不能让 `downloadId` 目录已存在时静默复用（`mkdir(targetDirectory)` 保持非递归，`EEXIST` 仍抛 `'final download directory already exists'`）
  - 不能用未经 realpath 的 `join(realDownloadRoot, targetSubdirectory, String(downloadId))` 作为成品目录
- 任务目的: 修复 bugfix-02 描述的问题
- 实现入口: src/download-worker.ts `#run` 归档段（约第 495–508 行，`const realSubdirectory = join(realDownloadRoot, targetSubdirectory)`）；复用同文件 `ensureDirectoryWithin`
- 期望行为: subdir 存在时先 `mkdir(join(realDownloadRoot, targetSubdirectory), { recursive: true })`，再 `ensureDirectoryWithin` 得到真实子目录；成品目录为 `join(真实子目录, String(downloadId))`。若真实子目录不在 `realDownloadRoot` 内则抛错，不在 root 外创建归档。`targetSubdirectory === undefined` 时行为与现状完全一致
- 范围边界:
  - 必须: mkdir 之后用 realpath 校验真实子目录仍位于 realDownloadRoot 内，并用该真实路径拼接 downloadId
  - 不能: 改动与本 bug 无关的模块；不能移除既有 `isContained` / `ensureDirectoryWithin`；不能在 worker 内做 subdir 字符串校验
  - 不做: 不改 `src/services/download.ts` 的 move/delete 路径；不改校验函数 `validateTargetSubdirectory`
- 验收标准:
  1. `grep -c "ensureDirectoryWithin" src/download-worker.ts` → ≥ 4（定义 + createTaskDirectory 两处 + `#run` 归档新增）
  2. `grep -n "recursive: true" src/download-worker.ts` → 仍命中 subdir mkdir
  3. `npx tsc -p tsconfig.json --noEmit` → 无新增错误

## task-15 · 回退 src/i18n.ts 重格式漂移并保留 DOWNLOAD_MOVE_* 文案

- 状态: done
- 依赖: 无
- 文件范围:
  - src/i18n.ts
- 关键约束:
  - 描述原文：`src/i18n.ts:1` task-11 要求 src/i18n.ts 回退到干净单引号格式后仅补充 DOWNLOAD_MOVE_* 文案，但当前变更把整个文件从单引号改成双引号并重排多处长行，实际保留了重格式漂移。
  - 旧 task: task-11，旧状态: done。旧约束：回退干净单引号格式并补 `error.DOWNLOAD_MOVE_FAILED` 与 `error.DOWNLOAD_MOVE_TARGET_EXISTS` 的 zhCN/enUS 文案；不能为回退改动任何实际功能；不做测试文件改动。旧期望：`src/i18n.ts` 回退干净单引号格式并补 `error.DOWNLOAD_MOVE_*` 文案。旧验收：`npx vitest run test/unit/i18n.test.ts` 全绿。
  - 源码确认：基线 `git show 594ee43:src/i18n.ts`（task-08，含 `channelDetail.targetSubdirectory*`）为单引号；HEAD 整文件改为双引号并重排长行，同时已含 `error.DOWNLOAD_MOVE_TARGET_EXISTS` / `error.DOWNLOAD_MOVE_FAILED`
  - 不能删除或改写任何现有翻译键（含 `channelDetail.targetSubdirectory*` 与 `error.DOWNLOAD_MOVE_*`）
  - 不能把其它文件（`src/public/i18n.js`、`src/public/channel-detail.js`、`src/public/downloads.js`）一并重格式
- 任务目的: 修复 bugfix-03 描述的问题
- 实现入口: src/i18n.ts 文件开头 `export const LANGUAGES` 与 zhCN/enUS 目录字面量
- 期望行为: `src/i18n.ts` 恢复任务基线的单引号字符串格式（与 task-08 基线一致的引号风格），仅保留必要文案增量：`error.DOWNLOAD_MOVE_TARGET_EXISTS` 与 `error.DOWNLOAD_MOVE_FAILED` 的中英文；键集合与 HEAD 功能文案一致，不再整文件双引号化或无关长行重排
- 范围边界:
  - 必须: 单引号格式 + 保留两则 DOWNLOAD_MOVE 文案（zhCN 与 enUS 各一条）
  - 不能: 改动与本 bug 无关的模块；不能删改其它翻译键或译文含义
  - 不做: 不改 `src/public/i18n.js` 的 `API_ERROR_KEYS`（HEAD 已含此二键）；不改测试文件
- 验收标准:
  1. `grep -n "export const LANGUAGES = \\['zh-CN'" src/i18n.ts` → 命中 1 行
  2. `grep -c "error.DOWNLOAD_MOVE_TARGET_EXISTS" src/i18n.ts` → 2；`grep -c "error.DOWNLOAD_MOVE_FAILED" src/i18n.ts` → 2
  3. `npx vitest run test/unit/i18n.test.ts` → 全绿（含“maps every current API error code”）

## task-16 · 还原 task-11 对 downloads.js 的范围外格式改动

- 状态: done
- 依赖: 无
- 文件范围:
  - src/public/downloads.js
- 关键约束:
  - 描述原文：`src/public/downloads.js:581` task-11 的文件范围是 src/public/channel-detail.js、src/i18n.ts、src/public/i18n.js，且要求不改实际功能；但本批 diff 修改了 direct download 提交体，新增 targetSubdirectory 字段并读取 targetSubdirectory 表单元素，这是 task-07/task-10 的功能行为，不属于 task-11。
  - 旧 task: task-11，旧状态: done。旧约束：文件范围仅 channel-detail.js / i18n.ts / i18n.js，不能改实际功能。
  - 源码确认：task-11 提交 `5a442e5` 对 `src/public/downloads.js` 仅删除了 `t(... "downloads.source.direct")` 的尾逗号（约第 416–419 行）；直下载提交体 `targetSubdirectory` 与 `load()` 拉取 `/api/downloads/folders` 来自已完成的 task-10，必须保留。审查所指向的第 581 行提交体不是 task-11 引入的功能，不能当范围外功能删掉。
  - 不能删除或改写直下载 POST 体的 `targetSubdirectory`、`/api/downloads/folders` datalist 填充、preview/download 按钮
- 任务目的: 修复 bugfix-04 描述的问题
- 实现入口: src/public/downloads.js `updateDownloadCard` 内 `t(download.sourceType === "channel" ? "downloads.source.channel" : "downloads.source.direct")`（约第 413–420 行）
- 期望行为: 恢复 task-11 之前的尾逗号写法（`"downloads.source.direct",`）；直下载提交仍为 `targetSubdirectory: nullableText(form.elements.targetSubdirectory.value)`，`load()` 仍请求 `/api/downloads/folders`
- 范围边界:
  - 必须: 去掉 task-11 引入的 downloads.js 格式改动
  - 不能: 改动与本 bug 无关的模块；不能移除 task-10 的 targetSubdirectory / folders 功能
  - 不做: 不在本任务加移动按钮（归 task-19）；不改 i18n.ts
- 验收标准:
  1. `grep -n 'downloads.source.direct' src/public/downloads.js` → 命中且该 `t()` 调用的 `"downloads.source.direct"` 后带尾逗号
  2. `grep -n "targetSubdirectory: nullableText" src/public/downloads.js` → 命中提交体
  3. `grep -n "/api/downloads/folders" src/public/downloads.js` → 命中

## task-17 · move 路由精确校验 body 形状

- 状态: done
- 依赖: 无
- 文件范围:
  - src/routes/downloads.ts
- 关键约束:
  - 描述原文：`src/routes/downloads.ts:507` POST /:id/move 直接把 request.body 传给 moveDownload，路由层没有校验 body 必须且只能包含 targetSubdirectory。当前服务实现还显式接受包含额外字段的对象，因此 {"targetSubdirectory":"a","extra":1} 会被放行。
  - 对照 task-06 契约：不能给 move 路由放行空/未知 body 形状之外的输入；plan §1.6 未知输入键必须精确键集合校验
  - 值只做 `null` / `string` 形状检查后透传；不能在路由层重复实现 subdir 字符串校验（`.` / `..` / 空段由服务层保证）
  - 不能把 request.body 原样传给 moveDownload
- 任务目的: 修复 bugfix-05 描述的问题
- 实现入口: src/routes/downloads.ts `router.post('/:id/move', ...)`（约第 507 行）；参照同文件 `parseChannelInput` / `assertEmptyBody`
- 期望行为: 新增 `parseMoveInput`：普通对象、`Object.keys` 恰好为 `['targetSubdirectory']`，值仅为 `null` 或 `string`，否则 `VALIDATION_ERROR`；路由把解析结果传给 `moveDownload`。`{"targetSubdirectory":"a","extra":1}`、缺键、空对象均 400。成功仍 204
- 范围边界:
  - 必须: move body 精确单键 `targetSubdirectory`，值类型 `string | null`
  - 不能: 改动与本 bug 无关的模块；不能改 `parseChannelInput` 三键契约；不能在路由层调用 `validateTargetSubdirectory`
  - 不做: 不改 `moveDownload` 对 null 的业务语义（归 task-20）；不改其它路由
- 验收标准:
  1. `grep -n "function parseMoveInput" src/routes/downloads.ts` → 命中 1 行
  2. `grep -n "parseMoveInput(request.body)" src/routes/downloads.ts` → 命中 1 行
  3. `npx tsc -p tsconfig.json --noEmit` → 无新增错误

## task-18 · channel 路径在服务层校验 targetSubdirectory

- 状态: done
- 依赖: 无
- 文件范围:
  - src/services/download.ts
- 关键约束:
  - 描述原文：`src/services/download.ts:509` createChannelDownloads/prepareChannelDownloads 接收 targetSubdirectory 后直接写入 PreparedDownload，并在 enqueueDownloads 中传给 worker；只有 direct 和 move 路径调用 validateTargetSubdirectory，channel 路径没有校验 '.', '..', 空段或空字符串。
  - plan §1.5：所有写入 `target_subdirectory` 的入口（直下载、频道下载、移动）统一校验；`null` 合法表示根目录；string 必须过 `validateTargetSubdirectory`
  - 不能把 `parseTargetSubdirectory` 的 `'invalid direct download input'` 错误文案套到 channel 路径而不经确认；channel 非 null 值直接 `validateTargetSubdirectory(targetSubdirectory)`
  - 不能对未知类型做猜测解析或 fallback；不能静默把 `''` / `'.'` / `'..'` 写入列
- 任务目的: 修复 bugfix-06 描述的问题
- 实现入口: src/services/download.ts `prepareChannelDownloads`（约第 503–509 行形参 `targetSubdirectory: string | null = null`）或 `createChannelDownloads`（约第 674 行）入口
- 期望行为: `prepareChannelDownloads` / `createChannelDownloads` 在写 `PreparedDownload` 之前：`null` 保持 `null`；非 `null` 的 string 经 `validateTargetSubdirectory` 后再写入并入队。`'.'`、`'..'`、空字符串、空段、绝对路径抛 `VALIDATION_ERROR`，不创建 pending 行
- 范围边界:
  - 必须: channel 路径与 direct/move 一样拒绝非法相对路径
  - 不能: 改动与本 bug 无关的模块；不能放宽 `validateTargetSubdirectory`；不能引入别名/规范化
  - 不做: 不改路由 `parseChannelInput` 的三键形状校验；不改 worker
- 验收标准:
  1. `grep -n "validateTargetSubdirectory" src/services/download.ts` → ≥ 3（import + move + channel 入口）
  2. `npx tsc -p tsconfig.json --noEmit` → 无新增错误

## task-19 · 直下载页 completed 项增加移动入口

- 状态: done
- 依赖: task-15, task-16, task-20
- 文件范围:
  - src/public/downloads.js
  - src/i18n.ts
- 关键约束:
  - 描述原文（bugfix-07）：`src/public/downloads.js:278` completed 下载项只渲染 preview 和 download file 按钮，没有渲染移动按钮，也没有 prompt/输入目标文件夹并 POST /api/downloads/:id/move 的逻辑；整个 downloads.js 中没有 /move 调用。
  - 描述原文（bugfix-12）：`src/public/downloads.js:289` completed 下载项操作区只渲染预览和下载文件按钮，没有新增移动按钮，也没有弹出输入并 POST /api/downloads/:id/move。
  - 旧 task: task-07、task-10，旧状态: done。旧期望：completed 项操作区新增“移动”按钮，弹出输入 → `POST /api/downloads/:id/move`，成功刷新；不能新增未在 i18n 定义的裸文案。旧验收：`grep -n "/move" src/public/downloads.js` 命中移动请求。源码确认该验收当前为 0 命中。
  - 移动入口只对 `completed` 项渲染
  - 空输入映射为 `null`（移回根目录，依赖 task-20）
  - 不能破坏既有 preview / download file / delete / 直下载提交体
- 任务目的: 修复 bugfix-07、bugfix-12 描述的问题
- 实现入口: src/public/downloads.js `renderActions` 的 `download.status === "completed"` 分支（约第 278–289 行）；src/i18n.ts zhCN/enUS 目录
- 期望行为: completed 操作区在 preview、download file 旁新增移动按钮；`prompt`/`t()` 收集目标子目录，空字符串转 `null`，`POST /api/downloads/${id}/move` body 为 `{ targetSubdirectory }`，成功后 `refreshDownloads`。i18n 新增移动按钮/输入相关键（zhCN+enUS），错误展示走既有 `formatApiError`（含 `error.DOWNLOAD_MOVE_*`）
- 范围边界:
  - 必须: 仅 completed 渲染移动入口；空输入提交 `null`；文案走 `t()`
  - 不能: 改动与本 bug 无关的模块；不能改 proxyId 选择逻辑；不能加目录浏览对话框
  - 不做: 不做端到端浏览器测试；不改 `moveDownload` 服务实现
- 验收标准:
  1. `grep -n "/move" src/public/downloads.js` → 命中 `POST /api/downloads/` 移动请求
  2. `grep -n "targetSubdirectory" src/public/downloads.js` → 同时命中直下载提交体与 move body
  3. `npx vitest run test/unit/i18n.test.ts` → 全绿

## task-20 · moveDownload 接受 null 目标子目录表示根目录

- 状态: pending
- 依赖: 无
- 文件范围:
  - src/services/download.ts
- 关键约束:
  - 描述原文：`src/services/download.ts:1347` moveDownload 要求 raw.targetSubdirectory 必须是 string，导致 {"targetSubdirectory":null} 被 VALIDATION_ERROR 拒绝；需求上下文定义 move body 为 { targetSubdirectory: string | null }，null 表示移动到根目录。
  - plan §1.3 / §1.5：`{ targetSubdirectory: string | null }`，`null` → 合法，表示根目录；非 null 再 `validateTargetSubdirectory`
  - 不能对同名不同类型输入做兜底；`undefined` / 缺键 / 非 string-non-null 仍 `VALIDATION_ERROR`
  - 根目录落库必须写 SQL `NULL`（空字符串不能当根目录存进去）
- 任务目的: 修复 bugfix-08 描述的问题
- 实现入口: src/services/download.ts `MoveDownloadInput`（约第 1316 行）与 `moveDownload` 内 `typeof raw.targetSubdirectory !== "string"`（约第 1347–1350 行）
- 期望行为: `MoveDownloadInput.targetSubdirectory` 为 `string | null`。`null` 时目标目录为 `join(realDownloadRoot, String(downloadId))`，`UPDATE` 的 `target_subdirectory` 为 `null`；非 null 仍 `validateTargetSubdirectory` 后 `join(root, subdir, id)`。与当前子目录相同（含已经在根目录再移到 `null`）仍 `VALIDATION_ERROR`
- 范围边界:
  - 必须: `{"targetSubdirectory":null}` 可将 completed + download_directory 移回根目录
  - 不能: 改动与本 bug 无关的模块；不能放宽精确键集合（路由侧归 task-17）；不能吞掉 FS 错误
  - 不做: 不在本任务做目标已存在预检查（归 task-21）；不改 UI
- 验收标准:
  1. `grep -n "targetSubdirectory: string | null" src/services/download.ts` → 命中 `MoveDownloadInput`
  2. `grep -n "validateTargetSubdirectory" src/services/download.ts` → moveDownload 仅在非 null 时调用
  3. `npx tsc -p tsconfig.json --noEmit` → 无新增错误

## task-21 · rename 前显式拒绝已存在的目标 downloadId 目录

- 状态: pending
- 依赖: task-20
- 文件范围:
  - src/services/download.ts
- 关键约束:
  - 描述原文（bugfix-09）：`src/services/download.ts:1435` moveDownload 直接 rename(currentArchiveDir, newArchiveDir)，只在 rename 抛 EEXIST 时映射 DOWNLOAD_MOVE_TARGET_EXISTS。在当前 macOS/Node 环境下，把目录 rename 到已存在的空目录会成功，因此空的目标 downloadId 目录不会被拒绝。
  - 描述原文（bugfix-11）：`src/services/download.ts:1435` moveDownload 未在 rename 前显式检查目标 downloadId 目录是否已存在，目标非空目录会落到 DOWNLOAD_MOVE_FAILED，空目录还可能被 rename 覆盖，不符合目标已存在必须抛 DOWNLOAD_MOVE_TARGET_EXISTS 的契约。
  - 旧 task: task-05，旧状态: done。旧约束：目标 downloadId 目录已存在必须失败（`DOWNLOAD_MOVE_TARGET_EXISTS`）；FS 移动失败或落库 changes≠1 必须尽力回滚 rename 并抛 `DOWNLOAD_MOVE_FAILED`。旧期望：目标已存在→`DOWNLOAD_MOVE_TARGET_EXISTS`。
  - 不能先 `mkdir(newArchiveDir)` 再 rename（mkdir 成功会造出空目录，与空目录被覆盖是同一类问题）
  - 不能继续只依赖 rename 的 EEXIST（macOS/Node 对已存在空目录 rename 会成功）
- 任务目的: 修复 bugfix-09、bugfix-11 描述的问题
- 实现入口: src/services/download.ts `moveDownload` 内 `await rename(currentArchiveDir, newArchiveDir)`（约第 1433–1444 行）
- 期望行为: 在 rename 之前用 `access`/`stat`/`lstat` 检测 `newArchiveDir` 是否已存在；已存在（空或非空）立即抛 `BusinessError('DOWNLOAD_MOVE_TARGET_EXISTS', ...)`，不执行 rename。父目录仍 `mkdir(join(root, 新subdir), { recursive: true })`。rename 其它 FS 失败仍映射 `DOWNLOAD_MOVE_FAILED` 并保持既有回滚
- 范围边界:
  - 必须: 目标 downloadId 目录已存在（含空目录）→ 409 `DOWNLOAD_MOVE_TARGET_EXISTS`；源目录与 DB 行保持不变
  - 不能: 改动与本 bug 无关的模块；不能覆盖已存在目标；不能改 `DOWNLOAD_MOVE_FAILED` 的其它失败路径语义
  - 不做: 不改测试断言（归 task-22）；不引入跨进程锁（保持既有 `ponytail:` 注释）
- 验收标准:
  1. `grep -n "DOWNLOAD_MOVE_TARGET_EXISTS" src/services/download.ts` → 命中 rename 之前的显式存在检查分支（不只是 `isEExist` 映射）
  2. `npx tsc -p tsconfig.json --noEmit` → 无新增错误

## task-22 · 目标已存在负向用例改为 DOWNLOAD_MOVE_TARGET_EXISTS

- 状态: pending
- 依赖: task-21
- 文件范围:
  - test/integration/download-service.test.ts
- 关键约束:
  - 描述原文（bugfix-10）：`test/integration/download-service.test.ts:1184` task-05 契约要求移动目标目录已存在时返回 DOWNLOAD_MOVE_TARGET_EXISTS，但新增的负向用例把同一场景断言为 DOWNLOAD_MOVE_FAILED，测试会接受错误实现。
  - 描述原文（bugfix-13）：`test/integration/download-service.test.ts:1184` move 目标目录已存在的负向用例断言为 DOWNLOAD_MOVE_FAILED，而 task-05 契约要求该场景必须是 DOWNLOAD_MOVE_TARGET_EXISTS。
  - 旧 task: task-09、task-12，旧状态: done。旧约束：测试必须包含负向用例（move 目标已存在）；不能为了让旧断言通过而回退功能。旧期望：新增 move 负向用例证明“不支持什么”。
  - 源码确认：`it('rejects moving onto an existing download directory')` 先 `mkdir` 并写入 `existing.mp4`，再断言 `'DOWNLOAD_MOVE_FAILED'`
  - 必须覆盖空目标目录与非空目标目录均不能被移动覆盖
  - 不能引入新测试框架 / fixture 体系
- 任务目的: 修复 bugfix-10、bugfix-13 描述的问题
- 实现入口: test/integration/download-service.test.ts `it('rejects moving onto an existing download directory')`（约第 1169–1198 行，断言在第 1184 行）
- 期望行为: 该负向用例（及空目录对应用例）断言 `DOWNLOAD_MOVE_TARGET_EXISTS`；移动失败后源文件与目标已有内容均保持不变。非 completed 不可移动的既有 `VALIDATION_ERROR` 用例保持
- 范围边界:
  - 必须: 空目录与非空目录的目标冲突都断言 `DOWNLOAD_MOVE_TARGET_EXISTS`
  - 不能: 改动与本 bug 无关的模块；不能把断言改回 `DOWNLOAD_MOVE_FAILED` 来迁就旧实现
  - 不做: 不做端到端浏览器测试；不动 `download-api.test.ts` / `server-lifecycle.test.ts`
- 验收标准:
  1. `grep -n "rejects moving onto an existing download directory" -A 20 test/integration/download-service.test.ts` → 断言含 `DOWNLOAD_MOVE_TARGET_EXISTS` 且不含把该场景标成 `DOWNLOAD_MOVE_FAILED`
  2. `grep -n "DOWNLOAD_MOVE_TARGET_EXISTS" test/integration/download-service.test.ts` → ≥ 2（非空目标 + 空目标）
  3. `npx vitest run test/integration/download-service.test.ts` → 全绿
