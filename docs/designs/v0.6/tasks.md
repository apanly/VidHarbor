# Tasks - v0.6

## task-01 · 微信视频号解析器与代理传输
- 状态: done
- 依赖: 无
- 文件范围:
  - package.json
  - package-lock.json
  - src/weixin.ts (新建)
  - test/unit/weixin.test.ts (新建)
- 关键约束:
  - 选定方案是“Node `node:https` 直连 + `proxy-agent@8.0.2` 代理”：证据为 `package.json` 运行时 Node 24、`src/services/proxy.ts:ProxyConfig` 支持 `http|https|socks5`，当前依赖无统一代理 HTTP 客户端，而 `proxy-agent@8.0.2` 声明 Node >=20 并覆盖 HTTP/HTTPS/SOCKS；不能自制 CONNECT/SOCKS、不能改用环境代理
  - 必须复用 `src/filesystem.ts:isArchiveVideoId` 校验分享短 ID；不能新增另一套 ID 正则或规范化输入 URL
  - 只能读取 `data.playable_url` 的唯一 `token`/`eid`，再读取 `data.feedInfo.description`、`data.authorInfo.nickname`、`data.feedInfo.videoUrl` 或 `data.feedInfo.h264VideoInfo.videoUrl`；不能支持 `wx_export_id`、`exportId` query、`h265VideoInfo`、递归查找或公共接口 fallback
  - Cookie 只能发送到元宝固定 endpoint，第二个请求不能带 Cookie；错误、日志和返回值不能包含 Cookie、token、eid、完整响应体或代理凭据
  - 未知字段、缺少字段、图片/直播类无视频地址、非 HTTPS 视频地址必须显式失败，不能静默返回空值
- 任务目的: 实现固定的“元宝解析 → 微信 feed 信息”协议，为预览、创建和每次 worker 执行提供一次性视频地址与稳定元数据
- 实现入口: 新建 `src/weixin.ts`；复用 `src/filesystem.ts:isArchiveVideoId`，代理协议证据位于 `src/services/proxy.ts:ProxyConfig`
- 期望行为: 导出精确 URL/host 判断与 `resolveWeixinVideo`；仅接受无 query/fragment/尾斜杠的 `https://weixin.qq.com/sph/<id>`，读取 Netscape 七字段并按元宝 host/path/secure/有效期筛 Cookie，依次发送两个固定 JSON POST（30 秒超时、支持 AbortSignal），返回 `{ platform:'weixin', platformVideoId, title, authorNickname, videoUrl }`；有代理时用固定 `getProxyForUrl:()=>proxyUrl`，直连时不用 ProxyAgent且不读取环境变量
- 范围边界:
  - 必须: 两个 POST body 分别精确为 `{"type":"video_channel_url","url":shareUrl,"scene":1}` 与 `{"baseReq":{"generalToken":token},"exportId":eid}`，视频字段只接受已确认的两个路径并按 `feedInfo.videoUrl` 优先
  - 不能: 保存临时地址、把 Cookie 传给微信 feed API、支持其它微信 URL 或把失败降级给 yt-dlp
  - 不做: 不处理频道、直播、回放、图片、音频、h265、封面或视频解密
- 验收标准:
  1. `npm ls proxy-agent` → 显示 `proxy-agent@8.0.2` 且无 missing/invalid
  2. `npx vitest run test/unit/weixin.test.ts` → 正向、HTTP/HTTPS/SOCKS5 代理、直连、Cookie 筛选及所有负向契约用例通过
  3. `npx tsc -p tsconfig.json --noEmit` → 无类型错误

## task-02 · 元宝 Cookie 授权平台
- 状态: done
- 依赖: 无
- 文件范围:
  - src/services/cookie-authorization.ts
  - src/public/authorizations.js
  - src/i18n.ts
  - test/unit/cookie-authorization.test.ts
  - test/integration/cookie-authorization-api.test.ts
- 关键约束:
  - 必须复用 `COOKIE_PLATFORMS`、`NetscapeCookieValidator` 与 `CookieAuthorizationService` 的现有上传/替换/删除/权限/队列逻辑；不能复制授权 service、增加新路由或新增 Cookie 格式
  - 元宝定义固定为 `platform='yuanbao'`、`fileName='yuanbao.cookies.txt'`、`temporaryFileName='.yuanbao.cookies.txt.pending'`
  - 不能向 API/UI 暴露文件路径、文件名或 Cookie 内容；不能改变未知平台、空文件、非法 Netscape 文件的现有失败边界
  - 删除元宝授权不需要频道引用兼容逻辑；现有 `channels.authorization_platform` 查询自然返回 0，不能修改数据库约束来容纳 `yuanbao`
- 任务目的: 让用户通过现有授权管理完整维护视频号解析所需的元宝 Netscape Cookie
- 实现入口: src/services/cookie-authorization.ts `COOKIE_PLATFORMS`（第 15 行）、`CookieAuthorizationService.initialize/listConfigurations/createConfiguration/updateConfiguration/deleteConfiguration`；src/public/authorizations.js `platformLabels`
- 期望行为: 元宝作为固定第六个平台出现在授权 UI，可上传、替换、重启后列出和删除；文件继续以 `0600` 保存，临时文件初始化时清理；中英文范围文案说明元宝授权只用于微信视频号解析
- 范围边界:
  - 必须: 单元/API 测试的固定平台顺序与数量更新为六项，并验证元宝完整生命周期及不泄露敏感内容
  - 不能: 让元宝出现在频道授权选择中，或修改 `src/public/channels.js` 的同平台授权过滤
  - 不做: 不远程验证 Cookie 是否仍登录，不读取浏览器配置，不增加文本粘贴入口
- 验收标准:
  1. `npx vitest run test/unit/cookie-authorization.test.ts test/integration/cookie-authorization-api.test.ts` → 六平台生命周期、权限、非法输入和敏感信息测试通过
  2. `grep -n "yuanbao.cookies.txt\|yuanbao: 'Yuanbao'" src/services/cookie-authorization.ts src/public/authorizations.js` → 命中平台文件与 UI 标签
  3. `npx tsc -p tsconfig.json --noEmit` → 无类型错误

## task-03 · 直连服务接入视频号预览、创建与重试
- 状态: pending
- 依赖: task-01, task-02
- 文件范围:
  - src/services/download.ts
  - test/integration/download-service.test.ts
  - test/integration/download-api.test.ts
- 关键约束:
  - 必须保留直连接口精确四键契约；视频号 `advancedOptions` 必须逐字段等于默认对象，否则抛 `VALIDATION_ERROR: Weixin video downloads do not support advanced options`
  - 视频号只能走 task-01 的 `resolveWeixinVideo`，不能提交 `metadata_probe`、不能用 yt-dlp 探测分享链接、不能为解析失败增加 fallback；普通 HTTPS URL必须保持现有探测行为
  - 未配置元宝 Cookie 必须抛 `VALIDATION_ERROR: Yuanbao cookie configuration is not configured`；不能沿用“未配置则不带 Cookie 继续”的普通直连逻辑
  - 持久化只能保存 `platform='weixin'`、分享短 ID、原分享 URL、标题、代理快照和目标子目录；不能保存 token/eid/视频地址，且 `advanced_options_json` 必须为 `NULL`
  - 重试必须在把行改为 `pending` 前确认元宝 Cookie 已配置；不能因缺 Cookie 留下无队列任务的 pending 行
- 任务目的: 将专用解析结果映射到现有 DirectDownloadPreview、下载记录、去重与重试队列契约
- 实现入口: src/services/download.ts `parseDirectInput`（第 241 行）、`directCookiePlatform`（第 289 行）、`suggestDirectSubdirectory`（第 332 行，必须复用）、`probeDirectDownload`（第 679 行）、`createDirectDownload`（第 736 行）、`retryDownload`（第 1220 行）
- 期望行为: 精确分享 URL预览/创建时调用解析器并返回 `platform='weixin'`、短 ID、description 标题、`durationSeconds=null`、作者建议目录；创建队列项仍保存分享 URL并用独立可选字段 `weixinCookieFilePath` 标记执行时重解析（不得复用传给 yt-dlp 的 `cookieFilePath`）；其它 `weixin.qq.com` / `channels.weixin.qq.com` 形式显式 `NOT_A_VIDEO_URL`；`RetryDownloadRow` 查询 platform，视频号重试重新排入同类队列
- 范围边界:
  - 必须: 继续复用 `loadProxy`、`assertNoExistingDownload`、`insertDownloads`、`enqueueDownloads` 与 `suggestDirectSubdirectory`，解析请求取得同一 `proxyUrl`
  - 不能: 修改公共请求字段、增加数据库列、把作者自动强制为目标目录或影响普通平台 Cookie 选择
  - 不做: 不在服务层下载媒体、下载封面或更新下载状态机
- 验收标准:
  1. `npx vitest run test/integration/download-service.test.ts test/integration/download-api.test.ts` → 视频号预览/创建/去重/缺 Cookie/非法 URL/非默认高级选项/重试及普通平台回归用例通过
  2. `grep -n "weixinCookieFilePath\|platform: 'weixin'" src/services/download.ts` → 命中专用队列标记和平台映射
  3. `npx tsc -p tsconfig.json --noEmit` → 无类型错误

## task-04 · Worker 每次重解析并跳过缩略图
- 状态: pending
- 依赖: task-01, task-03
- 文件范围:
  - src/download-worker.ts
  - test/integration/download-worker.test.ts
- 关键约束:
  - `DownloadWorker.#run` 遇到 `weixinCookieFilePath` 时必须在每次实际执行中重新调用 `resolveWeixinVideo`；不能使用创建阶段的视频地址，也不能把解析地址写回数据库或队列
  - `downloadMedia` 必须收到本次解析的视频 URL与同一个 `proxyUrl`，但不能收到元宝 Cookie；普通任务继续使用原 `sourceUrl` / `cookieFilePath`
  - 视频号必须完全跳过 `tryDownloadThumbnail`；不能用“尝试后忽略失败”替代跳过，普通平台缩略图行为不能改变
  - 解析网络/字段错误必须进入既有 failed 状态与 `failureMessage` 脱敏边界；不能额外 catch 后吞错、重试或 fallback
- 任务目的: 保证过期播放地址永不持久化或复用，并让首次下载与每次重试都取得新的明文 MP4 地址
- 实现入口: src/download-worker.ts `DownloadWorker.#run`（第 409 行）、`operations.downloadMedia` 调用（第 462 行）、`tryDownloadThumbnail` 调用（第 476 行）
- 期望行为: worker 在 task AbortSignal 下解析分享链接，随后沿用现有进度、文件验证、归档和完成状态逻辑下载新地址；视频号任务 `thumbnail_path` 保持 null；同一失败记录重试后再次执行解析器并可得到不同签名地址
- 范围边界:
  - 必须: 测试证明两次执行调用解析器两次、第二次媒体 URL不同且代理一致，元宝 Cookie从未进入 yt-dlp options
  - 不能: 新增 yt-dlp task type、绕过下载并发限制、改变取消/清理/归档状态转换
  - 不做: 不更新已保存标题/作者，不下载封面，不探测媒体元数据
- 验收标准:
  1. `npx vitest run test/integration/download-worker.test.ts` → 重解析、代理透传、Cookie 隔离、跳过缩略图、解析失败与普通任务回归通过
  2. `grep -n "weixinCookieFilePath\|resolveWeixinVideo" src/download-worker.ts` → 命中专用执行分支
  3. `npx tsc -p tsconfig.json --noEmit` → 无类型错误

## task-05 · 下载页视频号模式与中英文契约文案
- 状态: pending
- 依赖: task-02, task-03
- 文件范围:
  - src/views/downloads.ejs
  - src/public/downloads.js
  - src/i18n.ts
  - test/integration/pages.test.ts
- 关键约束:
  - 前端 URL 判断必须与后端精确形式一致：只对无 query/fragment/尾斜杠的 `https://weixin.qq.com/sph/<id>` 启用视频号模式；不能对模糊包含 `weixin` 的 URL 禁用控件
  - 进入视频号模式必须先把 `mediaType/format/quality/codec/writeSubtitles/splitChapters/timeRangeStart/timeRangeEnd` 恢复成后端默认值，再禁用媒体类型与高级区控件并收起 `<details>`；不能只做视觉隐藏而保留非默认 payload
  - 离开精确形式必须恢复控件，每次切换继续使已有 preview 失效；后端仍是最终校验边界
  - 所有新增提示必须通过 `src/i18n.ts` 中英文键；不能写只支持一种语言的裸文案
- 任务目的: 防止用户为视频号提交不支持的高级选项，并在列表、URL 规则和授权说明中准确展示新平台
- 实现入口: src/public/downloads.js `advancedOptions/directPayload/resetDirectPreview`（第 33-37 行）、表单 `input/change` 监听（第 245-246 行）、`platformLabels`（第 29 行）；src/views/downloads.ejs `.direct-advanced-options`（第 70 行）；test/integration/pages.test.ts 授权标签测试（约第 747 行）与下载 URL 规则测试（约第 948 行）
- 期望行为: 精确视频号 URL时表单只允许默认视频下载、代理与目标子目录；切回其它 URL后高级控件恢复；列表平台显示微信视频号；中英文文案说明支持的精确链接、元宝 Cookie用途与高级选项限制
- 范围边界:
  - 必须: 页面测试机械验证进入/离开模式后的控件值、disabled/open 状态、preview 失效及中英文标签
  - 不能: 移除预览先决条件、改变普通 URL payload、用前端禁用代替 task-03 后端拒绝
  - 不做: 不增加新的弹窗、授权上传入口、频道页面或浏览器端解析请求
- 验收标准:
  1. `npx vitest run test/integration/pages.test.ts test/unit/i18n.test.ts` → 视频号表单状态与中英文文案用例通过
  2. `npm run build` → TypeScript、Sass、静态资源复制全部成功
  3. `npx vitest run` → 全量测试通过
