---
type: Web 界面架构
title: 页面、浏览器模块与双语界面
description: 说明 EJS 页面和静态模块如何调用 API，以及语言 Cookie、翻译目录和 README 系统说明的运行期契约。
tags: [web, i18n]
---

# 页面、浏览器模块与双语界面

`src/routes/pages.ts` 声明服务端页面，EJS 模板在 `src/views/`，页面专用浏览器模块在 `src/public/`，共享样式在 `src/styles/main.scss`。页面层主要注入标题、当前导航、语言、翻译 JSON 和频道 ID；真实业务数据由浏览器模块调用 [HTTP API](../api/http-contract.md)。关键页面是总览、下载、频道、频道详情、提醒、授权、设置、数据库、下载预览和系统说明。

## 语言契约

`src/i18n.ts` 只支持 `zh-CN` 与 `en`，默认 `zh-CN`。`selectLanguage()` 只读取精确的会话 Cookie `vidharbor_language`；缺失或无效值回退中文，不采纳浏览器语言。每次页面渲染从同一目录生成 `t` 与 `i18nJson`，客户端 `src/public/i18n.js` 用其翻译交互文案。API、数据库状态、路由和业务值不因语言改变。

翻译的新增/修改面是 `zhCN` 与 `en` 两个扁平目录：键集合必须完全一致、每个值非空；参数替换要求传入参数集合与模板占位符完全一致。`safeJson()` 转义 `<` 与 Unicode 行分隔符后才嵌入页面，避免脚本上下文注入。`test/unit/i18n.test.ts` 覆盖目录、Cookie、参数和序列化。

## README 到系统说明

`createPagesRouter()` 在创建时同步读取 `README.md` 和 `README.en.md`，各文件必须各有且仅有一组 `<!-- APP_GUIDE_EXCLUDE_START -->` / `<!-- APP_GUIDE_EXCLUDE_END -->`，并且结束标记不在开始之前。它删除该区段后用 `marked.parse(..., { async: false })` 生成 HTML，并按语言 Cookie 在 `/guide` 注入。

这建立了明确的信任边界：README 内容会成为未额外净化的 HTML，只有仓库受信任维护者应修改它；标记错误会使页面路由创建/启动失败。两份 README 必须随发布产物放在 `dist` 的上级运行目录，`Dockerfile` 专门复制它们。`test/integration/server-lifecycle.test.ts` 对 clean build 的双语 guide、缺少/重复/乱序标记和打包 README 行为做验证。

页面结构和导航行为由 `test/integration/pages.test.ts` 覆盖。修改模板、静态模块或翻译后，优先运行 `npm test -- --run test/integration/pages.test.ts test/unit/i18n.test.ts`；修改 README 标记或构建复制规则时再运行 `test/integration/server-lifecycle.test.ts`。