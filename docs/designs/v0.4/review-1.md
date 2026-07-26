## 整体评价

**结论**：needs-fix

本轮审查共 8 条 finding，Step 2 worker 全部认可。其中 4 条判定为「需修」：频道检查间隔与代理选项存在既有 UI 信息/语义回归（F002、F003），以及多处页面（含授权安全说明）以 `language` 分支旁路唯一翻译目录（F001、F004），明确违背 v0.4 固定翻译键与目录扫描契约。另 4 条为集成/单测覆盖与扫描器边界缺口（F005–F008），有修复价值但不构成用户可见功能回归，列为「供参考」不阻断合入判定逻辑外的主结论——因存在「需修」项，整体结论为 needs-fix。

---

## 需求覆盖度

| Task | 标题 | 状态 |
|------|------|------|
| task-01 | 建立固定双语目录与严格翻译契约 | 通过（目录本身无异议；生产侧旁路见 F001/F004） |
| task-02 | 将语言选择接入页面路由与双 README 预渲染 | 通过 |
| task-03 | 本地化共享外壳并实现原地语言切换 | 通过 |
| task-04 | 统一本地化日期、数字、文件大小与分页 | 通过 |
| task-05 | 完成总览与 yt-dlp 任务区域双语化 | 通过 |
| task-06 | 完成下载页面静态与动态双语化 | 部分问题（F004 平台规则 HTML；F006 空状态英测） |
| task-07 | 完成频道列表与首次同步双语化 | 需修（F002 间隔来源丢失；F004 帮助/选项旁路；F005/F007 测覆盖） |
| task-08 | 完成频道详情双语化 | 需修（F003 代理选项语义） |
| task-09 | 完成提醒页面双语化 | 通过 |
| task-10 | 完成授权管理页面双语化 | 需修（F001 安全说明未入目录） |
| task-11 | 完成配置与代理页面双语化 | 需修（F004 settings placeholder 旁路） |
| task-12 | 完成数据库浏览器页面双语化 | 通过 |
| task-13 | 完成系统说明与独立下载预览双语化 | 通过 |
| task-14 | 完整验证目录、状态与翻译调用边界 | 部分问题（F004 目录覆盖缺口；F008 扫描器漏检） |
| task-15 | 更新中英文用户文档与 v0.4 变更说明 | 通过 |
| task-16 | 扩展页面集成测试覆盖 10 页与动态交互 | 部分问题（F005–F007 动态状态/确认/空状态英测） |
| task-17 | 证明语言 Cookie 不改变 API 契约 | 通过 |
| task-18 | 验证干净构建、双 README 启动边界与容器完整性 | 通过 |
| task-19 | 执行双语 Web 验收并留存逐页证据 | 通过（本轮无直接 finding） |
| task-20 | 安全重跑删除确认的 Web 验收 | 通过 |

---

## 问题列表

### [suggest] 授权页安全说明正文未纳入唯一翻译目录
- **位置**: `src/views/authorizations.ejs:35`
- **问题**: task-10 与设计要求将授权页「安全说明」改为固定翻译键，且全局契约规定 src/i18n.ts 为唯一翻译事实源。当前仅标题 authorizations.safety 走 t()，三条安全说明正文与“已配置”免责声明使用 language === 'zh-CN' 分支在模板内硬编码中英文，形成目录外第二套文案源，无法被目录键一致性/EJS 字面量键扫描覆盖。
- **建议**: 将三条安全说明与免责声明拆入 i18n 扁平键（链接可用分段文案 + 模板内固定 <a> 包裹专有扩展名，避免把 HTML 放进目录后用非转义输出）；EJS 只调用 t()，删除 language 分支双份硬编码。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 认可；consequence 表明不修复则旁路唯一目录契约，中英文易漏改且 task-14 扫描无法覆盖，明确违背 task-10/设计对固定翻译键与单一事实源的要求）

### [blocker] 频道卡片检查间隔丢失全局/覆盖来源与单位
- **位置**: `src/public/channels.js:80`
- **问题**: 旧实现展示 `${effectiveCheckIntervalMinutes} 分钟（全局|频道覆盖）`，区分 `checkIntervalMinutes === null` 的全局值与频道覆盖值。当前改为 `channelDetail(t('channels.interval'), formatNumber(channel.effectiveCheckIntervalMinutes))`：标签误用表单键 `channels.interval`（“频道覆盖间隔（分钟）”）而非卡片字段键 `channels.checkInterval`（“检查间隔”）；取值只剩本地化数字，去掉了单位与“全局/频道覆盖”来源。目录中虽有 `channels.checkInterval` 但未使用，也无对应的全局/覆盖文案键。
- **建议**: 卡片字段标签改用 `t('channels.checkInterval')`；值按 `checkIntervalMinutes === null` 选择“全局/频道覆盖”翻译键，并保留分钟语义（例如 `t('channels.intervalValue', { minutes: formatNumber(...), source: t(...) })` 或等价固定键）。表单标签继续用 `channels.interval`/`channels.intervalPlaceholder`。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 认可；consequence 说明用户无法区分全局/频道覆盖来源，易误判生效间隔并错误编辑/排障，属 i18n 过程中的既有 UI 信息回归）

### [blocker] 频道详情代理选项误用 field.channel 丢失“沿用频道代理”语义
- **位置**: `src/views/channel-detail.ejs:24`
- **问题**: 批量下载代理下拉原选项文案为“沿用频道代理”，value=`channel` 表示使用频道已配置代理。现改为 `<%= t('field.channel') %>`，目录值为“频道”/“Channel”。该键是通用字段名，不是代理策略说明；英文 “Channel” 在“网络路径”下拉中尤其含糊，与“直连”并列时语义不完整。目录中亦无“沿用频道代理 / Use channel proxy”专用键。
- **建议**: 在 `src/i18n.ts` 增加专用键（例如 `channelDetail.useChannelProxy`），中英文分别表达“沿用频道代理 / Use channel proxy”，模板与任何动态逻辑改用该键；保持 value=`channel` 与提交契约不变。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 认可；consequence 说明用户无法正确理解 value=channel 的代理策略含义，可能误选直连或错误路径，英文下几乎不可理解，属功能语义回归）

### [blocker] 多处页面文案用 language 三元旁路唯一翻译目录
- **位置**: `src/views/channels.ejs:26`
- **问题**: 设计与全局契约要求应用自有文案走 `src/i18n.ts` 唯一扁平目录与固定 `t(...)` 键（design 2.2：channels/downloads/settings 的帮助、占位符、首次同步表单等改为固定翻译键；PRD 3.1 目录扫描需覆盖全部服务端/浏览器翻译调用）。本批次多处用 `language === 'zh-CN' ? '...' : '...'` 或 `<% if (language === 'zh-CN') %>` 直接嵌入双语字面量，未进入目录：channels.ejs 频道 URL 帮助、同平台授权说明、首次同步 historyMonths 四选项；downloads.ejs 平台地址规则 HTML 段；settings.ejs 主机/端口 placeholder。这些字符串不参与键集合一致性校验，也不被 task-14 的 `t` 字面量扫描覆盖。
- **建议**: 为上述帮助、历史范围选项与 placeholder 补齐成对 zh-CN/en 键，模板统一 `<%= t('...') %>`；含 HTML 的说明改为无 HTML 纯文案键或拆成可安全 `textContent` 的结构，避免第二套语言分支。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 需修（原因：worker 认可；consequence 明确指出唯一目录契约被旁路，直接违反 v0.4 固定翻译键与目录扫描验收要求，双语一致性无法由自动化证明）

### [suggest] 频道列表检查结果四态已造数但未断言本地化标签
- **位置**: `test/integration/pages.test.ts:609`
- **问题**: renders channel list states 用例为四条频道分别设置 lastCheck.result = null|success|no_updates|failed，运行时 channels.js 会渲染 dashboard.noScheduledCheck / status.check.success / status.check.no_updates / status.check.failed。当前仅断言同步四态标签与第三方失败原文（third-party check detail），从未 expect(dom).toContain(i18n.t(...检查结果键...))。task-16 要求覆盖动态状态，检查三结果是频道列表契约的一部分，现有断言无法发现检查结果键映射错误或中英文漏译。
- **建议**: 在 controlledText(list) 上对四种 lastCheck.result 分别断言对应 t() 文案（null → t('dashboard.noScheduledCheck')，其余 → t('status.check.*')），并保留第三方失败原文不翻译的断言。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 供参考（原因：worker 认可且 finding 成立，但 consequence 主要描述测试未能拦截本地化回归，未证明当前生产渲染错误或崩溃；属 task-16 证据补强，不阻断合入）

### [suggest] 下载三页签空状态仅中文硬编码，未纳入双语矩阵
- **位置**: `test/integration/pages.test.ts:1315`
- **问题**: filters downloads by title and exposes distinct tab and empty-state contracts 仅用 browserI18n('zh-CN')，并用硬编码中文断言 emptyStateFor 的 completed/active/failed 与搜索无结果文案。同文件下载八状态、分页、预览等已 it.each(['zh-CN','en'])，但三页签空状态（task-06/task-16 动态状态）没有英文路径；目录英文键 downloads.noTasks/noCompleted/noFailed/noActive/noSearchResults 变更或漏配时本文件测不到。
- **建议**: 将 emptyStateFor 断言改为 it.each(['zh-CN','en'])，期望值一律用 i18n.t('downloads.noTasks') 等目录键（搜索无结果用 t('downloads.noSearchResults', { query })），去掉硬编码中文面值。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 供参考（原因：worker 认可且 finding 成立，但 consequence 指向 en 路径集成测试缺口，未证明生产空状态已错误；补强 task-06/task-16 双语矩阵即可，不阻断合入）

### [suggest] 频道删除确认只验证拦写请求，未断言双语确认文案
- **位置**: `test/integration/pages.test.ts:616`
- **问题**: task-16 要求覆盖“确认”。下载删除用例会捕获 confirm 参数并断言 t('downloads.deleteConfirm', { title }) 且 deleteRequests===0；频道列表用例虽 mock confirm 恒为 false 并断言 deleteRequests===0，但未记录/断言 confirm 收到的 channels.deleteConfirm 文案，也未在 en 下核对插值 name。静态脚本扫描另有一处 contain 字符串，无法证明运行时 confirm 入参正确。
- **建议**: 与下载删除一致：用数组记录 confirm(message)，点击删除后 expect(message).toBe(i18n.t('channels.deleteConfirm', { name: channel.customName }))，并保留 deleteRequests===0。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 供参考（原因：worker 认可且 finding 成立，但 consequence 为确认文案断言不足导致的测试盲区，与下载侧不对称；未证明运行时 confirm 文案已错，属 task-16 证据补强，不阻断合入）

### [suggest] t() 静态扫描在混合分支表达式上静默漏检动态键
- **位置**: `test/unit/i18n.test.ts:149`
- **问题**: task-14 要求扫描脚本字面量 t 键并禁止动态拼键/静默跳过。translationKeys 在非纯字面量、非 simple-identifier 的表达式上，只要用 matchAll 扫到任意点分字符串字面量或 fixedValue/fixedLabel 映射就会返回，不再要求其余分支可静态解析。现网 channels.js 中 t(status === 'succeeded' ? (paused ? 'status.channel.running' : 'status.channel.paused') : syncStatusKey) 即命中该路径：扫描只收录 status.channel.*，syncStatusKey（runtime 对应 status.sync.*）被静默丢弃。当前靠 stateMapContracts.initialSyncStatusKeys 旁路兜住四态，但通用扫描器对 t(cond ? 'a.b' : dynamicVar) 会绿测通过，无法兑现“动态键必须失败”的收口。
- **建议**: 在 translationKeys 处理复合表达式时，除提取字面量/map 外，对所有标识符分支继续递归解析（含三元两侧）；任一子表达式无法解析为固定键则抛 dynamic or unrecognized。或对仅含部分字面量的 t() 调用直接失败，强制改为 t(fixedValue(map, …)) / 纯字面量。
- **worker认可**: 是（理由：无异议）
- **最终裁定**: 供参考（原因：worker 认可且 finding 成立，但 consequence 侧重后续若新增混合动态键或迁出 stateMapContracts 时扫描失效；当前四态仍有旁路兜住，属 task-14 扫描器健壮性加强，不构成已发生的用户功能错误，不阻断合入）
