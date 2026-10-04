# v0.6 · 直连下载支持微信视频号单视频

来源：Gitea #24

---

## 1. 需求契约

### 1.1 授权管理新增元宝 Cookie

- **平台键**：新增 Cookie 平台 `yuanbao`，展示名为“元宝 / Yuanbao”。
- **输入**：沿用 `POST` / `PUT /api/authorizations/cookies/:platform` 的 `application/octet-stream` Netscape Cookie 文件；文件必须通过现有七字段流式校验。
- **行为**：完整复用现有 Cookie 授权的上传、替换、列出、删除、权限（目录 `0700`、文件 `0600`）与错误边界；最终文件名固定为 `yuanbao.cookies.txt`，临时文件固定为 `.yuanbao.cookies.txt.pending`。
- **输出**：沿用既有 `{ configuration: { platform, configured, updatedAt } }`，不返回 Cookie 内容。
- **使用范围**：元宝 Cookie 只用于 `POST https://yuanbao.tencent.com/api/weixin/get_parse_result`，不传给第二个微信接口，也不传给 yt-dlp。

### 1.2 微信视频号分享链接识别

- **触发**：直连预览 `POST /api/downloads/direct/preview` 或创建 `POST /api/downloads/direct` 收到精确形式 `https://weixin.qq.com/sph/<id>`。
- **输入**：直连接口请求体仍严格为四个键：
  - `url: string`：仅视频号分支要求精确匹配上述形式；不得有 query、fragment、尾部 `/` 或额外路径段。
  - `proxyId: number | null`：沿用现有代理选择。
  - `advancedOptions: DownloadAdvancedOptions`：必须等于既有默认值（`mediaType='video'`，其余 nullable 字段为 `null`，两个布尔字段为 `false`）。
  - `targetSubdirectory: string | null`：沿用现有目录契约。
- **短 ID**：复用 `src/filesystem.ts` 的 `isArchiveVideoId` 校验 `<id>`；`platform_video_id` 固定保存该分享短 ID，不从解析响应猜测其它 ID。
- **平台值**：下载记录 `platform` 固定为 `weixin`；`source_url` 固定保存原始分享链接。
- **其它形式**：`weixin.qq.com` / `channels.weixin.qq.com` 下非上述精确形式的 URL 显式抛 `NOT_A_VIDEO_URL`，不降级为 yt-dlp 通用元数据探测；其它平台 HTTPS URL 保持现有通用探测行为。

### 1.3 两阶段解析协议

视频号分支不调用 `YtDlpOperations.fetchVideoMetadata`，而按下列固定协议解析：

1. 从授权服务取得 `yuanbao` Cookie 文件；未配置时抛 `VALIDATION_ERROR`，固定消息 `Yuanbao cookie configuration is not configured`。
2. 从已通过 Netscape 校验的文件中，仅提取域名/路径/secure/有效期与 `yuanbao.tencent.com/api/weixin/get_parse_result` 匹配的 Cookie，组成 `Cookie` 请求头；没有匹配 Cookie 时显式解析失败，不发送其它域 Cookie。
3. `POST https://yuanbao.tencent.com/api/weixin/get_parse_result`：
   - `Content-Type: application/json`
   - body 精确为 `{"type":"video_channel_url","url":<分享链接>,"scene":1}`
   - 必须得到非空字符串 `data.playable_url`；不支持 `wx_export_id` 或其它字段别名。
4. 把 `data.playable_url` 作为 URL 解析，query 必须同时含非空 `token` 与 `eid`；缺失、重复或类型不符均快速失败，不使用 `exportId` 等别名兜底。
5. `POST https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info`：
   - `Content-Type: application/json`
   - body 精确为 `{"baseReq":{"generalToken":token},"exportId":eid}`
   - 不带 Cookie。
6. 固定读取第二步响应：
   - 标题：非空 `data.feedInfo.description`；
   - 作者昵称：非空 `data.authorInfo.nickname`；
   - 视频地址：已确认的两种字段 `data.feedInfo.videoUrl` 或 `data.feedInfo.h264VideoInfo.videoUrl`，按此前顺序取第一个非空 HTTPS URL；两者都无值即失败；
   - 不读取 `h265VideoInfo`、图片、直播或音频字段，不做递归/模糊查找。
7. 解析结果映射为 `{ platform: 'weixin', platformVideoId: <分享短 ID>, title, authorNickname, videoUrl }`；预览 `durationSeconds` 固定为 `null`，作者昵称通过现有 `suggestDirectSubdirectory` / `validateTargetSubdirectory` 规则生成 `suggestedSubdirectory`。

HTTP 非 2xx、网络/代理失败、元宝会话失效统一映射为 `VIDEO_FETCH_FAILED`；JSON 非法、固定字段缺失/类型错误、视频地址非 HTTPS 映射为 `VIDEO_METADATA_INVALID`。错误消息不得包含 Cookie、完整响应体或代理凭据。

### 1.4 创建、执行与重试

- **预览/创建**：视频号分支使用 §1.3 取得标题、作者与去重键，不产生 `metadata_probe` 任务；创建前仍执行现有 `(platform, platform_video_id)` 活跃/完成去重检查。
- **持久化**：只保存分享链接、`platform='weixin'`、分享短 ID、标题、用户选择的代理快照与目标子目录；不保存临时 `token`、`eid` 或视频地址；`advanced_options_json` 为 `NULL`。
- **首次执行**：创建阶段取得的临时视频地址不得直接进入下载队列。worker 真正开始执行时必须重新读取当前元宝 Cookie，重新完成两次解析，再把本次得到的视频地址交给 `downloadMedia`。
- **重试**：`retryDownload` 识别保存行的 `platform='weixin'`，保持原分享链接、代理快照、短 ID 与目标子目录；每次重试进入 worker 后重新解析，不复用任何旧视频地址。若元宝 Cookie 已删除，重试请求明确失败且原下载行保持失败/取消/中断状态，不先改成无法执行的 `pending`。
- **代理**：预览/创建解析使用当前 `proxyId` 对应 URL；worker 初次执行与重试解析使用持久化的 `proxy_url_snapshot`；随后 yt-dlp 下载同样使用该代理。`proxyId=null` 时解析直接连接且不得读取 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。
- **yt-dlp**：只调用既有 `downloadMedia` 下载解析后的明文视频地址；不对分享链接做元数据探测，不把元宝 Cookie传给 yt-dlp。
- **缩略图**：视频号队列项显式跳过 `tryDownloadThumbnail`，`thumbnail_path` 保持 `NULL`；其它平台继续现有缩略图行为。

### 1.5 高级选项

- 后端使用精确默认对象比较；视频号请求任一字段非默认即抛 `VALIDATION_ERROR`，固定消息 `Weixin video downloads do not support advanced options`。
- 前端 URL 精确匹配视频号分享链接时：把媒体类型、质量、转码、字幕、时间范围恢复为默认值并禁用这些控件，收起高级选项；代理与目标子目录仍可选择。
- URL 离开精确视频号形式时恢复控件；任何前端状态都不替代后端校验。

### 1.6 状态、事件与输出

- 不新增下载状态：继续使用 `pending → running → completed|failed|canceled` 及既有重试状态边界。
- 不新增公共 API 路径或请求字段。
- 预览响应沿用 `DirectDownloadPreview`：`platform='weixin'`、`platformVideoId=<短 ID>`、`title=<description>`、`durationSeconds=null`、`suggestedSubdirectory=<作者昵称或 null>`、`targetSubdirectory=<请求值>`。
- 创建响应继续为 `202 { download }`；列表/SSE 中平台值为 `weixin`，前端显示“微信视频号 / WeChat Channels”。
- 解析过程继续运行在既有 `media_download` 任务内部，不新增 yt-dlp task type 或额外公共事件。

---

## 2. 范围边界

### 做

- 授权管理增加元宝 Netscape Cookie。
- 直连预览、创建、实际执行与重试支持精确视频号分享链接。
- 两个解析请求与最终 yt-dlp 下载遵守同一个用户代理选择。
- 保存分享短 ID 作为去重键，保存分享链接而非过期播放地址。
- 作者昵称作为建议目录；视频号禁用并拒绝非默认高级选项；不下载缩略图。
- 用单元/集成负向测试证明非法 URL、缺 Cookie、非默认高级选项、字段缺失、图片/直播类无视频地址、代理分支以及重试重新解析均按契约失败或执行。

### 不做

- 不支持视频号频道关注、自动发现、直播、直播回放、图片、音频或批量下载。
- 不支持 finder-preview 页面、feed 地址、短链之外的视频号 URL 形式，也不做 URL 规范化/重定向猜测。
- 不支持 `h265VideoInfo`、字段别名、递归解析、公共接口降级、第三方解析服务或解析失败后的 yt-dlp fallback。
- 不做本地代理抓包、PC 微信注入、视频解密或封面下载。
- 不保存/返回 Cookie、token、eid、临时播放地址，不把敏感响应写入错误或日志。
- 不改动频道模型、调度器、通知、下载状态枚举或数据库 schema。

### 版本级验收标准

1. `npx tsc -p tsconfig.json --noEmit` 无类型错误，`npm run build` 成功。
2. `npx vitest run` 全绿，新增测试覆盖正向解析和上述负向边界。
3. 视频号预览/创建不产生 `metadata_probe`；数据库仅保存分享 URL 与短 ID，worker 每次执行/重试均重新调用两阶段解析。
4. HTTP/HTTPS/SOCKS5 代理均由所选代理驱动两个解析请求与 yt-dlp；直连不读取环境代理。
5. 视频号任务完成后主文件可播放且 `thumbnail_path IS NULL`；非默认高级选项与未配置元宝 Cookie 均返回明确错误。

---

## 3. 实现设计

### 3.1 方案选择与复用证据

按“仓库现有能力 → 标准库/平台原生能力 → 已安装依赖 → 成熟开源方案 → 最小自行实现”选择：

| 能力 | 选择与证据 | 决策 |
| --- | --- | --- |
| Cookie 文件生命周期/校验 | `src/services/cookie-authorization.ts` `COOKIE_PLATFORMS`、`NetscapeCookieValidator`、`CookieAuthorizationService` | 直接新增平台定义，禁止复制上传/替换/删除服务 |
| URL ID 安全约束 | `src/filesystem.ts:isArchiveVideoId` | 分享短 ID 必须复用，禁止另写不同 ID 规则 |
| 代理选择/快照 | `src/services/download.ts:loadProxy`、`proxy_url_snapshot` | 复用现有选择与持久化，不新增第二套代理配置 |
| 建议目录 | `src/services/download.ts:suggestDirectSubdirectory` | 用作者昵称走现有 channel/uploader 校验逻辑 |
| 下载与归档 | `src/download-worker.ts:DownloadWorker.#run`、`src/yt-dlp.ts:downloadMedia` | 继续由既有 worker、进度、文件校验与归档负责 |
| 直连 HTTPS POST | Node `node:https` 足以完成无代理请求；项目 `package.json` 无通用代理 HTTP 客户端 | 直连使用标准库，避免新增 HTTP 框架 |
| HTTP/HTTPS/SOCKS5 代理请求 | `src/services/proxy.ts` 明确允许三种协议；Node 标准库与当前依赖无法统一满足；`proxy-agent@8.0.2`（Node >=20）明确映射 HTTP/HTTPS/SOCKS 代理为 `http.Agent` | 新增唯一运行依赖 `proxy-agent`；仅在用户选代理时以固定 `getProxyForUrl` 使用，禁止读取环境代理或实现自制 CONNECT/SOCKS |

解析响应的固定字段依据 Gitea #24 已确认接口与外部公开实现交叉证据：元宝响应 `data.playable_url`；微信响应 `data.feedInfo.videoUrl` / `data.feedInfo.h264VideoInfo.videoUrl`、`data.feedInfo.description`、`data.authorInfo.nickname`。只纳入需求明确提到并有证据的两种视频字段，不采用公开实现中的 `wx_export_id`、`h265VideoInfo`、公共接口 fallback 等额外行为。

### 3.2 新增解析模块

**`src/weixin.ts`（新建）**

- `parseWeixinShareUrl(url)`：只接受精确分享形式，复用 `isArchiveVideoId` 返回短 ID；另提供明确识别微信视频号 host 的判断，供下载服务阻断其它形式。
- `resolveWeixinVideo({ shareUrl, cookieFilePath, proxyUrl?, signal? })`：
  - 读取 Netscape Cookie 文件，按固定七字段直线解析并只为元宝 endpoint 组装 Cookie；Cookie 文件已经由授权服务验证，运行时若文件变化/失效仍快速失败。
  - 用 `node:https.request` 发送固定 JSON POST；有 `proxyUrl` 时使用 `new ProxyAgent({ getProxyForUrl: () => proxyUrl })`，无代理不创建 ProxyAgent；将 `AbortSignal` 传入请求。
  - 严格解析 §1.3 字段并返回一次性视频地址与稳定元数据；不暴露 Cookie/token/eid。
  - HTTP/代理/JSON/字段错误按 §1.3 映射，响应体不拼入消息。

### 3.3 授权平台与 UI

**`src/services/cookie-authorization.ts`**

- `COOKIE_PLATFORMS` 增加 `{ platform:'yuanbao', fileName:'yuanbao.cookies.txt', temporaryFileName:'.yuanbao.cookies.txt.pending' }`；所有服务方法由类型自动覆盖该平台。

**`src/public/authorizations.js` / `src/i18n.ts`**

- 平台列表增加 `yuanbao: '元宝' / 'Yuanbao'`；范围说明明确元宝仅用于视频号解析。
- 不新增授权页面模板或 API 路由，复用当前动态列表、上传、替换、删除。

### 3.4 下载服务

**`src/services/download.ts`**

- 在 `parseDirectInput` 完成既有四键/类型校验后判断微信视频号 URL；精确分享 URL校验默认高级对象，其它视频号 host 形式快速失败。
- `probeDirectDownload` 分支：
  - 视频号：`getConfiguredFilePath('yuanbao')` 前先映射明确缺配置错误，调用 `resolveWeixinVideo`，构造既有 `DirectProbe` 需要的稳定元数据；不提交 `metadata_probe`。
  - 其它 URL：完整保留现有 yt-dlp 元数据探测与同平台 Cookie 行为。
- `PreparedDownload` / `QueuedDownload` 增加当前需求所需的视频号执行标记与独立 `yuanbaoCookieFilePath`；不得复用 `cookieFilePath`，避免把元宝 Cookie 传给媒体地址。
- 视频号落库 `advanced_options_json=NULL`；队列继续携带原分享 URL、分享短 ID、代理快照、目标目录，并标记跳过缩略图。
- `RetryDownloadRow` 与查询增加 `platform`；视频号重试在状态更新前确认元宝 Cookie 文件存在，队列继续使用原分享 URL并设置重新解析标记。普通直连/频道重试保持原逻辑。

不改 `src/routes/downloads.ts`：既有 preview/create/retry 路由已经完整透传下载服务与授权服务，公开 HTTP 契约无需新增路由或字段。

### 3.5 下载 worker

**`src/download-worker.ts`**

- `DownloadWorker.#run` 在创建临时目录后、调用 `operations.downloadMedia` 前检查视频号标记；视频号用当前分享链接、元宝 Cookie 路径、代理快照与 task `AbortSignal` 调 `resolveWeixinVideo`，得到本次视频地址。
- `downloadMedia.url` 对视频号使用本次解析的视频地址，对其它任务仍使用 `sourceUrl`；二者继续复用同一代理、进度回调、文件校验和归档链路。
- 视频号标记直接跳过 `tryDownloadThumbnail`；其它任务不变。
- 解析失败进入既有 worker 失败状态转换，错误消息必须经过既有 `failureMessage` / 代理脱敏，不增加吞错层。

### 3.6 下载页

**`src/public/downloads.js` / `src/views/downloads.ejs` / `src/i18n.ts`**

- 在现有 `input` / `change` 监听中增加精确 URL 判断与控件状态同步；进入视频号模式先恢复高级选项默认值，再禁用媒体类型及高级区所有输入，收起 `<details>`。
- 离开精确视频号 URL 后恢复控件；每次切换继续调用 `resetDirectPreview`，保持“预览后才能提交”约束。
- 平台标签增加 `weixin`，URL 规则与高级选项提示补齐中英文，不把协议判断只留在文案层。

### 3.7 测试设计

- **解析器单测**：精确 URL/短 ID；Netscape 域/path/secure/expiry 筛选；两次 POST 的 URL、body、Cookie 与代理；固定响应字段；无 token/eid、非 JSON、非 2xx、缺标题/作者/视频、图片响应、h265-only、非 HTTPS 视频地址全部失败；错误不含 Cookie/代理凭据。
- **授权测试**：平台数、固定顺序、文件名、上传/替换/删除/初始化清理扩展到 `yuanbao`；未知平台仍拒绝。
- **下载服务/API 测试**：视频号不产生 metadata_probe；保存 `weixin` + 分享短 ID + 分享 URL；建议目录取作者；缺 Cookie、其它 URL 形式、非默认高级对象、重复任务快速失败；普通平台行为不变；重试队列标记重新解析且缺 Cookie 不改状态。
- **worker 测试**：每次 enqueue/run 都调用解析器，下载使用新视频地址和同一代理；重试再次解析；元宝 Cookie不传 yt-dlp；视频号不调用 thumbnail；解析失败落 `failed`。
- **页面测试**：精确分享 URL 进入/离开时高级控件禁用、重置、恢复；平台与中英文文案可渲染。

### 3.8 数据库、SQL 与其它模块

- **数据库**：不涉及。现有 `downloads.platform` 对 direct 允许任意非空字符串，`source_url`、`platform_video_id`、`title`、`proxy_url_snapshot`、`advanced_options_json` 已满足持久化契约。
- **SQL 产物**：无 SQL 变更，**不得创建** `docs/database/v0.6.sql`，也不得创建 `docs/designs/v0.6/schema.sql`。
- **频道/调度/通知**：不涉及。
- **部署配置**：不新增环境变量；`package.json` / `package-lock.json` 仅增加 `proxy-agent` 运行依赖。

### 3.9 风险与失败边界

- 元宝与微信接口未公开，字段变化按严格契约直接失败，不添加别名/fallback；失败后可通过替换 Cookie 或未来明确需求修订契约。
- Cookie、token、eid 与签名视频 URL 均属敏感/短期数据，不落库、不回显、不进日志。
- 代理库必须使用用户选定 URL的固定回调；直连不得受宿主环境代理污染。
- 创建时解析成功不代表排队后地址仍有效，因此 worker 必须重新解析；任何试图把创建阶段视频 URL放入队列或数据库的实现都不合格。
