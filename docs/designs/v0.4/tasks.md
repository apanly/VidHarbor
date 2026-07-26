# Tasks - v0.4

## task-01 · 建立固定双语目录与严格翻译契约
- 状态: done
- 依赖: 无
- 文件范围:
  - src/i18n.ts (新建)
  - src/public/i18n.js (新建)
  - test/unit/i18n.test.ts (新建)
- 关键约束:
  - 不能接受 `zh-CN`、`en` 以外的语言值，不能读取 `Accept-Language`、时区或其他请求信息，也不能做大小写、地区变体、别名或跨语言 fallback。
  - 必须以 `src/i18n.ts` 的扁平字面量目录作为唯一翻译事实源；两种语言键集合完全一致且值均为非空字符串，未知键、未知状态和未知 API 错误码直接抛错。
  - 必须只解析名为 `vidharbor_language` 的 Cookie；内嵌 JSON 至少转义 `<`、U+2028、U+2029，插值结果只能供文本或属性赋值，不能生成 HTML。
- 任务目的: 实现 PRD 1.1、1.3 及设计 5.1、5.3 的唯一双语目录、精确语言选择和服务端/浏览器严格查找基础。
- 实现入口: 新建（src/i18n.ts、src/public/i18n.js、test/unit/i18n.test.ts）
- 期望行为: 服务端导出唯一语言集合 `zh-CN`/`en`、默认语言 `zh-CN`、Cookie 名、精确 Cookie 选择、严格 `t`、目录校验和安全 JSON；浏览器模块从 `<html lang>` 与内嵌 `application/json` 读取同一已选目录并导出严格 `t`、错误展示、数字与文件大小格式化能力；`src/errors.ts:1` 的全部既有错误码都有固定展示映射，未确认值快速失败。
- 范围边界:
  - 必须: 覆盖缺失、空值、无效值、大小写变体、重复 Cookie 名的确定性选择，以及目录键集合、非空值、插值和安全序列化正反测试。
  - 不能: 不能增加第三方 i18n/Cookie/日期依赖、嵌套目录、运行时网络请求、默认翻译值或自动生成键。
  - 不做: 不修改 API、数据库、业务状态、路由或页面模板；页面接线由后续任务完成。
- 验收标准:
  1. `npm test -- --run test/unit/i18n.test.ts --maxWorkers=1` → 固定语言、Cookie、目录、严格查找与安全序列化测试通过
  2. `npm run build` → 新增 TypeScript 模块与浏览器模块可构建并复制到 `dist`

## task-02 · 将语言选择接入页面路由与双 README 预渲染
- 状态: done
- 依赖: task-01
- 文件范围:
  - src/routes/pages.ts
- 关键约束:
  - 不能新增语言路由、设置 API、请求字段或按 Cookie 拼接文件路径；原始 Cookie 值不能进入 HTML、日志或路径。
  - 必须在 `createPagesRouter` 初始化时固定读取 `README.md` 和 `README.en.md`，分别校验唯一且顺序正确的排除标记并预渲染；任一文件损坏都必须阻止路由建立。
  - 必须让全部现有页面 GET 使用同一次选出的 `language`、严格 `t` 和安全目录 JSON，页面标题改为固定翻译键。
- 任务目的: 落地设计 2.1、5.2、5.6 的服务端语言选择、页面 locals 与双语说明来源，不改变现有路由集合。
- 实现入口: src/routes/pages.ts:14 `PAGE_ROUTES`、src/routes/pages.ts:30 `createPagesRouter`
- 期望行为: 无 Cookie、空值或任意无效值渲染中文，精确 `en` 渲染英文；`/guide` 仅以已验证语言索引固定缓存的中文或英文 README HTML；`/channels/:id` 和 `/downloads/preview` 等参数化页面继续使用原路由与业务参数。
- 范围边界:
  - 必须: 保留 8 个 `PAGE_ROUTES` 页面、`/guide`、`/channels/:id` 及所有既有 activePath 语义，并把同一目录同时交给 EJS 和浏览器。
  - 不能: 不能读取 `Accept-Language`、请求时读 README、翻译 README HTML、吞掉标记错误或把损坏文件降级为空说明。
  - 不做: 不修改 `src/app.ts`、API Router、服务层、README 正文或浏览器切换行为。
- 验收标准:
  1. `npm run build` → 页面路由的双语 locals、固定 README 映射和严格类型通过编译
  2. `node --input-type=module -e "import('./dist/routes/pages.js').then(({createPagesRouter})=>createPagesRouter())"` → 两份 README 标记有效时路由可初始化

## task-03 · 本地化共享外壳并实现原地语言切换
- 状态: done
- 依赖: task-02
- 文件范围:
  - src/views/partials/language-switcher.ejs (新建)
  - src/views/partials/header.ejs
  - src/views/partials/footer.ejs
  - src/public/shell.js
  - src/styles/main.scss
- 关键约束:
  - 不能用固定目标链接或重建 URL 切换语言，不能设置 `Expires`、`Max-Age`、`Secure`、业务存储或额外 Cookie 属性。
  - 必须只接受按钮上精确的 `zh-CN`/`en`，写入 `vidharbor_language=<值>; Path=/; SameSite=Lax` 后调用 `location.reload()`，以保留 pathname、query 和 hash。
  - 必须让 `<html lang>`、标题、主导航、移动菜单、全部共享 `aria-label` 和当前语言状态使用当前目录，并把安全 JSON 作为 `application/json` 内嵌。
- 任务目的: 实现 PRD 1.2、1.4 和可访问性要求的共享语言入口、会话 Cookie 与当前页面原地刷新。
- 实现入口: src/views/partials/header.ejs:2 `<html lang>` 与 :14 `.app-sidebar`、src/views/partials/footer.ejs:4 脚本入口、src/public/shell.js:1 `toggleSidebar`、src/styles/main.scss:14 `.app-sidebar` 与 :1349 窄屏规则
- 期望行为: 所有共享壳层页面显示“中文 / English”按钮，当前项具有 `aria-pressed` 和可见当前态；键盘焦点、桌面侧栏和移动菜单均可用；侧栏开关保持原行为，语言切换不触发写 API 且刷新后由服务端与浏览器共同使用所选语言。
- 范围边界:
  - 必须: 复用一个 partial，同时支持共享壳层与后续独立预览页；footer 以 ES module 加载 shell 脚本。
  - 不能: 不能增加语言选择 API、localStorage、账号设置、自动协商、第二套导航或新的样式依赖。
  - 不做: 不翻译各业务页面正文；只处理共享壳层、语言入口和既有侧栏行为。
- 验收标准:
  1. `npm run build` → partial、模块脚本和 SCSS 均进入构建产物
  2. `rg -n "aria-pressed|vidharbor_language|SameSite=Lax|location.reload" src/views/partials/language-switcher.ejs src/public/shell.js` → 当前态与精确 Cookie/刷新入口均命中
  3. `rg -n "localStorage|Accept-Language|location.href" src/views/partials src/public/shell.js` → 无匹配

## task-04 · 统一本地化日期、数字、文件大小与分页
- 状态: done
- 依赖: task-03
- 文件范围:
  - src/public/time.js
  - src/public/pagination.js
  - test/unit/i18n.test.ts
- 关键约束:
  - 不能使用运行环境默认 locale/timezone，不能改写传给分页回调的 number，也不能本地化 ID、URL、路径、SQL、表单值或 API 值。
  - 必须使用当前服务端已选语言与原生 `Intl`，时间固定 `Asia/Shanghai`；无效日期返回原值，文件大小继续按 1024 进位、既有单位和最多两位小数。
  - 分页的上一页、下一页、页码 `aria-label` 和摘要必须使用固定翻译键，展示数字本地化但回调参数保持原始页码。
- 任务目的: 实现 PRD 2.3 与设计 5.4 的共享日期、数字、文件大小和分页显示契约。
- 实现入口: src/public/time.js:1 `chinaTimeFormatter` 与 :12 `formatChinaTimestamp`、src/public/pagination.js:1 `renderPagination`、test/unit/i18n.test.ts 中 task-01 建立的格式化测试组
- 期望行为: 同一固定时间戳在 `zh-CN` 与 `en` 下使用各自原生格式且都表示上海时区同一时刻；双语计数与文件大小只改变展示；分页回调、空分页隐藏和页码边界保持现有语义。
- 范围边界:
  - 必须: 使用固定输入测试两种语言输出、无效日期、1024 边界、最多两位小数、分页数字与原始回调值。
  - 不能: 不能自行实现第二套日期算法、猜测输入时区、转换固定 `HH:MM:SS` 或格式化数据库单元格。
  - 不做: 不改变服务端分页大小、查询参数、排序、时间值或业务数据结构。
- 验收标准:
  1. `npm test -- --run test/unit/i18n.test.ts --maxWorkers=1` → 双语时间、数字、文件大小、无效日期和分页边界测试通过
  2. `npm run build` → 共享浏览器模块导入关系构建成功

## task-05 · 完成总览与 yt-dlp 任务区域双语化
- 状态: done
- 依赖: task-04
- 文件范围:
  - src/views/dashboard.ejs
  - src/public/dashboard.js
  - src/public/yt-dlp-tasks.js
- 关键约束:
  - 不能修改任务 ID、API 快照、终态最多 30 条和排序规则，也不能翻译频道自定义名称或第三方失败详情。
  - 必须严格覆盖任务类型 `media_download`、`metadata_probe`、`channel_initial_sync`、`channel_manual_check`、`channel_scheduled_check` 与状态 `queued`、`running`、`succeeded`、`failed`、`canceled`；未知值继续抛错。
  - 不能继续用 `innerHTML` 拼接含动态数据的汇总；用户或业务值必须经 `textContent` 落入 DOM。
- 任务目的: 覆盖 PRD 2.1 中总览页、动态汇总、频道检查、任务表格、空状态与错误的双语显示。
- 实现入口: src/views/dashboard.ejs:1 页面模板、src/public/dashboard.js:6 `showError` 与 :13 `load`、src/public/yt-dlp-tasks.js:32 `fixedLabel`、:47 `taskRow`、:82 `load`
- 期望行为: 标题、任务区、表头、移动端标签、空状态、计数汇总、三种频道检查结果和错误框架均随当前语言变化；计数本地化，任务 ID 原样，失败详情原文保留在本地化框架内。
- 范围边界:
  - 必须: 保持活动状态集合、终态集合、终态倒序与 30 条上限，并严格验证固定类型/状态/检查结果。
  - 不能: 不能新增任务类型、状态、API 请求、轮询、fallback 标签或吞掉未知快照格式。
  - 不做: 不修改 `src/yt-dlp-task-manager.ts`、频道服务、下载服务或 API 响应。
- 验收标准:
  1. `npm run build` → 总览模板和两个模块脚本构建成功
  2. `rg -n "from '/public/i18n.js'|\bt\(" src/public/dashboard.js src/public/yt-dlp-tasks.js` → 两个动态区域均使用公共翻译入口
  3. `rg -n "innerHTML" src/public/dashboard.js src/public/yt-dlp-tasks.js` → 无匹配

## task-06 · 完成下载页面静态与动态双语化
- 状态: done
- 依赖: task-05
- 文件范围:
  - src/views/downloads.ejs
  - src/public/downloads.js
- 关键约束:
  - 不能改变三类页签 `completed`/`active`/`failed`、八种下载状态 `pending`/`running`/`downloading`/`completed`/`failed`/`canceled`/`interrupted`/`deleting`、SSE、表单请求或删除确认业务语义。
  - 必须翻译页面说明、搜索、直下载表单、帮助、空状态、卡片字段、操作、确认和错误框架；标题、URL、路径、ID、时长、表单值与第三方详情保持原值。
  - 平台专有名和历史未知平台显示必须保持既有契约，不能借国际化收紧 `downloads.platform` 或移除 `vimeo` 历史映射/未知值显示。
- 任务目的: 覆盖 PRD 2.1 下载页全部静态文案、动态状态、确认、空状态、分页和格式化展示。
- 实现入口: src/views/downloads.ejs:1 页面模板、src/public/downloads.js:39 `emptyStateFor`、:90 `renderActions`、:109 `createDownloadCard`、:147 `updateDownloadCard`、:171 `renderDownloads`
- 期望行为: 下载页两种语言下使用同一模板和相同业务请求；状态、页签、卡片、模态框、确认和错误严格翻译，计数/文件大小本地化，固定时长与下载 ID 不变，未知状态显式失败。
- 范围边界:
  - 必须: 覆盖八状态、三页签、不同搜索/总数空状态、直下载字段、SSE 更新、预览/下载/取消/重试/删除操作。
  - 不能: 不能改 API、SSE 事件、下载选项、分页规则、平台枚举、文件操作或为未知状态显示原始值。
  - 不做: 不翻译用户标题、媒体地址、存储路径、平台返回详情或 SQL/技术标识。
- 验收标准:
  1. `npm run build` → 下载模板和模块脚本构建成功
  2. `rg -n "from '/public/i18n.js'|\bt\(" src/public/downloads.js` → 动态文案、状态与错误使用公共翻译入口
  3. `rg -n "platformLabels\[download\.platform\].*download\.platform" src/public/downloads.js` → 历史未知平台原值显示契约仍存在

## task-07 · 完成频道列表与首次同步双语化
- 状态: done
- 依赖: task-06
- 文件范围:
  - src/views/channels.ejs
  - src/public/channels.js
- 关键约束:
  - 不能改变频道 URL 识别、平台值、代理/授权提交值、分页参数或首次同步请求结构。
  - 必须严格覆盖首次同步状态 `pending`、`syncing`、`failed`、`succeeded`，最近检查结果 `success`、`no_updates`、`failed`，以及运行/暂停、立即检查、重同步等当前模式；未知状态显式失败。
  - 频道自定义名称、地址、代理名、授权平台值和第三方失败详情不能翻译。
- 任务目的: 覆盖 PRD 2.1 频道页的列表、空状态、新增/编辑、授权/代理、首次同步、操作、确认、分页与错误。
- 实现入口: src/views/channels.ejs:1 页面模板、src/public/channels.js:26 `openChannelCreateModal`、:37 `openChannelEditModal`、:52 `load`、:84 频道提交、:85 首次同步提交
- 期望行为: 两种语言下新增/编辑模态框、首次同步表单、频道卡片字段、状态、操作、确认和错误框架一致切换；平台与用户业务值保持原文，计数和时间使用共享本地化工具。
- 范围边界:
  - 必须: 保持 YouTube/Bilibili 固定平台识别、同平台授权过滤、当前页 query 和所有既有按钮行为。
  - 不能: 不能增加平台、状态、授权 fallback、URL 模糊匹配、自动代理选择或业务请求。
  - 不做: 不修改频道 API、服务、数据库 schema、调度器或首次同步规则。
- 验收标准:
  1. `npm run build` → 频道模板和模块脚本构建成功
  2. `rg -n "pending|syncing|failed|succeeded|success|no_updates" src/public/channels.js` → 固定同步与检查状态仍可定位
  3. `rg -n "from '/public/i18n.js'|\bt\(" src/public/channels.js` → 动态文案与错误使用公共翻译入口

## task-08 · 完成频道详情双语化
- 状态: done
- 依赖: task-07
- 文件范围:
  - src/views/channel-detail.ejs
  - src/public/channel-detail.js
- 关键约束:
  - 不能改变频道 ID、视频 ID、发布日期字符串、视频 URL、固定时长算法、筛选请求、批量下载 payload 或文件链接。
  - 必须严格覆盖下载状态 null 与 `pending`、`running`、`downloading`、`completed`、`failed`、`canceled`、`interrupted`、`deleting`，检查类型 `initial`/`scheduled` 和结果 null/`success`/`no_updates`/`failed`。
  - 用户视频标题、频道名称、地址和失败详情不能进入翻译目录；插值只能经文本/属性赋值。
- 任务目的: 覆盖 PRD 2.1 频道详情的摘要、页签、筛选、批量下载、表格、状态、文件操作、分页与错误。
- 实现入口: src/views/channel-detail.ejs:1 页面模板、src/public/channel-detail.js:68 `updateSelection`、:73 `setChannelTab`、:83 `renderVideo`、:163 `renderCheck`、:186 `loadVideos`、:202 `loadChecks`
- 期望行为: 两种语言下页面控件、移动端标签、选择计数、视频/检查状态、空状态、分页和错误框架完整切换；页面标题可包含原始频道名，日期/计数/文件大小本地化，业务标识和值不变。
- 范围边界:
  - 必须: 保持两个页签、视频搜索、代理选择、批量提交、预览/文件链接和原有完成/失败详情展示。
  - 不能: 不能将发布日期重新解释为时间戳、翻译标题、格式化 ID、猜测未知检查类型或为未知状态回退。
  - 不做: 不修改频道/下载 API、视频可选规则、分页服务或媒体文件行为。
- 验收标准:
  1. `npm run build` → 频道详情模板和模块脚本构建成功
  2. `rg -n "initial|scheduled|success|no_updates|failed" src/public/channel-detail.js` → 固定检查类型和结果映射可定位
  3. `rg -n "from '/public/i18n.js'|\bt\(" src/public/channel-detail.js` → 状态、控件与错误使用公共翻译入口

## task-09 · 完成提醒页面双语化
- 状态: done
- 依赖: task-08
- 文件范围:
  - src/views/notifications.ejs
  - src/public/notifications.js
- 关键约束:
  - 不能改变提醒 ID、视频标题、频道名称、发布日期、分页 query、单条或全部已读 API。
  - 必须翻译未读/已读、单条与全部标记已读、表头、移动端标签、空状态、分页及错误框架，时间使用当前语言与上海时区。
  - 不能把用户/平台业务内容作为翻译键或在缺失键时显示原始状态。
- 任务目的: 覆盖 PRD 2.1 提醒页全部静态和动态文案，同时保持提醒业务契约不变。
- 实现入口: src/views/notifications.ejs:1 页面模板、src/public/notifications.js:9 `showError`、:12 `load`
- 期望行为: 两种语言下提醒说明、表格、读状态、操作、空状态和分页完整切换；视频标题与频道名原样，时间本地化，API 请求和值不变。
- 范围边界:
  - 必须: 覆盖空列表、未读、已读时间、单条已读、全部已读、越界页回退和加载失败。
  - 不能: 不能新增提醒状态、删除能力、自动已读、页面内翻译业务标题或改变分页大小。
  - 不做: 不修改提醒 API、服务、数据库或通知生成规则。
- 验收标准:
  1. `npm run build` → 提醒模板和模块脚本构建成功
  2. `rg -n "from '/public/i18n.js'|\bt\(" src/public/notifications.js` → 读状态、操作和错误使用公共翻译入口

## task-10 · 完成授权管理页面双语化
- 状态: done
- 依赖: task-09
- 文件范围:
  - src/views/authorizations.ejs
  - src/public/authorizations.js
- 关键约束:
  - 不能读取、翻译、展示或记录 Cookie 内容、文件名、路径或字段；不能改变二进制上传、替换、删除和五平台 API 契约。
  - 必须翻译使用范围、安全说明、配置状态、模态框模式、操作、空状态、删除确认、错误与时间；YouTube、Bilibili、X、Facebook、Douyin、Cookie、Netscape 保持确认的专有名称。
  - 未知平台、未知配置状态或未知 API 错误码必须显式失败，不能新增“加载中/未知”等契约外配置状态。
- 任务目的: 覆盖 PRD 2.1 授权管理页的安全说明、固定平台配置状态和全部交互文案。
- 实现入口: src/views/authorizations.ejs:1 页面模板、src/public/authorizations.js:25 `errorMessage`、:79 `openCreateModal`、:91 `openEditModal`、:103 `deleteConfiguration`、:123 `renderList`
- 期望行为: 两种语言下固定五平台列表、配置状态、更新时间、上传/替换、确认和错误完整切换；敏感 Cookie 边界、原始 File 请求体和成功后清空控件行为保持不变。
- 范围边界:
  - 必须: 保持五平台固定顺序/标识、未配置空状态、已配置更新时间、创建/编辑模式和删除确认目标。
  - 不能: 不能增加 Cookie 预览/导出、远端验证、多个账号、平台别名、文件文本读取或敏感信息插值。
  - 不做: 不修改授权 API、Cookie 服务、存储权限、频道授权关联或业务任务。
- 验收标准:
  1. `npm run build` → 授权模板和模块脚本构建成功
  2. `rg -n "from '/public/i18n.js'|\bt\(" src/public/authorizations.js` → 模态框、状态、确认和错误使用公共翻译入口
  3. `rg -n "File\.text|localStorage" src/views/authorizations.ejs src/public/authorizations.js` → 无匹配

## task-11 · 完成配置与代理页面双语化
- 状态: done
- 依赖: task-10
- 文件范围:
  - src/views/settings.ejs
  - src/public/settings.js
- 关键约束:
  - 不能改变设置/代理 API、代理 payload、协议值、端口 number、下载根只读边界或密码脱敏行为。
  - 必须翻译全局设置、代理表格/表单、帮助、占位符、空状态、新增/编辑/删除、确认、保存和错误框架。
  - 代理名、主机、用户名、脱敏密码和 HTTP/HTTPS/SOCKS5 协议值不能翻译或本地化。
- 任务目的: 覆盖 PRD 2.1 配置页和代理管理的静态、动态、确认与错误文案。
- 实现入口: src/views/settings.ejs:1 页面模板、src/public/settings.js:18 `openProxyCreateModal`、:25 `openProxyEditModal`、:38 `load`、:62 设置提交、:63 代理提交
- 期望行为: 两种语言下设置字段、代理列表、模态框、按钮、确认、空状态与错误完整切换，业务字段和值按原契约提交和显示。
- 范围边界:
  - 必须: 保持下载根只读、全局间隔/并发数提交、代理创建/编辑/删除及脱敏密码展示。
  - 不能: 不能格式化端口或提交值、翻译代理数据、自动选择协议、添加连接测试或代理 fallback。
  - 不做: 不修改设置/代理路由、服务、数据库或下载 worker 配置应用逻辑。
- 验收标准:
  1. `npm run build` → 配置模板和模块脚本构建成功
  2. `rg -n "from '/public/i18n.js'|\bt\(" src/public/settings.js` → 模态框、空状态、确认和错误使用公共翻译入口

## task-12 · 完成数据库浏览器页面双语化
- 状态: done
- 依赖: task-11
- 文件范围:
  - src/views/database.ejs
  - src/public/database.js
- 关键约束:
  - 不能翻译或格式化表名、列名、SQL、查询参数和数据库单元格原值，不能改变只读 SQL 校验或结果结构。
  - 必须翻译页面说明、数据表区、只读查询表单、控件状态、结果行列摘要、无数据和查询错误框架；仅摘要计数使用当前语言数字格式。
  - SQL 示例必须保持原文，不能把语言值加入数据库 API 请求。
- 任务目的: 覆盖 PRD 2.1 数据库页的固定控件和结果框架，同时保护数据库原始值边界。
- 实现入口: src/views/database.ejs:1 页面模板、src/public/database.js:20 `showError`、:25 `renderResult`、:72 `executeQuery`、:85 `loadTables`
- 期望行为: 两种语言下数据库页面外壳、查询按钮、摘要、空状态和错误切换；表名、列名、SQL、单元格内容及点击表名生成的查询完全不变。
- 范围边界:
  - 必须: 覆盖表列表、查询进行状态、有结果/无结果摘要和失败显示，并保持单元格 `title` 原值。
  - 不能: 不能本地化数据库数字、日期或布尔值，不能修改 SQL、增加写查询或隐藏敏感列。
  - 不做: 不修改数据库 API、只读验证、schema、migration 或权限模型。
- 验收标准:
  1. `npm run build` → 数据库模板和模块脚本构建成功
  2. `rg -n "from '/public/i18n.js'|\bt\(" src/public/database.js` → 摘要、控件和错误使用公共翻译入口
  3. `rg -n "cell\.textContent = value === null \? '' : String\(value\)" src/public/database.js` → 数据库单元格原值显示契约仍存在

## task-13 · 完成系统说明与独立下载预览双语化
- 状态: done
- 依赖: task-12
- 文件范围:
  - src/views/guide.ejs
  - src/views/download-preview.ejs
  - src/public/download-preview.js
- 关键约束:
  - 不能修改 `src/public/guide.js`，不能翻译或重新处理已由路由固定预渲染的 README HTML。
  - 独立预览页必须使用当前 `<html lang>`、同一安全目录、共享语言切换 partial 和模块脚本；切换只能刷新当前带 `id` query 的 URL。
  - 下载 ID、API 路径、媒体地址和下载标题必须保持原值；未知错误码不能回退显示原始枚举。
- 任务目的: 完成 PRD 2.1、2.4 的双语系统说明控件和独立下载预览文档/错误体验。
- 实现入口: src/views/guide.ejs:1 页面模板、src/views/download-preview.ejs:1 独立文档、src/public/download-preview.js:5 `parseDownloadId`、:7 `renderPreview`、:15 `load`
- 期望行为: `/guide` 的快速目录和辅助文本随语言切换，正文分别来自固定 README；预览页标题、语言入口、参数无效、记录不存在、尚不可预览、媒体失败和通用错误框架使用当前语言，合法完成记录仍加载原媒体 URL。
- 范围边界:
  - 必须: 保持 `<%- guideHtml %>` 的唯一受控非转义位置、guide.js 从当前 README `h2` 建目录，以及预览 ID 正整数严格解析。
  - 不能: 不能复制 EJS 页面、动态读取文档、翻译 README HTML、丢失 query、修改媒体 API 或新增播放器依赖。
  - 不做: 不支持额外媒体格式、转码、自动下载、预览权限或第三种语言。
- 验收标准:
  1. `npm run build` → 说明页、独立预览页和模块脚本构建成功
  2. `rg -n "language-switcher|type=\"module\"|<html lang=\"<%= language %>\"" src/views/download-preview.ejs` → 独立文档语言与共享切换入口均命中
  3. `git diff --exit-code -- src/public/guide.js` → guide.js 未被修改

## task-14 · 完整验证目录、状态与翻译调用边界
- 状态: done
- 依赖: task-13
- 文件范围:
  - test/unit/i18n.test.ts
- 关键约束:
  - 不能只证明正向翻译；必须证明非契约语言、键、状态、错误码和格式不处理并显式失败。
  - 必须扫描所有 EJS 与浏览器脚本中的字面量翻译调用，确保每个键在两套目录存在且非空，并比较两套目录完整键集合。
  - 测试必须使用固定输入与固定 `Asia/Shanghai`，不能依赖开发机 locale/timezone 或为通过测试增加生产 fallback。
- 任务目的: 收口设计 2.4、5.7 与 PRD 3.1 要求的可穷举 i18n 单元边界和源码翻译键覆盖。
- 实现入口: test/unit/i18n.test.ts 中 task-01、task-04 建立的语言、目录与格式化测试组
- 期望行为: 两个有效语言、所有无效/缺失 Cookie、目录一致性、全部固定状态/错误码、未知值失败、安全 JSON、日期数字文件大小和源码字面量调用都由单个专用测试文件机械验证。
- 范围边界:
  - 必须: 覆盖 10 个页面相关脚本的现有状态集合、全部 `src/errors.ts` ErrorCode 和服务端/浏览器目录一致性。
  - 不能: 不能允许动态拼键、默认值参数、跨语言 fallback、递归解析、别名字段或静默跳过无法解析的字面量调用。
  - 不做: 不测试 HTTP 渲染、DOM 交互、API 响应或容器生命周期；这些由后续集成任务覆盖。
- 验收标准:
  1. `npm test -- --run test/unit/i18n.test.ts --maxWorkers=1` → 完整 i18n 单元与源码扫描测试通过
  2. `rg -n "src/views|src/public|ERROR_HTTP_STATUS|Asia/Shanghai" test/unit/i18n.test.ts` → 模板、脚本、错误码和时区扫描入口均可定位

## task-15 · 更新中英文用户文档与 v0.4 变更说明
- 状态: done
- 依赖: task-14
- 文件范围:
  - README.md
  - README.en.md
  - CHANGELOG.md
- 关键约束:
  - 不能承诺第三种语言、浏览器自动协商、持久化到浏览器重启后、账号语言设置或不同业务/API 能力。
  - 两份 README 必须对称说明固定 `zh-CN`/`en`、默认中文、页面入口、`vidharbor_language` 会话 Cookie 的刷新/跨页范围，以及缺失、清除、无效值恢复中文。
  - 两份 README 的 `APP_GUIDE_EXCLUDE_START/END` 必须各保留唯一一对且顺序正确。
- 任务目的: 完成 PRD 3.2 的双语使用说明与 v0.4 变更记录，明确 UI 变化不进入业务/API 契约。
- 实现入口: README.md:21 与 README.en.md:21 排除标记、README.md:114 `页面说明`、README.en.md:114 `Pages`、CHANGELOG.md:5 `Unreleased`
- 期望行为: 中英文文档以各自语言描述相同语言集合、切换、Cookie、10 页范围、日期数字显示和业务边界；CHANGELOG 记录双语页面、会话 Cookie、全页覆盖、自动化与浏览器验收，并明确 API、状态、数据库和流程未变。
- 范围边界:
  - 必须: 保持现有安装、平台、运维、安全和能力说明，只补充 v0.4 已确认语言契约。
  - 不能: 不能删除现有排除标记、翻译命令/路径/代码、扩大语言持久化或改写现有业务限制。
  - 不做: 不修改历史设计文档、截图、API 文档或生成第三份 README。
- 验收标准:
  1. `rg -n "vidharbor_language|zh-CN|English|会话|session" README.md README.en.md CHANGELOG.md` → 两份说明与变更记录均包含固定语言/Cookie 契约
  2. `test "$(rg -c 'APP_GUIDE_EXCLUDE_START|APP_GUIDE_EXCLUDE_END' README.md)" = 2 && test "$(rg -c 'APP_GUIDE_EXCLUDE_START|APP_GUIDE_EXCLUDE_END' README.en.md)" = 2` → 两份 README 各保留一对排除标记

## task-16 · 扩展页面集成测试覆盖 10 页与动态交互
- 状态: done
- 依赖: task-15
- 文件范围:
  - test/integration/pages.test.ts
- 关键约束:
  - 不能只断言源码字符串；语言切换、动态状态、确认、错误和分页必须在现有受控 DOM/脚本执行方式中验证实际行为。
  - 必须对 10 个页面覆盖无 Cookie、清除/无效 Cookie、精确 `en` 及不同 `Accept-Language` 组合，断言标题、`html lang`、共享导航和关键文案。
  - 必须证明切换 Cookie 精确值、Path/SameSite、原 URL pathname/query/hash 不变、刷新、跨页保持和清除后恢复中文。
- 任务目的: 完成 PRD 3.1 的服务端页面、全部动态状态、格式化、README 来源和真实切换行为集成回归。
- 实现入口: test/integration/pages.test.ts:175 `describe('server-rendered pages')`、:209 guide 测试、:247 授权页测试、:744 预览测试、:877 时间测试、:895 任务快照测试、:1187 删除确认测试
- 期望行为: `/`、`/downloads`、`/channels`、`/channels/:id`、`/notifications`、`/authorizations`、`/settings`、`/database`、`/guide`、`/downloads/preview` 在两种语言与默认边界下全部通过；现有状态、错误、确认、空状态、分页、日期数字、独立预览和双 README 来源均有行为断言。
- 范围边界:
  - 必须: 使用现有本地数据库/API fixture 和受控 DOM，覆盖固定状态集合、未知状态失败、用户/第三方内容不翻译及语言切换上下文保持。
  - 不能: 不能引入浏览器测试框架、生产兼容层、真实外部平台、敏感 Cookie 原文或永久删除操作。
  - 不做: 不重复单元目录扫描、API Cookie 不变或干净构建生命周期测试。
- 验收标准:
  1. `npm test -- --run test/integration/pages.test.ts --maxWorkers=1` → 10 页双语渲染、动态 DOM、切换和格式化集成测试通过
  2. `rg -n "Accept-Language|vidharbor_language|downloads/preview|/channels/:id|README.en.md" test/integration/pages.test.ts` → 协商负向、Cookie、参数化页面和双 README 断言可定位

## task-17 · 证明语言 Cookie 不改变 API 契约
- 状态: done
- 依赖: task-16
- 文件范围:
  - test/integration/http-contract.test.ts
- 关键约束:
  - 不能修改生产 API、错误英文 message、状态码、错误码、响应字段、值或同源/媒体类型规则来适配页面语言。
  - 必须对无 Cookie、`zh-CN`、`en` 和无效语言 Cookie 重放既有成功与错误契约，并逐项比较完全相同的 JSON 与 HTTP 状态。
  - 不能把语言加入请求体、query、API router 或响应。
- 任务目的: 落实 PRD 2.5、非功能兼容性和设计 5.5 的“本地化止于页面展示层”回归证明。
- 实现入口: test/integration/http-contract.test.ts:12 `beforeEach`、:60 `postContract`、:71 `describe('HTTP contract')`、:198 业务错误映射测试
- 期望行为: 任何语言 Cookie 组合下，API 成功响应、验证错误、业务错误、未知异常脱敏包络、二进制上传和同源拒绝均与现有英文 API 契约完全一致。
- 范围边界:
  - 必须: 覆盖至少成功 JSON、一个 4xx 业务错误、一个 5xx 错误、英文 message 和响应字段完全相等。
  - 不能: 不能新增 `Content-Language`、翻译 API message、读取语言 Cookie 分支或放宽安全校验。
  - 不做: 不测试页面可见错误翻译、Cookie 写入、README 或浏览器 DOM。
- 验收标准:
  1. `npm test -- --run test/integration/http-contract.test.ts --maxWorkers=1` → 所有语言 Cookie 维度的 API 契约回归通过
  2. `rg -n "vidharbor_language|zh-CN|invalid|en" test/integration/http-contract.test.ts` → 四类 Cookie 维度断言可定位

## task-18 · 验证干净构建、双 README 启动边界与容器完整性
- 状态: done
- 依赖: task-17
- 文件范围:
  - Dockerfile
  - test/integration/server-lifecycle.test.ts
- 关键约束:
  - 不能改变容器基础镜像、运行用户、卷、健康检查、启动命令、yt-dlp/ffmpeg 校验或现有生命周期事件。
  - Docker 构建与运行镜像必须同时复制 `README.en.md`；不能只依赖源码工作区存在英文文件。
  - 必须证明干净 `dist` 启动后中英文普通页面与 `/guide` 可用，任一 README 排除标记损坏都会在页面路由初始化/监听前显式失败。
- 任务目的: 收口设计 2.4、5.6 和容器风险项，证明发布产物内的同一双语链完整可启动。
- 实现入口: Dockerfile:52 构建上下文复制、:97 运行镜像复制、test/integration/server-lifecycle.test.ts:66 `projectRoot`、:78 `expectStartupFailure`、:274 干净构建启动测试
- 期望行为: `npm run build` 后从 `dist/server.js` 启动可按 Cookie 服务中英文 HTML 与对应 README；容器运行层同时拥有两份固定 README；标记缺失、重复或顺序错误均阻止启动而非运行时降级。
- 范围边界:
  - 必须: 覆盖中文、英文、无效 Cookie 默认中文、两份 README 来源及两文件标记失败。
  - 不能: 不能增加运行时文件 fallback、请求时文件读取、容器专用语言分支或修改业务启动顺序。
  - 不做: 不更换镜像、依赖版本、端口、挂载、健康检查或部署拓扑。
- 验收标准:
  1. `npm test -- --run test/integration/server-lifecycle.test.ts --maxWorkers=1` → 干净构建双语页面与 README 失败边界测试通过
  2. `npm run build` → 完整发布资源构建成功
  3. `test "$(rg -c 'README.en.md' Dockerfile)" = 2` → 构建上下文与运行镜像各复制一次英文 README

## task-19 · 执行双语 Web 验收并留存逐页证据
- 状态: done
- 依赖: task-18
- 文件范围:
  - docs/testing/v0.4-i18n-web-acceptance.md (新建)
- 关键约束:
  - 不能把未执行、失败、阻塞或明确排除的项目记录为通过；每项必须写明语言、路由、受控数据、检查内容、结果和证据。
  - 必须使用带界面的隔离浏览器和本地可控数据库/API fixture 验收 10 个页面、模态框、页签、筛选、分页、空/成功/失败状态、确认提示、日期数字与语言保持。
  - 不能访问真实 YouTube/Bilibili 等外部平台、上传敏感 Cookie 原文或执行永久删除；这些只能作为有理由的排除项记录。
- 任务目的: 完成 PRD 3.3 和设计 5.7 的最终浏览器验收证据，并在交付前运行全量自动化与构建。
- 实现入口: 新建（docs/testing/v0.4-i18n-web-acceptance.md）；验收页面入口为 src/routes/pages.ts:30 `createPagesRouter`
- 期望行为: 默认中文和英文分别逐页验证共享导航、当前 URL 保持、刷新/跨页持久化、说明页来源、日期数字、动态状态/错误/确认及应用自有文案无中英文混用；频道详情和下载预览使用受控本地记录访问真实参数化路由；证据文件如实记录通过、失败、阻塞和排除。
- 范围边界:
  - 必须: 验收 `/`、`/downloads`、`/channels`、`/channels/:id`、`/notifications`、`/authorizations`、`/settings`、`/database`、`/guide`、`/downloads/preview?id=...` 两种语言及 Cookie 清除恢复中文。
  - 不能: 不能用源码检查替代浏览器交互，不能伪造截图/结果，不能为通过验收修改生产契约或跳过本地可验证场景。
  - 不做: 不验收真实外部平台可达性、敏感 Cookie 内容、永久删除、移动端原生应用或 API 以外的新能力。
- 验收标准:
  1. `npm test -- --run --maxWorkers=1` → 全量自动化测试通过
  2. `npm run build` → 最终构建通过
  3. `rg -n "^## |zh-CN|en|通过|失败|阻塞|排除" docs/testing/v0.4-i18n-web-acceptance.md` → 逐页双语结果与非通过状态说明可定位

## task-20 · 安全重跑删除确认的 Web 验收
- 状态: done
- 依赖: task-19
- 文件范围:
  - docs/testing/v0.4-i18n-web-acceptance.md
- 关键约束:
  - 原始 bugfix 描述: task-19 的 25 项双语 Web 验收中 24 项通过、1 项失败、0 项阻塞。WA-23 检查频道删除确认时，chrome-devtools evaluate_script 的默认 dialog action 在显式 handle_dialog dismiss 前接受了确认，导致临时频道 fixture 被删除（已恢复），违反了验收明确排除永久删除的边界。仅修正验收操作顺序或改用不会接受确认的观察方式，安全重跑 WA-23 并更新报告证据；不修改生产代码，不执行任何删除写请求。
  - 必须在触发频道删除确认前建立不会接受确认的观察方式，并在操作前后核对受控频道 fixture 未变化、网络记录中没有频道 `DELETE` 请求。
  - 不能修改生产代码、测试代码或既有业务契约，不能接受删除确认，不能执行任何删除写请求，也不能把未安全完成的重跑记录为通过。
- 任务目的: 修复 bugfix-01 描述的问题
- 实现入口: docs/testing/v0.4-i18n-web-acceptance.md:274 `WA-23` 验收记录；src/public/channels.js:86 频道删除确认入口（仅验收，不修改）
- 期望行为: 在 `zh-CN` 与 `en` 页面中安全观察并取消频道删除确认，确认文案使用当前语言，受控频道 fixture 和总数保持不变且没有产生频道删除写请求；如 WA-23 全部检查通过，如实更新报告证据、统计和最终结论。
- 范围边界:
  - 必须: 仅安全重跑 WA-23 的频道删除确认缺口，保留其他 24 项既有验收结果，并记录双语路由、受控数据、确认文案、取消结果、网络请求和证据。
  - 不能: 不能改动与本 bug 无关的模块，不能修改生产代码或测试代码，不能访问真实外部平台，不能上传敏感 Cookie，不能执行任何删除写请求或用 fixture 恢复代替无写入证明。
  - 不做: 不重跑与 WA-23 无关的浏览器场景，不新增功能，不改变 API、数据库、页面行为或 task-19 的历史执行记录。
- 验收标准:
  1. `rg -n "^### WA-23 .*— 通过$|频道删除写请求.*(未产生|0)|^\\- 通过：25$|^\\- 失败：0$" docs/testing/v0.4-i18n-web-acceptance.md` → WA-23、安全无写入证据和最终统计均可定位
  2. `git diff --exit-code -- src test` → 生产代码与测试代码均未改动
  3. `rg -n "zh-CN.*en|确认|取消|证据" docs/testing/v0.4-i18n-web-acceptance.md` → 双语确认、取消结果和证据均有记录

## task-21 · 授权页安全说明纳入唯一翻译目录
- 状态: done
- 依赖: task-10, task-14
- 文件范围:
  - src/i18n.ts
  - src/views/authorizations.ejs
  - test/integration/pages.test.ts
- 关键约束:
  - 原始 bugfix 描述: Review F001，位置 src/views/authorizations.ejs:35。三条安全说明正文与“已配置”免责声明使用 language 分支硬编码中英文，绕过 src/i18n.ts 唯一翻译事实源和目录扫描。将固定文案拆为扁平翻译键，EJS 只调用 t()；链接保持模板结构，不将 HTML 放入翻译值。
  - 必须保持 `Get cookies.txt LOCALLY` 链接为 EJS 模板结构，翻译值只能包含链接前后的纯文本，不能把 HTML、链接地址或属性写入目录。
  - 不能改变授权页现有文案含义、Cookie 敏感信息边界、文件上传行为或授权 API 契约。
- 任务目的: 修复 bugfix-02 描述的问题
- 实现入口: src/views/authorizations.ejs:35 安全说明语言分支与 :45 “已配置”免责声明；src/i18n.ts 的 `authorizations.*` 扁平目录
- 期望行为: 三条安全说明和“已配置”免责声明在 `zh-CN`、`en` 下保持现有显示内容，但全部由 `src/i18n.ts` 固定键提供，模板只通过 `t()` 取纯文本并保留原链接结构。
- 范围边界:
  - 必须: 为两套目录增加键集合一致、值非空的固定键，移除授权页对应 `language` 分支，并验证双语渲染内容与链接安全属性。
  - 不能: 不能改动与本 bug 无关的模块，不能在翻译值中存放 HTML，不能读取、展示或记录 Cookie 内容。
  - 不做: 不修改授权脚本、授权 API、数据库、样式或其他页面文案。
- 验收标准:
  1. `npm test -- --run test/unit/i18n.test.ts --maxWorkers=1` → 新增固定键被两套目录与 EJS 字面量调用扫描覆盖
  2. `npm test -- --run test/integration/pages.test.ts --maxWorkers=1` → 双语安全说明、免责声明与原链接结构渲染断言通过
  3. `! rg -n "language === 'zh-CN'" src/views/authorizations.ejs` → 授权页不再以语言分支绕过目录

## task-22 · 恢复频道检查间隔的单位与来源
- 状态: pending
- 依赖: task-07, task-14
- 文件范围:
  - src/i18n.ts
  - src/public/channels.js
  - test/integration/pages.test.ts
- 关键约束:
  - 原始 bugfix 描述: Review F002，位置 src/public/channels.js:80。频道卡片错用表单键 channels.interval，并且只显示数字，丢失“分钟”单位以及“全局/频道覆盖”来源。标签改用 channels.checkInterval，按 checkIntervalMinutes === null 选择固定翻译键并恢复单位和来源，保持数值本地化与表单契约不变。
  - 必须仅以 `checkIntervalMinutes === null` 区分全局值与频道覆盖值，显示 `effectiveCheckIntervalMinutes` 的本地化数字、分钟单位和对应来源。
  - 不能改变频道表单键、提交字段、API 数据结构、检查调度或间隔计算。
- 任务目的: 修复 bugfix-03 描述的问题
- 实现入口: src/public/channels.js:80 `load` 中频道卡片 `details` 构建；src/i18n.ts 的 `channels.*` 扁平目录
- 期望行为: 频道卡片使用 `channels.checkInterval` 标签；空频道覆盖显示“全局”来源，非空频道覆盖显示“频道覆盖”来源，两种情况都带分钟单位且数值继续按当前语言格式化。
- 范围边界:
  - 必须: 覆盖 `checkIntervalMinutes` 为 `null` 和正整数两种已确认输入，并保留 `effectiveCheckIntervalMinutes` 作为展示数值来源。
  - 不能: 不能改动与本 bug 无关的模块，不能猜测其他来源状态，不能用表单文案键 `channels.interval` 代替卡片标签。
  - 不做: 不修改频道表单、API、服务、数据库、调度器或间隔取值规则。
- 验收标准:
  1. `npm test -- --run test/integration/pages.test.ts --maxWorkers=1` → 双语全局来源与频道覆盖来源、单位和本地化数值行为断言通过
  2. `npm test -- --run test/unit/i18n.test.ts --maxWorkers=1` → 新增来源/单位固定键与浏览器字面量调用均通过目录扫描
  3. `rg -n "channels\.checkInterval|checkIntervalMinutes === null|effectiveCheckIntervalMinutes" src/public/channels.js` → 标签、来源判定和数值来源均可定位

## task-23 · 恢复频道详情代理选项语义
- 状态: pending
- 依赖: task-08, task-14
- 文件范围:
  - src/i18n.ts
  - src/views/channel-detail.ejs
  - test/integration/pages.test.ts
- 关键约束:
  - 原始 bugfix 描述: Review F003，位置 src/views/channel-detail.ejs:24。批量下载代理下拉将 value=channel 显示为通用 field.channel（“频道/Channel”），丢失“沿用频道代理 / Use channel proxy”的策略语义。新增并使用专用固定翻译键，保持 value=channel 和提交契约不变。
  - 必须只替换 `value="channel"` 选项的显示文案，固定值、空值直连选项和批量下载 payload 保持不变。
  - 不能复用含义不同的通用 `field.channel`，不能增加代理策略或自动选择逻辑。
- 任务目的: 修复 bugfix-04 描述的问题
- 实现入口: src/views/channel-detail.ejs:24 批量下载代理 `<option value="channel">`；src/i18n.ts 的 `channelDetail.*` 扁平目录
- 期望行为: 频道详情批量下载代理下拉在中文显示“沿用频道代理”、英文显示“Use channel proxy”，提交时仍传递原始 `channel` 值。
- 范围边界:
  - 必须: 新增并使用一个专用双语固定键，验证双语选项文本及 `value="channel"` 不变。
  - 不能: 不能改动与本 bug 无关的模块，不能修改 `field.channel` 的既有含义，不能改变表单或请求契约。
  - 不做: 不修改频道详情脚本、代理 API、批量下载服务、其他代理选项或页面布局。
- 验收标准:
  1. `npm test -- --run test/unit/i18n.test.ts --maxWorkers=1` → 专用固定键在两套目录存在且模板调用可解析
  2. `npm test -- --run test/integration/pages.test.ts --maxWorkers=1` → 双语代理策略文本和原始提交值断言通过
  3. `rg -n -F '<option value="channel"><%= t(' src/views/channel-detail.ejs` → 固定业务值使用专用翻译调用

## task-24 · 清理模板中绕过翻译目录的文案
- 状态: pending
- 依赖: task-06, task-07, task-11, task-14
- 文件范围:
  - src/i18n.ts
  - src/views/channels.ejs
  - src/views/downloads.ejs
  - src/views/settings.ejs
  - test/integration/pages.test.ts
- 关键约束:
  - 原始 bugfix 描述: Review F004，位置 src/views/channels.ejs:26，同类位置还包括 downloads.ejs 与 settings.ejs。频道 URL 帮助、同平台授权说明、首次同步 historyMonths 选项、下载平台地址规则和代理主机/端口 placeholder 使用 language 三元或分支硬编码中英文。为这些已确认文案补齐 zh-CN/en 固定键并统一调用 t()；含 HTML 的说明拆为安全结构，不改变业务行为。
  - 必须保持频道 `historyMonths` 的 `1`、`3`、`6`、`12` 值、下载规则中的 `<code>` 结构以及代理 host/port 的表单属性不变。
  - 不能把 HTML、URL 结构或表单值放入翻译目录，不能借清理文案改变平台支持范围或输入契约。
- 任务目的: 修复 bugfix-05 描述的问题
- 实现入口: src/views/channels.ejs:26 频道 URL 帮助、:29 同平台授权说明、:43 `historyMonths` 选项；src/views/downloads.ejs:52 平台地址规则；src/views/settings.ejs:37 代理 host/port placeholder；src/i18n.ts 对应扁平目录
- 期望行为: 已确认的频道帮助、授权说明、历史范围、下载地址规则和代理 placeholder 全部由 `src/i18n.ts` 的双语固定键提供；模板保留现有安全 HTML 和表单结构，不再通过 `language` 三元或分支选择文案。
- 范围边界:
  - 必须: 为两套目录补齐一致的非空固定键，拆分下载规则中 `<code>` 前后的纯文本，并验证三份模板的双语输出和原始业务值。
  - 不能: 不能改动与本 bug 无关的模块，不能将 HTML 写入翻译值，不能改变频道、下载或代理的业务行为。
  - 不做: 不修改浏览器脚本、API、服务、数据库、平台枚举、表单 payload 或样式。
- 验收标准:
  1. `npm test -- --run test/unit/i18n.test.ts --maxWorkers=1` → 新增固定键、目录一致性与 EJS 字面量调用扫描通过
  2. `npm test -- --run test/integration/pages.test.ts --maxWorkers=1` → 三份模板的双语文案、安全结构和原始表单值断言通过
  3. `! rg -n "language === 'zh-CN'" src/views/channels.ejs src/views/downloads.ejs src/views/settings.ejs` → 目标模板不再以语言分支绕过目录
