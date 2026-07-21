# Tasks - v0.3

## task-01 · 实现 Cookie 授权文件服务与严格格式边界
- 状态: done
- 依赖: 无
- 文件范围:
  - src/services/cookie-authorization.ts (新建)
  - test/unit/cookie-authorization.test.ts (新建)
- 关键约束:
  - 不能接受固定集合以外的平台、大小写变体、`twitter`/`x` 别名、自定义文件名或自定义保存路径。
  - 必须由同一处常量按 `youtube`、`bilibili`、`x`、`facebook`、`douyin` 的顺序定义平台及固定文件映射；最终普通文件是否存在与其 `mtime` 分别是 `configured` 和 `updatedAt` 的唯一事实源。
  - 必须以流式临时落盘、增量七列校验、文件同步、写入本次时间和同目录原子替换完成上传；同平台修改串行、不同平台互不阻塞，失败时旧文件和旧时间完全不变。
  - 必须将目录权限收紧为 `0700`、固定最终文件和临时文件收紧为 `0600`，使用 `lstat` 拒绝非普通文件，并且只清理由本模块精确命名的未提交临时文件。
  - 不能在错误、测试失败信息或返回对象中暴露 Cookie 原文、数据行、字段、文件名、服务器路径或底层文件系统异常。
- 任务目的: 建立 PRD 要求的五平台单文件 Cookie 持久化、严格 Netscape 校验、原子更新和非敏感状态契约。
- 实现入口: 新建（src/services/cookie-authorization.ts）；单元测试入口为新建（test/unit/cookie-authorization.test.ts）
- 期望行为: 服务初始化后能够按固定顺序列出五个平台状态，保存、完整替换和删除单个平台 Cookie；接受 LF、CRLF、末行无换行、标准注释、空白行和合法 `#HttpOnly_` 七列记录，拒绝空文件、纯注释、非制表符分隔、列数错误、非法布尔、非法过期时间、空必要字段及任意混合坏行；并发和持久化失败均保持可验证的一致状态。
- 范围边界:
  - 必须: 覆盖五个平台隔离、首次保存、替换、删除、更新时间、重建服务后状态、并发串行、原子失败、权限与 Netscape 正反格式测试，敏感断言只比较布尔值或摘要。
  - 不能: 不能读取浏览器资料、发起远端请求、判断域名归属或过期状态，也不能设置未经确认的上传字节上限。
  - 不做: 不提供 Cookie 内容回读、导出、预览、下载、多个账号、格式转换、yt-dlp 参数生成或后台任务。
- 验收标准:
  1. `npm test -- --run test/unit/cookie-authorization.test.ts --maxWorkers=1` → Cookie 服务全部单元测试通过
  2. `npm run build` → TypeScript 与前端资源构建成功

## task-02 · 接入 Cookie API、原始请求体例外与启动初始化
- 状态: done
- 依赖: task-01
- 文件范围:
  - src/routes/authorizations.ts (新建)
  - src/app.ts
  - src/server.ts
  - test/integration/cookie-authorization-api.test.ts (新建)
  - test/integration/http-contract.test.ts
- 关键约束:
  - 不能放宽全局 JSON body 契约；只有精确的 `PUT /api/authorizations/cookies/:platform` 接受 `application/octet-stream` 原始请求流，其他 POST、PUT、PATCH 继续要求 `application/json`。
  - 必须提供且只提供 `GET /api/authorizations/cookies`、`PUT /api/authorizations/cookies/:platform`、`DELETE /api/authorizations/cookies/:platform` 三组接口，并继续让全部写请求先经过 `requireSameOrigin`。
  - 必须让 `createApiRouter` 接收必填 Cookie 服务依赖；`startServer` 以 `dirname(config.databasePath)/cookies` 初始化同一服务实例，初始化失败时不监听 HTTP。
  - 不能让 API 响应超出 `platform`、`configured`、`updatedAt`，也不能把上传文件名、Cookie 内容、保存路径或底层异常写入响应、错误或日志。
- 任务目的: 落地设计中的固定 Cookie 状态、二进制上传/替换和删除 API，并保持现有 HTTP 与启动失败边界不变。
- 实现入口: src/app.ts:27 `requireJsonBody`、src/app.ts:81 `createApp`、src/app.ts:99 `createApiRouter`、src/server.ts:175 `startServer`、新建（src/routes/authorizations.ts）
- 期望行为: 列表接口固定返回五项；合法上传和替换返回 200 与单项元数据；合法删除返回未配置状态；未知平台、错误媒体类型、空/坏格式、未配置删除和错误 Origin 返回固定 400 契约；文件系统失败统一返回 `500 PERSISTENCE_ERROR / cookie persistence failed`，且不存在内容读取或下载路由。
- 范围边界:
  - 必须: 证明平台白名单、固定响应字段、同源保护、持久化错误、服务重建后状态、敏感标记不进入响应/错误/日志，以及精确二进制 body 例外。
  - 不能: 不能为原始 body 增加 multipart、JSON、Base64、文件名字段、body 缓冲上限或猜测式媒体类型兼容。
  - 不做: 不修改设置、代理、频道、下载、数据库浏览器或 yt-dlp 的输入输出和依赖图。
- 验收标准:
  1. `npm test -- --run test/integration/cookie-authorization-api.test.ts test/integration/http-contract.test.ts --maxWorkers=1` → Cookie API 与 HTTP 媒体类型契约测试通过
  2. `npm run build` → 新路由、必填依赖和启动接线通过编译

## task-03 · 更新现有 API 测试的必填 Cookie 服务夹具
- 状态: done
- 依赖: task-02
- 文件范围:
  - test/integration/channel-notification-api.test.ts
  - test/integration/database-browser.test.ts
  - test/integration/download-api.test.ts
  - test/integration/settings-proxy-api.test.ts
- 关键约束:
  - 不能给 `createApiRouter` 增加可选依赖、默认服务或运行时探测来规避测试调用点更新。
  - 必须由每个测试套件在其现有 sandbox 中创建独立 Cookie 目录和服务实例，测试结束时仍由原有 sandbox 清理边界回收。
  - 不能改变四组既有 API 的请求、响应、错误或任务行为断言。
- 任务目的: 适配 `createApiRouter` 的新增必填 Cookie 服务依赖，同时证明原有 API 契约没有被授权管理功能污染。
- 实现入口: test/integration/channel-notification-api.test.ts:187 `beforeEach`、test/integration/database-browser.test.ts:21 `beforeEach`、test/integration/download-api.test.ts:204 `beforeEach`、test/integration/settings-proxy-api.test.ts:23 `beforeEach`
- 期望行为: 四个测试服务均以各自临时目录构造并传入真实 Cookie 服务，原频道/提醒、数据库浏览、下载、设置/代理测试无需生产代码 fallback 即可继续运行。
- 范围边界:
  - 必须: 每个调用点显式传递已初始化的 Cookie 服务，并保持目录彼此隔离。
  - 不能: 不能共享全局 Cookie 目录、使用仓库目录保存测试 Cookie，或跳过服务初始化。
  - 不做: 不在这些套件新增 Cookie API 行为测试；Cookie API 行为由 task-02 的专用套件负责。
- 验收标准:
  1. `npm test -- --run test/integration/channel-notification-api.test.ts test/integration/database-browser.test.ts test/integration/download-api.test.ts test/integration/settings-proxy-api.test.ts --maxWorkers=1` → 四组原 API 回归测试通过
  2. `rg -n "createApiRouter\(" test/integration/{channel-notification-api,database-browser,download-api,settings-proxy-api}.test.ts` → 四个显式依赖注入入口仍可定位

## task-04 · 验证 Cookie 存储的服务生命周期边界
- 状态: done
- 依赖: task-02
- 文件范围:
  - test/integration/server-lifecycle.test.ts
- 关键约束:
  - 不能增加新的生命周期事件、后台校验器、定时清理任务或启动 fallback 目录。
  - 必须使用 `dirname(databasePath)/cookies` 验证目录初始化、`0700` 权限、固定已有文件 `0600` 权限和精确临时文件清理。
  - 必须证明目录类型错误、权限修正失败或初始化失败时 HTTP 不启动，且错误日志不泄露 Cookie 内容或固定保存路径。
- 任务目的: 证明 Cookie 敏感文件初始化服从现有 `startServer` 启动失败与清理契约。
- 实现入口: test/integration/server-lifecycle.test.ts:43 `createConfig`、test/integration/server-lifecycle.test.ts:114 `describe('server lifecycle')`
- 期望行为: 正常启动会在数据库同目录准备安全 Cookie 存储并清理本模块残留临时文件；任何安全初始化失败均在监听端口前显式拒绝启动，现有启动与停止事件序列保持原样。
- 范围边界:
  - 必须: 覆盖新目录、已有固定文件、精确临时残留、未知文件保留、非目录/非普通文件和失败不监听。
  - 不能: 不能宽泛删除 `cookies/` 内未知文件，不能回退到 `/tmp`、当前目录或 `/downloads`。
  - 不做: 不测试 Cookie API 请求或前端页面行为。
- 验收标准:
  1. `npm test -- --run test/integration/server-lifecycle.test.ts --maxWorkers=1` → 生命周期及 Cookie 目录安全测试通过
  2. `npm run build` → 干净构建包含 Cookie 初始化接线与新资源

## task-05 · 新增授权管理页面、导航与浏览器交互
- 状态: done
- 依赖: task-02
- 文件范围:
  - src/routes/pages.ts
  - src/views/partials/header.ejs
  - src/views/authorizations.ejs (新建)
  - src/public/authorizations.js (新建)
  - src/styles/main.scss
- 关键约束:
  - 不能渲染 Vimeo、自定义平台、多个账号或 Cookie 以外的授权类型；页面平台固定为 YouTube、Bilibili、X、Facebook、抖音。
  - 必须新增 `/authorizations` 页面和“授权管理”导航激活态，展示固定状态、仅已配置时显示更新时间与删除操作、安全导出说明及“尚未接入业务流程”警告。
  - 上传必须直接把所选 `File` 作为 `application/octet-stream` 请求体，不能调用 `File.text()`，不能把 File、文件名、路径或内容写入 DOM 状态、URL、localStorage 或分析事件。
  - 必须在上传成功或失败后清空文件控件，删除前使用固定平台中文名确认目标，并只用 API 返回元数据更新页面状态。
- 任务目的: 提供 PRD 用户故事要求的独立授权入口、五平台状态管理操作和敏感凭据安全提示。
- 实现入口: src/routes/pages.ts:14 `PAGE_ROUTES`、src/routes/pages.ts:29 `createPagesRouter`、src/views/partials/header.ejs:16 `.sidebar-nav`、新建（src/views/authorizations.ejs、src/public/authorizations.js）、src/styles/main.scss:1491 移动端媒体查询
- 期望行为: 用户能在统一页面查看五个平台状态，选择文件上传或替换，确认后删除，并看到项目现有中国标准时间格式的更新时间；页面在桌面和移动端均有明确状态、操作区、安全说明和失败提示，且从不读取或展示 Cookie 内容。
- 范围边界:
  - 必须: 复用现有页面壳层、Bootstrap、外部脚本和时间格式工具，固定中文平台名称和 API 标识映射。
  - 不能: 不能预填文件控件、预览文件、显示条目数/域名/文件名/路径，或在未配置状态渲染虚构时间和可执行删除按钮。
  - 不做: 不实现远端验证、自动续期、过期提醒、导出、查看、下载或业务任务触发。
- 验收标准:
  1. `npm run build` → EJS、外部脚本与 SCSS 资源成功进入构建产物
  2. `rg -n "File\.text|localStorage|vimeo|Vimeo" src/views/authorizations.ejs src/public/authorizations.js` → 无匹配
  3. `rg -n "authorizations" src/routes/pages.ts src/views/partials/header.ejs src/views/authorizations.ejs src/public/authorizations.js` → 页面、导航、模板和脚本入口均命中

## task-06 · 覆盖授权页面的固定渲染与敏感信息边界
- 状态: done
- 依赖: task-03, task-05
- 文件范围:
  - test/integration/pages.test.ts
- 关键约束:
  - 不能通过放宽页面测试夹具中的 `createApiRouter` 必填依赖来启动测试；必须使用临时 Cookie 目录和真实服务。
  - 必须断言导航、五个平台、未配置/已配置状态、时间、上传/替换文案、目标平台删除确认、安全获取说明和未接入业务流程提示。
  - 必须用敏感标记证明服务端 HTML、浏览器脚本状态和 DOM 契约不注入 Cookie 原文、字段、文件名、路径、预览或下载能力。
- 任务目的: 以页面集成测试证明授权管理 UI 的固定平台、操作和不泄密验收边界。
- 实现入口: test/integration/pages.test.ts:33 `beforeEach`、test/integration/pages.test.ts:322 `describe('server-rendered pages')`、test/integration/pages.test.ts:1151 删除确认测试
- 期望行为: `/authorizations` 使用共享页面壳层并正确激活导航；五张固定平台卡片及安全文案可机械断言；脚本只发送二进制 File、只保留元数据并清空控件，页面不出现 Vimeo 或 Cookie 内容。
- 范围边界:
  - 必须: 将 `/authorizations` 纳入共享壳层和“仅外部 JavaScript/CSS”参数化测试，并覆盖移动端样式选择器。
  - 不能: 不能在测试失败消息中输出完整 Cookie 请求体或捕获日志原文。
  - 不做: 不重复测试文件系统原子性、API 错误映射或启动权限；这些分别属于 task-01、task-02、task-04。
- 验收标准:
  1. `npm test -- --run test/integration/pages.test.ts --maxWorkers=1` → 授权页面与既有页面集成测试通过
  2. `rg -n "authorizations|授权管理" test/integration/pages.test.ts` → 页面路由、导航和行为断言可定位

## task-07 · 更新当前能力文档并撤销 Vimeo 官方支持承诺
- 状态: done
- 依赖: task-03
- 文件范围:
  - README.md
  - CHANGELOG.md
  - src/views/downloads.ejs
  - test/integration/download-service.test.ts
  - test/integration/download-api.test.ts
- 关键约束:
  - 不能把“撤销官方支持”实现成 Vimeo 域名黑名单、extractor 黑名单或 `downloads.platform` 枚举收紧。
  - 必须从当前支持表、下载帮助、真实站点冒烟矩阵和“官方已验证”测试样例移除 Vimeo，通用直下载主样例改为中性 HTTPS 站点。
  - 必须保留一个明确命名的“无 Vimeo 域名黑名单”兼容用例，只证明 Vimeo URL 继续进入通用 yt-dlp 单资源和必要元数据校验，不将其表述为官方支持或验证。
  - README 必须补充授权管理入口、五平台范围、Netscape 保存边界、凭据安全、`/data` 备份含 Cookie、保存但未接入频道/探测/下载的限制，并删除“没有 cookies 来源”和“cookies 配置不提供”等过时表述。
- 任务目的: 同步 v0.3 用户可见能力与安全运维说明，并准确区分 Vimeo 承诺撤销和通用 HTTPS 兼容。
- 实现入口: README.md:9 当前功能、README.md:33 支持范围、README.md:71 页面说明、README.md:131 数据与运维、README.md:192 本地验证、CHANGELOG.md:5 `Unreleased`、src/views/downloads.ejs:50 平台地址规则、test/integration/download-service.test.ts:408 通用 HTTPS 探测用例、test/integration/download-api.test.ts:383 通用直下载用例
- 期望行为: 当前文档和帮助只把 YouTube、Bilibili、X、Facebook、抖音列入相应官方范围，同时明确任何 HTTPS URL 仍走既有通用探测；测试使用中性主样例并单独证明 Vimeo 没有被特殊拒绝；授权管理和备份安全边界在 README 与 CHANGELOG 可见。
- 范围边界:
  - 必须: 保留通用 HTTPS、恰好单条目和必要元数据契约，并使文档明确 Cookie 等同登录凭据且当前不参与业务执行。
  - 不能: 不能修改 `src/services/download.ts`、`src/yt-dlp.ts`、`src/public/downloads.js`、历史 `docs/designs/v0.1/*` 或数据库 migration。
  - 不做: 不承诺 Vimeo 冒烟、专门兼容、远端验证或未来 yt-dlp 修复。
- 验收标准:
  1. `npm test -- --run test/integration/download-service.test.ts test/integration/download-api.test.ts --maxWorkers=1` → 中性 HTTPS 主样例与无 Vimeo 黑名单兼容用例通过
  2. `rg -n "授权管理|Cookie|cookies|/data" README.md CHANGELOG.md` → 新能力、限制与备份敏感性说明可定位
  3. `rg -n "Vimeo" src/views/downloads.ejs README.md` → 不在当前下载帮助或 README 中留下官方支持表述

## task-08 · 固化 Vimeo 历史记录与未知平台显示兼容
- 状态: done
- 依赖: task-06, task-07
- 文件范围:
  - test/integration/database.test.ts
  - test/integration/pages.test.ts
- 关键约束:
  - 不能删除、迁移、改名或拒绝历史 `platform = 'vimeo'`，也不能把直下载平台字段收紧到五个 Cookie 平台。
  - 必须显式插入并读取历史 `vimeo` 与另一个非空未知平台值，证明现有 `downloads.platform <> ''` 契约保持开放。
  - 必须证明当前帮助不再出现 Vimeo，同时历史 `vimeo` 仍显示为 `Vimeo`、未知平台继续显示数据库原值。
- 任务目的: 证明 Vimeo 官方承诺撤销不会破坏升级前下载记录或现有未知平台回退显示。
- 实现入口: test/integration/database.test.ts:269 migration 后直下载平台约束断言、test/integration/pages.test.ts:597 下载卡片渲染测试
- 期望行为: 数据库迁移后可同时保存、查询 `vimeo` 和任意其他非空平台值；下载页面脚本继续使用既有 `vimeo: 'Vimeo'` 映射及 `platformLabels[value] ?? value` 回退，但当前帮助文案不把 Vimeo 列为支持平台。
- 范围边界:
  - 必须: 同时测试数据库持久化和页面显示两条读取路径，且不依赖新增 migration。
  - 不能: 不能修改 `src/public/downloads.js` 的历史映射、`003-generic-direct-downloads.sql` 或 `006-bilibili-channels.sql`。
  - 不做: 不为 Vimeo 增加新的提交入口、平台特例、Cookie 关联或真实站点测试。
- 验收标准:
  1. `npm test -- --run test/integration/database.test.ts test/integration/pages.test.ts --maxWorkers=1` → 历史 Vimeo 与未知平台持久化/显示测试通过
  2. `rg -n "vimeo|Vimeo|unknown|未知" test/integration/database.test.ts test/integration/pages.test.ts` → 两类历史兼容断言可定位

## task-09 · 证明已保存 Cookie 不进入任何 yt-dlp 业务参数
- 状态: done
- 依赖: task-03, task-07
- 文件范围:
  - test/integration/yt-dlp.test.ts
  - test/integration/channel-initial-sync.test.ts
  - test/integration/channel-scheduled-check.test.ts
  - test/integration/download-worker.test.ts
  - test/integration/download-api.test.ts
- 关键约束:
  - 不能给频道服务、下载服务、worker、scheduler 或 `YtDlpTaskManager` 注入 Cookie 服务、文件路径、平台状态或新的测试专用 Cookie 参数入口。
  - 必须先在各测试 sandbox 保存合法 Cookie，再从真实子进程 argv 或任务输入边界断言不存在 `--cookies`、`--cookies-from-browser`、Cookie 请求头、环境变量或其他 Cookie 引用。
  - 必须覆盖频道首次同步、手动/定时检查、直接下载元数据探测、排队参数、媒体下载和缩略图调用；原代理、日期、单资源和下载参数断言保持不变。
- 任务目的: 证明 v0.3 只保存 Cookie，尚未将其接入频道同步、元数据探测或媒体下载流程。
- 实现入口: test/integration/yt-dlp.test.ts:114 直连 fetch 参数断言、test/integration/channel-initial-sync.test.ts:108 fake yt-dlp argv、test/integration/channel-scheduled-check.test.ts:80 fake yt-dlp argv、test/integration/download-worker.test.ts:764 argv 日志断言、test/integration/download-api.test.ts:383 直接下载探测用例
- 期望行为: 即使对应平台 Cookie 已配置，所有现有 yt-dlp 调用仍只包含原有固定参数、可选代理和目标 URL；下载 API 返回和排队对象不新增 Cookie 字段，保存 Cookie 不触发任务、远端验证或后台活动。
- 范围边界:
  - 必须: 断言实际 argv 和队列对象均无 Cookie 选项，并验证配置保存前后任务快照没有额外操作。
  - 不能: 不能仅靠页面文案或源码字符串搜索代替运行时边界测试，也不能在失败 diff 中打印 Cookie 原文。
  - 不做: 不修改 `src/services/channel.ts`、`src/services/download.ts`、`src/download-worker.ts`、`src/yt-dlp.ts` 或 `src/yt-dlp-task-manager.ts`。
- 验收标准:
  1. `npm test -- --run test/integration/yt-dlp.test.ts test/integration/channel-initial-sync.test.ts test/integration/channel-scheduled-check.test.ts test/integration/download-worker.test.ts test/integration/download-api.test.ts --maxWorkers=1` → 全部 yt-dlp 隔离边界测试通过
  2. `rg -n "cookies-from-browser|--cookies|cookie" test/integration/{yt-dlp,channel-initial-sync,channel-scheduled-check,download-worker,download-api}.test.ts` → 负向参数断言可定位
  3. `npm test -- --run --maxWorkers=1 && npm run build` → 单 worker 全量测试与构建通过

## task-10 · 限定授权卡片的配置状态显示
- 状态: done
- 依赖: task-05, task-06
- 文件范围:
  - src/views/authorizations.ejs
  - src/public/authorizations.js
  - test/integration/pages.test.ts
- 关键约束:
  - 元数据返回前和加载失败后必须隐藏卡片状态区域，只有成功取得元数据后才允许显示“未配置”或“已配置”。
  - 必须继续使用既有页面级固定错误处理加载失败，不能新增第三种配置状态或卡片级猜测状态。
  - 不能改动授权页面以外的页面状态、API 契约或相邻无关功能。
- 任务目的: 修复 bugfix-01 描述的问题
- 实现入口: src/views/authorizations.ejs:36 授权状态初始标记、src/public/authorizations.js:71 `renderConfiguration`、test/integration/pages.test.ts:397 授权页面渲染测试与 :564 浏览器交互测试
- 原始 bugfix 描述: `src/views/authorizations.ejs:36` 当前初始渲染“正在加载”，API 失败时会永久保留契约外第三种状态。元数据返回前应隐藏状态区域；成功后仅显示“未配置”或“已配置”，失败时保持隐藏并使用既有页面级固定错误。
- 期望行为: `/authorizations` 初始渲染和加载失败时不展示配置状态；加载成功后五张卡片的状态区域可见且文本只可能是“未配置”或“已配置”。
- 范围边界:
  - 必须: 覆盖服务端初始 HTML、加载成功和加载失败三条状态可见性路径。
  - 不能: 不能改动与本 bug 无关的模块，不能新增“加载中”“未知”或其他配置状态。
  - 不做: 不修改上传、替换、删除、时间格式或 Cookie API 行为。
- 验收标准:
  1. `npm test -- --run test/integration/pages.test.ts --maxWorkers=1` → 授权页面初始、成功和失败状态测试通过
  2. `rg -n "data-authorization-status.*hidden|status\.hidden" src/views/authorizations.ejs src/public/authorizations.js test/integration/pages.test.ts` → 状态隐藏与成功显示边界可定位

## task-11 · 初始化时拒绝非普通 pending 路径
- 状态: done
- 依赖: task-01, task-04
- 文件范围:
  - src/services/cookie-authorization.ts
  - test/unit/cookie-authorization.test.ts
  - test/integration/server-lifecycle.test.ts
- 关键约束:
  - 清理每个固定 pending 路径前必须使用 `lstat` 判断文件类型，只允许删除普通文件；`ENOENT` 是唯一允许继续的缺失情况。
  - 符号链接、FIFO、目录及其他非普通类型或文件系统错误必须映射为固定 `PERSISTENCE_ERROR / cookie persistence failed` 并阻止启动监听。
  - 不能跟随符号链接、宽泛扫描或删除未知文件，也不能改动与本 bug 无关的模块。
- 任务目的: 修复 bugfix-02 描述的问题
- 实现入口: src/services/cookie-authorization.ts:244 `CookieAuthorizationService.initialize`、test/unit/cookie-authorization.test.ts:135 初始化清理测试、test/integration/server-lifecycle.test.ts:109 `expectCookieInitializationFailure`
- 原始 bugfix 描述: `src/services/cookie-authorization.ts:261` 清理固定 pending 路径前未用 lstat 验证普通文件，符号链接或 FIFO 会被静默删除并继续启动。仅普通文件允许清理，ENOENT 允许通过，其他类型或文件系统错误必须统一快速失败，并增加对应安全边界测试。
- 期望行为: 初始化只清理本模块精确命名的普通 pending 文件；固定 pending 路径为符号链接、FIFO、目录或发生文件系统错误时快速失败，且 HTTP 不开始监听。
- 范围边界:
  - 必须: 覆盖普通文件清理、`ENOENT`、符号链接和至少一种其他非普通文件类型，并验证启动失败边界。
  - 不能: 不能改动与本 bug 无关的模块，不能递归清理、跟随链接或放宽固定临时文件名集合。
  - 不做: 不修改上传提交、最终 Cookie 文件读取、删除配置或后台清理流程。
- 验收标准:
  1. `npm test -- --run test/unit/cookie-authorization.test.ts test/integration/server-lifecycle.test.ts --maxWorkers=1` → pending 文件类型与启动失败边界测试通过
  2. `rg -n "lstat|temporaryPath|pending" src/services/cookie-authorization.ts test/unit/cookie-authorization.test.ts test/integration/server-lifecycle.test.ts` → 固定 pending 路径校验入口可定位

## task-12 · 补齐已配置 Cookie 失败替换的原子性测试
- 状态: done
- 依赖: task-01
- 文件范围:
  - test/unit/cookie-authorization.test.ts
- 关键约束:
  - 必须从已配置状态分别覆盖无效格式、`sync`、`utimes` 和 `rename` 失败，逐次证明旧文件摘要、`configured`、`updatedAt` 与磁盘 `mtime` 不变。
  - 断言和失败 diff 只能使用布尔值、摘要和时间，不能包含 Cookie 原文、字段、文件名、服务器路径或底层异常。
  - 不能为了制造失败而修改生产服务契约或改动与本 bug 无关的模块。
- 任务目的: 修复 bugfix-03 描述的问题
- 实现入口: test/unit/cookie-authorization.test.ts:311 `keeps the prior file and mtime unchanged when replacement persistence fails` 测试及同文件持久化失败夹具
- 原始 bugfix 描述: `test/unit/cookie-authorization.test.ts:311` 未证明已配置文件在无效格式替换及 sync、utimes 或 rename 提交失败时保持旧内容、旧状态和旧 mtime。增加不泄露原文的摘要、布尔状态及 mtime 断言，覆盖校验失败和原子提交失败。
- 期望行为: 任一校验或原子提交阶段失败后，已配置平台仍指向原文件，配置状态、更新时间和磁盘修改时间均与替换前完全一致，失败输出不泄露敏感原值。
- 范围边界:
  - 必须: 对四类失败分别建立替换前后快照并机械比较摘要、布尔状态、`updatedAt` 和 `mtime`。
  - 不能: 不能改动与本 bug 无关的模块，不能直接断言 Cookie 原文或把底层错误对象交给 matcher。
  - 不做: 不扩展 Cookie 格式、平台集合、并发行为或 API 错误映射。
- 验收标准:
  1. `npm test -- --run test/unit/cookie-authorization.test.ts --maxWorkers=1` → 已配置文件的四类失败替换测试通过
  2. `rg -n "sync|utimes|rename|mtime|fileDigest" test/unit/cookie-authorization.test.ts` → 原子性失败阶段及非敏感快照断言可定位

## task-13 · 完整断言 yt-dlp 子进程无 Cookie 参数与环境变量
- 状态: done
- 依赖: task-09
- 文件范围:
  - test/integration/yt-dlp.test.ts
  - test/integration/channel-initial-sync.test.ts
  - test/integration/channel-scheduled-check.test.ts
  - test/integration/download-worker.test.ts
  - test/integration/download-api.test.ts
- 关键约束:
  - 所有真实子进程边界 helper 必须同时拒绝独立参数 `--cookies`、`--cookies-from-browser` 和等号参数 `--cookies=...`、`--cookies-from-browser=...`。
  - 必须检查环境变量名是否含 Cookie 引用，并只把非敏感布尔结果写入调用记录和 matcher；现有对敏感值及 Cookie 存储路径的拒绝断言必须保留。
  - 不能输出环境变量原值、完整子进程环境或 Cookie 参数值，也不能改动生产 yt-dlp 参数生成逻辑及相邻无关功能。
- 任务目的: 修复 bugfix-04 描述的问题
- 实现入口: test/integration/yt-dlp.test.ts:28 `expectNoCookieArguments`、test/integration/channel-initial-sync.test.ts:156 `expectNoCookieReferences`、test/integration/channel-scheduled-check.test.ts:135 `expectNoCookieReferences`、test/integration/download-worker.test.ts:181 `expectNoCookieReferences`、test/integration/download-api.test.ts:182 `expectNoCookieReferences`
- 原始 bugfix 描述: `test/integration/download-api.test.ts:182` 及 task-09 同类 helper 未拒绝 `--cookies=...`、`--cookies-from-browser=...`，也未检查 Cookie 相关环境变量名。所有真实子进程边界测试需覆盖独立与等号参数形式，并只用非敏感布尔结果断言环境变量名不存在。
- 期望行为: 保存 Cookie 后，频道同步、定时检查、直接下载探测、媒体下载和缩略图等真实子进程记录均证明 argv 不含任何独立或等号 Cookie 选项，环境变量名和值也不含 Cookie 引用。
- 范围边界:
  - 必须: 统一五个测试边界的负向参数形式和环境变量名布尔检查，保留现有业务参数断言。
  - 不能: 不能改动与本 bug 无关的模块，不能记录或比较完整环境对象、敏感原值或 Cookie 文件内容。
  - 不做: 不给生产服务注入 Cookie 服务，不修改 `src/yt-dlp.ts`、worker、scheduler 或任务管理器。
- 验收标准:
  1. `npm test -- --run test/integration/yt-dlp.test.ts test/integration/channel-initial-sync.test.ts test/integration/channel-scheduled-check.test.ts test/integration/download-worker.test.ts test/integration/download-api.test.ts --maxWorkers=1` → 全部真实子进程 Cookie 隔离测试通过
  2. `rg -n "cookies=|cookies-from-browser=|cookieEnvironment" test/integration/{yt-dlp,channel-initial-sync,channel-scheduled-check,download-worker,download-api}.test.ts` → 等号参数与环境变量边界断言可定位

## task-14 · 递归验证下载队列对象无 Cookie 引用
- 状态: failed
- 依赖: task-09
- 文件范围:
  - test/integration/download-api.test.ts
- 关键约束:
  - 必须对完整排队对象的所有嵌套字段名与字符串值执行确定性的 Cookie 引用检查，覆盖 `advancedOptions` 等嵌套对象。
  - 断言只能暴露是否存在引用的布尔结果，不能把完整队列对象、Cookie 原文、路径或状态对象交给 matcher。
  - 不能发明队列字段别名、放宽固定队列契约或改动与本 bug 无关的模块。
- 任务目的: 修复 bugfix-05 描述的问题
- 实现入口: test/integration/download-api.test.ts:199 `expectNoCookieQueueFields`
- 原始 bugfix 描述: `test/integration/download-api.test.ts:199` 只检查排队对象顶层字段和值，无法发现 `advancedOptions` 等嵌套对象中的 Cookie 字段、路径或状态。对完整队列对象递归检查所有字段名与字符串值，或精确断言嵌套固定结构。
- 期望行为: 下载 API 排队对象任意嵌套层级中的字段名或字符串值一旦引用 Cookie 即被测试捕获，正常固定队列结构继续通过且失败信息不泄露原对象。
- 范围边界:
  - 必须: 覆盖顶层与至少一个嵌套对象的字段名、敏感标记和 Cookie 存储路径检查。
  - 不能: 不能改动与本 bug 无关的模块，不能在失败 diff 中打印完整排队对象或敏感字符串。
  - 不做: 不修改下载队列生产结构、下载 API 响应或 yt-dlp 参数生成。
- 验收标准:
  1. `npm test -- --run test/integration/download-api.test.ts --maxWorkers=1` → 完整队列对象的递归 Cookie 边界测试通过
  2. `rg -n "expectNoCookieQueueFields|advancedOptions|recursive|cookie" test/integration/download-api.test.ts` → 嵌套队列检查入口可定位

## task-15 · 使用真正未知平台验证数据库开放契约
- 状态: pending
- 依赖: task-08
- 文件范围:
  - test/integration/database.test.ts
- 关键约束:
  - 迁移后测试必须保留 `vimeo` 历史样例，并另用一个明确不属于当前平台集合的固定非空值验证写入和原值读取。
  - 不能使用已知的 `generic` 充当未知平台，不能收紧 `downloads.platform` 约束、增加 migration 或改写历史数据。
  - 不能改动与本 bug 无关的模块。
- 任务目的: 修复 bugfix-06 描述的问题
- 实现入口: test/integration/database.test.ts:220 `migrates schema 2 downloads and preserves Vimeo and unknown direct platform values` 测试、:269 迁移后未知平台插入断言
- 原始 bugfix 描述: `test/integration/database.test.ts:269` 使用已知的 `generic` 代表未知平台，未证明 `downloads.platform` 接受任意非空历史值。保留 Vimeo 样例，并改用明确不属于当前平台集合的固定未知值进行迁移后写入和原值读取断言。
- 期望行为: 从 schema 2 升级后，数据库同时接受并原样返回历史 `vimeo` 和一个不属于已知平台集合的固定非空平台值，现有记录与外键保持有效。
- 范围边界:
  - 必须: 同时断言未知值写入不抛错、查询结果保持原值以及 Vimeo 样例仍存在。
  - 不能: 不能改动与本 bug 无关的模块，不能修改 migration、平台生产枚举或历史值映射。
  - 不做: 不增加未知平台展示、提交入口、平台别名或 Cookie 关联。
- 验收标准:
  1. `npm test -- --run test/integration/database.test.ts --maxWorkers=1` → 迁移后的 Vimeo 与真正未知平台持久化测试通过
  2. `rg -n "vimeo|unknown|unrecognized|platform" test/integration/database.test.ts` → 历史与未知平台样例可定位

## task-16 · 防止安全测试 matcher 泄露敏感原值
- 状态: pending
- 依赖: task-04, task-06
- 文件范围:
  - test/integration/pages.test.ts
  - test/integration/server-lifecycle.test.ts
- 关键约束:
  - 可能含敏感文件名、路径、底层异常、日志或 Cookie 标记的对象必须先转换为布尔结果或非敏感摘要，再交给 matcher。
  - 必须保留对每个敏感标记不存在的机械断言，同时确保断言失败时 Vitest diff 不包含被检查的原始值。
  - 不能删除安全边界断言、降低覆盖范围或改动与本 bug 无关的模块。
- 任务目的: 修复 bugfix-07 描述的问题
- 实现入口: test/integration/pages.test.ts:682 授权浏览器状态断言与 :719 可见状态敏感标记断言、test/integration/server-lifecycle.test.ts:109 `expectCookieInitializationFailure` 与 :122 启动失败日志断言
- 原始 bugfix 描述: `test/integration/pages.test.ts:682` 与 `test/integration/server-lifecycle.test.ts:122` 将可能含敏感文件名、路径、底层异常或日志内容的原始对象交给 matcher，回归时 Vitest diff 会泄露原值。先转换为布尔值或非敏感摘要再断言，并保留仅对标记存在性的布尔检查。
- 期望行为: 授权页面和服务启动安全测试继续证明敏感标记未进入可见状态、异常或日志，同时任何 matcher 失败只显示布尔值或非敏感摘要。
- 范围边界:
  - 必须: 审核并改写两处测试中直接比较敏感承载对象的 matcher，保留标记存在性检查。
  - 不能: 不能改动与本 bug 无关的模块，不能把原始请求、DOM 状态、日志记录、异常对象或路径放入失败 diff。
  - 不做: 不修改生产日志、错误消息、页面行为或 Cookie 持久化实现。
- 验收标准:
  1. `npm test -- --run test/integration/pages.test.ts test/integration/server-lifecycle.test.ts --maxWorkers=1` → 页面与启动安全断言通过
  2. `rg -n "includes\(sensitive|some\(.*sensitive|toBe\(false\)" test/integration/pages.test.ts test/integration/server-lifecycle.test.ts` → 非敏感布尔 matcher 可定位
