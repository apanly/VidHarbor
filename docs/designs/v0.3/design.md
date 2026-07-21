# VidHarbor v0.3 技术设计

## 1. 整体方案概述

新增独立的 Cookie 授权管理纵切面：后端以固定平台白名单驱动路由、校验和文件命名，将每个平台的 Netscape Cookie 原文保存到 SQLite 文件同目录下的受限 `cookies/` 目录；最终文件是否存在及其 `mtime` 分别作为配置状态和更新时间的唯一事实源，上传先写同目录临时文件、完整校验并落盘后再原子替换，因此不需要在数据库与文件系统之间做无法原子提交的双写。API 只接收单个二进制文件体并返回固定元数据，页面只持有平台状态，不读取 Cookie 内容。Vimeo 部分只收缩当前文档、界面和测试承诺，保留现有通用 HTTPS 探测、开放的下载 `platform` 文本字段及前端历史值显示逻辑，不增加域名判断或数据迁移。

## 2. 涉及模块与改动范围

### 2.1 Cookie 授权管理

| 文件 / 模块 | 类型 | 改动方向 |
| --- | --- | --- |
| `src/services/cookie-authorization.ts` | 新建 | 定义唯一平台集合 `youtube | bilibili | x | facebook | douyin`、固定文件映射、Netscape 七列校验、五个平台状态读取、同平台串行化、临时文件写入与原子替换、删除以及非敏感错误映射。模块不提供 Cookie 回读、导出或生成 yt-dlp 参数的能力。 |
| `src/routes/authorizations.ts` | 新建 | 提供 Cookie 配置列表、上传/替换和删除路由；严格校验路径平台和上传媒体类型；响应只组装 `platform`、`configured`、`updatedAt`。 |
| `src/app.ts` | 修改 | 注入并挂载授权管理路由；保留现有 JSON API 规则，只对精确的 Cookie 上传路由允许 `application/octet-stream` 原始请求流，所有写请求继续先经过同源校验，其他 API 的 body 契约不变。 |
| `src/server.ts` | 修改 | 根据 `dirname(DATABASE_PATH)/cookies` 创建并初始化 Cookie 存储，检查目录类型和权限、清理未提交的临时文件，再把同一服务实例注入 API；初始化失败沿用启动失败边界，不启动 HTTP 服务。 |
| `src/routes/pages.ts` | 修改 | 注册 `/authorizations` 服务端页面，标题和导航状态使用“授权管理”。 |
| `src/views/partials/header.ejs` | 修改 | 在主导航增加固定“授权管理”入口。 |
| `src/views/authorizations.ejs` | 新建 | 固定渲染五个平台卡片、文件选择与上传/替换区域、已配置时的删除操作、安全获取说明和“尚未接入业务流程”提示；不生成 Vimeo、自定义平台或其他授权类型入口。 |
| `src/public/authorizations.js` | 新建 | 读取固定状态列表，使用所选 `File` 作为二进制请求体上传且不调用 `File.text()`、不复制 Cookie 到页面状态；更新状态和时间、清空文件控件，并在删除前用固定平台中文名确认目标。 |
| `src/styles/main.scss` | 修改 | 增加授权卡片、状态标识、警告说明、操作区及移动端布局样式，继续复用现有 Bootstrap 与页面壳层。 |
| `test/unit/cookie-authorization.test.ts` | 新建 | 覆盖五个平台隔离、首次保存、完整替换、删除、时间变化、同平台并发串行、原子失败保持旧状态，以及 Netscape 正反格式边界；敏感断言只比较布尔结果或摘要，避免失败 diff 打印 Cookie 原文。 |
| `test/integration/cookie-authorization-api.test.ts` | 新建 | 覆盖三组 API、固定响应字段、平台白名单、媒体类型、同源保护、持久化失败和敏感标记不进入响应/错误/日志；验证重建服务实例后状态仍存在且不提供内容读取或下载路由。 |
| `test/integration/pages.test.ts` | 修改 | 覆盖导航、五个固定平台、状态/时间、上传与替换文案、删除确认、安全说明、无 Vimeo、无 Cookie 内容 DOM 注入，以及历史平台显示断言。 |
| `test/integration/http-contract.test.ts` | 修改 | 证明二进制 body 例外只适用于精确上传路径，其他 POST/PUT/PATCH 仍必须使用既有 JSON 契约。 |
| `test/integration/server-lifecycle.test.ts` | 修改 | 覆盖 Cookie 目录初始化、受限权限、未提交临时文件清理和初始化失败时不启动 HTTP；不增加新的后台任务或生命周期事件。 |
| `test/integration/channel-notification-api.test.ts`、`test/integration/database-browser.test.ts`、`test/integration/download-api.test.ts`、`test/integration/settings-proxy-api.test.ts` | 修改 | 为 `createApiRouter` 的新增必填 Cookie 服务依赖提供各自临时目录；原接口断言保持不变。下载 API 额外证明已有 Cookie 配置时元数据探测和排队参数仍不含 Cookie。 |
| `test/integration/yt-dlp.test.ts`、`test/integration/channel-initial-sync.test.ts`、`test/integration/channel-scheduled-check.test.ts`、`test/integration/download-worker.test.ts` | 修改 | 在现有真实参数边界上补充 Cookie 选项始终缺席的断言，分别覆盖频道首次同步、手动/定时检查、直接下载探测和媒体下载；不为测试增加 Cookie 注入入口。 |

### 2.2 Vimeo 官方支持撤销与兼容

| 文件 / 模块 | 类型 | 改动方向 |
| --- | --- | --- |
| `README.md` | 修改 | 从当前支持表和真实站点冒烟矩阵移除 Vimeo；补充授权管理入口、保存边界、安全说明、`/data` 备份包含敏感 Cookie，以及“已保存但未接入任务”的当前限制；移除“项目没有 Cookie 来源”的过时表述。 |
| `CHANGELOG.md` | 修改 | 记录新增 Cookie 授权管理及 Vimeo 官方支持/验证承诺撤销，同时说明通用 HTTPS 探测和历史记录兼容不变。 |
| `src/views/downloads.ejs` | 修改 | 从直下载帮助中的官方平台列表移除 Vimeo，但继续描述通用 HTTPS 单资源限制。 |
| `test/integration/download-service.test.ts`、`test/integration/download-api.test.ts` | 修改 | 用中性 HTTPS 站点作为通用直下载主样例；保留一个明确命名为“无 Vimeo 域名黑名单”的兼容用例，只证明 URL 仍走通用 yt-dlp 结果校验，不把它列为已验证平台。 |
| `test/integration/database.test.ts` | 修改 | 明确插入并读取历史 `vimeo` 和其他非空未知 `platform` 值，证明 `downloads.platform` 不收紧、不迁移。 |
| `test/integration/pages.test.ts` | 修改 | 断言当前帮助不再出现 Vimeo；同时以历史记录证明 `vimeo` 仍显示为 `Vimeo`，未知平台仍显示数据库原值。 |

以下文件刻意不改：`src/services/download.ts` 与 `src/yt-dlp.ts` 继续按现有 HTTPS、单条目和必要元数据契约处理；`src/public/downloads.js` 保留现有 `vimeo: 'Vimeo'` 映射及 `platformLabels[value] ?? value` 回退；`src/db/migrations/003-generic-direct-downloads.sql` 和 `006-bilibili-channels.sql` 保留 `downloads.platform <> ''` 约束。`docs/designs/v0.1/*` 是历史版本快照，不作为当前支持说明回写。

删除文件：无。

## 3. 数据设计

不涉及，跳过。

## 4. 接口设计

### 4.1 固定平台标识

授权管理接口只接受以下五个大小写敏感的小写标识，并按此顺序返回列表：`youtube`、`bilibili`、`x`、`facebook`、`douyin`。其中 `x` 是新授权契约的唯一标识；下载历史中 yt-dlp 已产生的 `twitter` 是另一套既有持久化值，本版不改名、不做别名兼容，也不在两者之间建立业务关联。

配置元数据固定为：

```json
{
  "platform": "youtube",
  "configured": true,
  "updatedAt": "2026-07-21T08:30:00.000Z"
}
```

- `platform`：上述五个固定值之一。
- `configured`：最终平台文件是否存在。
- `updatedAt`：已配置时为项目既有 ISO 8601 UTC 字符串；未配置时固定为 `null`，前端不渲染时间。
- 不增加条目数、域名、名称、值、文件名、服务器路径、预览、下载地址或远端有效性字段。

### 4.2 获取全部 Cookie 配置状态

- **路径 / 方法**：`GET /api/authorizations/cookies`
- **请求**：无路径参数、无查询参数、无请求体。
- **鉴权要求**：项目当前无登录鉴权；沿用可信内网单用户边界。GET 不要求 `Origin`，响应不包含凭据。
- **成功响应**：`200 application/json`，固定返回五项，即使全部未配置也不省略。

```json
{
  "configurations": [
    { "platform": "youtube", "configured": true, "updatedAt": "2026-07-21T08:30:00.000Z" },
    { "platform": "bilibili", "configured": false, "updatedAt": null },
    { "platform": "x", "configured": false, "updatedAt": null },
    { "platform": "facebook", "configured": false, "updatedAt": null },
    { "platform": "douyin", "configured": false, "updatedAt": null }
  ]
}
```

- **错误码**：读取目录或文件元数据失败时返回 `500 PERSISTENCE_ERROR`，固定消息 `cookie persistence failed`。响应不包含系统路径或底层异常文本。

### 4.3 上传或替换一个平台的 Cookie 文件

- **路径 / 方法**：`PUT /api/authorizations/cookies/:platform`
- **路径参数**：`:platform` 必须精确匹配五个固定标识之一。
- **请求媒体类型**：固定为 `application/octet-stream`；请求体就是用户所选 `cookies.txt` 的原始字节，不使用 JSON、Base64、multipart、文件名字段或其他包装。
- **请求示例**：

```http
PUT /api/authorizations/cookies/youtube HTTP/1.1
Origin: http://localhost:3002
Content-Type: application/octet-stream

<cookies.txt 原始文件体>
```

- **处理语义**：平台来自路径，不从内容推断。未配置时创建，已配置时完整替换；同一平台的并发修改按到达顺序串行，不同平台互不阻塞。响应前不进行远端请求、过期判断或平台归属判断。
- **成功响应**：`200 application/json`。创建和替换使用相同响应，不返回旧状态或文件内容。

```json
{
  "configuration": {
    "platform": "youtube",
    "configured": true,
    "updatedAt": "2026-07-21T08:35:12.000Z"
  }
}
```

- **鉴权要求**：必须通过现有 `requireSameOrigin`，即 `Origin` 必须精确等于当前协议和 `Host`。
- **错误码**：
  - `400 VALIDATION_ERROR / invalid cookie platform`：平台不在固定集合内。
  - `400 VALIDATION_ERROR / application/octet-stream required`：媒体类型不匹配。
  - `400 VALIDATION_ERROR / cookie file is empty`：没有任何数据字节，或去除允许的空白行和注释后没有 Cookie 数据行。
  - `400 VALIDATION_ERROR / invalid Netscape cookie file`：任一数据行不符合固定格式；不附带行号、行内容或字段内容。
  - `400 VALIDATION_ERROR / invalid request origin`：沿用现有同源错误。
  - `500 PERSISTENCE_ERROR / cookie persistence failed`：临时写入、同步、改时或原子替换失败；旧最终文件、旧状态和旧更新时间保持不变。

### 4.4 删除一个平台的 Cookie 配置

- **路径 / 方法**：`DELETE /api/authorizations/cookies/:platform`
- **请求**：只有固定平台路径参数，无查询参数、无请求体。
- **鉴权要求**：必须通过现有 `requireSameOrigin`。页面只有在 `configured: true` 时提供按钮，并在请求前显示包含目标平台名称的确认框。
- **成功响应**：`200 application/json`。只有最终文件成功删除后才响应成功。

```json
{
  "configuration": {
    "platform": "youtube",
    "configured": false,
    "updatedAt": null
  }
}
```

- **错误码**：
  - `400 VALIDATION_ERROR / invalid cookie platform`：未知平台。
  - `400 VALIDATION_ERROR / cookie configuration is not configured`：目标最终文件不存在；不得把该情况报告为成功。
  - `400 VALIDATION_ERROR / invalid request origin`：沿用现有同源错误。
  - `500 PERSISTENCE_ERROR / cookie persistence failed`：删除失败；原文件仍作为已配置状态，不清空时间。

不提供 `GET /api/authorizations/cookies/:platform`、Cookie 内容下载、导出、预览、远端验证、批量修改或任意平台 CRUD 接口。

## 5. 关键技术决策

### 5.1 用独立受限文件，而不是 SQLite BLOB 或设置字段

现有数据库浏览器能够列出所有表并执行任意只读 SQL；把 Cookie 原文存进 SQLite 会立即形成现有 API 的回读路径，修改数据库浏览器做表级过滤又会扩大安全契约。Cookie 因此保存在 `dirname(DATABASE_PATH)/cookies/`，自然随现有 `/data` 卷持久化和备份，但不位于 `/downloads`、静态目录或任何文件读取 API 可达路径。初始化时创建或收紧目录权限为 `0700`，并将已有的五个固定普通文件收紧为 `0600`；临时文件从创建起即为 `0600`，任何权限修正失败都中止启动。

平台到最终文件名是一对一常量映射，例如 `youtube.cookies.txt` 和 `x.cookies.txt`；服务不接受调用方提供文件名、账号名或路径。数据库 schema、设置响应和数据库浏览器都不增加 Cookie 字段。

### 5.2 文件本身是唯一事实源，而不是文件加 sidecar 元数据

`configured` 由固定最终文件存在得出，`updatedAt` 由成功提交前写入最终候选文件的 `mtime` 得出。这样上传的提交点只有一次同目录原子 `rename`，删除的提交点只有一次 `unlink`，不会出现文件已经替换但数据库/sidecar 仍是旧状态的双写窗口。状态查询只执行目录检查和五个固定文件的 `lstat`，不打开、不读取 Cookie 原文；非普通文件视为存储错误，不跟随符号链接。

### 5.3 先完整校验候选文件，再原子替换

上传流写入目标目录内权限为 `0600` 的唯一临时文件，同时按行做严格校验；完整请求结束、至少出现一条有效数据记录、临时文件成功同步并写入本次 ISO 时间对应的 `mtime` 后，才以原子替换提交到固定文件名。任何提交前失败都关闭并删除临时文件，原文件和其 `mtime` 不变；进程启动时清理由本模块命名的未提交临时文件，以覆盖异常退出窗口。服务不保留备份，也不合并新旧记录。

同一平台用独立串行队列约束上传、替换和删除的先后关系，防止两个请求相互覆盖后各自返回不对应的状态；五个平台使用彼此独立的队列。列表读取在原子提交前看到旧文件、提交后看到新文件，两者都是完整状态。

### 5.4 严格的 Netscape 行契约

校验以原始字节为准，保留文件内容不改写；支持 Netscape 文本常见的 LF、CRLF 和末行无换行。空白行可以忽略；首字节为 `#` 的标准注释可以忽略，但以 `#HttpOnly_` 开头的行必须作为数据行处理，并仅在校验 domain 必填性时识别此前缀。

每条数据行必须恰好由六个制表符分成七列：`domain`、`includeSubdomains`、`path`、`secure`、`expires`、`name`、`value`。`domain`、`path` 和 `name` 必须非空；两个布尔列只能是大小写精确的 `TRUE` 或 `FALSE`；`expires` 只能是非负十进制整数（`0` 表示会话 Cookie）；`value` 按格式允许为空。空格不能替代制表符，不 trim 数据字段，不接受列别名、JSON、请求头字符串、坏行跳过或猜测修复。任一数据行失败即拒绝整份文件。

校验不比较 domain 与目标平台，不判断过期时间是否已过去，也不调用 yt-dlp 或远端站点。PRD 没有给出数值型文件大小上限，本版不自行发明拒绝阈值；后端使用流式临时落盘和增量字段状态校验，不把整份文件或整条数据行保留在内存中。若需要业务大小限制，必须另行确认具体数值和错误契约。

### 5.5 使用原始二进制 body，而不是 multipart 或 JSON

一次请求只允许一个由路径确定平台的文件，multipart 的文件名、多字段和重复 part 都不是需求，Base64 JSON 还会扩大内存和内容复制面。固定 `application/octet-stream` 使浏览器可直接发送 `File`，服务端也无需新增上传依赖；前端不读取 Cookie 文本，只在请求期间引用文件对象，完成后立即清空控件。`src/app.ts` 对该精确 PUT 路径做窄例外，避免放宽其他既有 JSON API。

### 5.6 Cookie 管理与业务执行保持结构隔离

Cookie 服务只注入授权路由，频道服务、下载服务、worker、scheduler 和 `YtDlpTaskManager` 不接收该服务、文件路径或平台状态。生产代码中不新增将 Cookie 文件转换为 `--cookies`、`--cookies-from-browser`、请求头或环境变量的函数；保存操作也不提交任务、不发事件、不建立后台扫描器。测试从最终 yt-dlp 参数证明该隔离，而不是依赖页面文案。

### 5.7 Vimeo 只撤销承诺，不成为特殊业务分支

直接下载继续先验证 HTTPS，再把 URL 交给 yt-dlp，并要求恰好一个含既有必要元数据的条目；不增加 `vimeo.com` 域名判断，也不根据 extractor 名称拒绝。`downloads.platform` 继续是任意非空文本，历史 `vimeo` 不迁移；前端保留 Vimeo 显示映射和未知值原样回退。测试中的 Vimeo 只用于“无黑名单”和“历史读取”兼容边界，不能再作为官方平台矩阵或真实站点冒烟承诺。

### 5.8 不可逾越的边界

- 五个平台集合、顺序、API 标识和文件名只有一处定义；不接受大小写变体、`twitter`/`x` 别名或自定义平台。
- 服务端、页面和前端状态只暴露 `platform`、`configured`、`updatedAt`；不增加任何 Cookie 内容回读方法。
- 任何校验错误和底层文件错误都转换为固定非敏感消息；不得拼接上传文件名、原始行、字段、保存路径或系统异常详情。
- 上传失败不得执行最终替换，删除失败不得清空状态；未配置删除显式失败，不做幂等成功兼容。
- 不修改频道、下载、任务、设置和数据库浏览器的现有输入输出，不新增 Cookie 引用字段或平台枚举约束。
- 不提供多个账号、格式转换、远端验证、自动续期、过期提醒、导出、查看、下载或后台任务。

## 6. 风险与注意事项

- **权限与部署身份**：`/data` 必须继续由运行 VidHarbor 的用户独占可写。Dockerfile 已以 `node` 用户运行并将 `/data` 归属该用户，无需新卷；宿主机自定义 `DATABASE_PATH` 时，其父目录也必须允许创建权限为 `0700` 的 `cookies/`。不得为了绕过权限问题回退到 `/tmp`、当前目录或 `/downloads`。
- **文件系统原子性前提**：临时文件必须与最终文件位于同一目录，不能使用系统临时目录后跨设备移动。原子替换是单一提交点；提交后不再执行可能把已提交操作改报失败的元数据写入。
- **异常退出残留**：进程在最终替换前退出可能留下新候选临时文件。临时文件从创建起就是 `0600`，不被状态查询或任何读取接口识别，并在下次启动初始化时按本模块的精确命名规则删除；不能用宽泛 glob 删除目录内未知文件。
- **文件系统被外部修改**：状态模型假设应用独占该目录。人工删除、替换、改时、放入目录或符号链接均不属于支持的操作；服务必须对非普通文件和目录不可访问显式返回持久化错误，不能把损坏状态静默显示为未配置。
- **无数值上传上限**：需求只确认“一次一个平台的一份文件”，未确认字节上限。实现必须流式处理，不能依赖 Express 默认 body limit 形成未记录的业务限制；若上线环境需要防止磁盘耗尽，应先补充明确限额和对应错误码。
- **敏感信息的测试方式**：测试使用可搜索的敏感标记，但不得在断言失败时打印完整请求体、文件内容或字段数组；采用 `includes` 后比较布尔值、摘要比较和固定错误对象。测试 logger 只检查记录是否含标记，不把捕获的原日志作为失败消息输出。
- **错误包装范围**：验证错误只表达“空”或“格式无效”；文件系统异常统一包装为 `cookie persistence failed`。不能将 Node 错误的 `path`、`dest`、`syscall` 或 message 透传到 API、页面或生命周期日志，因为固定保存路径本身也不属于公开元数据。
- **时间精度**：服务在提交候选文件前生成一次项目标准 ISO 时间并用于文件 `mtime` 和成功响应；列表将该 `mtime` 转回 ISO。测试应验证成功替换后时间前进、失败时完全不变，不依赖不同文件系统的亚毫秒精度。
- **浏览器状态边界**：文件输入控件不可预填，上传完成或失败后都要清空；错误区域只展示固定 API 错误。不得为“预览”读取文件，也不得把 File、内容、文件名或路径写入 localStorage、URL、DOM data 属性或分析事件。
- **备份敏感性**：Cookie 随 `/data` 备份与恢复，这是持久化要求的结果。README 必须把备份从“可能含代理凭据”提升为同时含 Cookie 登录凭据，并要求使用与账号凭据相同的保护；恢复不引入内容校验或远端验证。
- **Vimeo 历史文档与当前承诺要区分**：历史 v0.1 设计中出现 Vimeo 是当时版本记录，不应篡改；当前 README、下载帮助、CHANGELOG 当前条目和测试矩阵不得继续把 Vimeo 列为官方支持。搜索检查需要排除历史版本文档和描述本次撤销本身的文本，避免机械删除破坏兼容说明。
- **回归重点**：实现完成后除新增测试外，必须运行单 worker 全量测试和构建，重点确认原 API 的 JSON 媒体类型、同源校验、下载平台原值回退、数据库 schema 校验、频道/下载 yt-dlp 参数以及 Docker `/data`、`/downloads` 挂载契约均未改变。
