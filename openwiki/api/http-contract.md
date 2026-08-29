---
type: HTTP API 契约
title: HTTP 路由、错误与流式接口
description: 说明 Express API 的中间件、资源路由、分页、错误响应、SSE 和下载 Range 语义。
tags: [api, http]
---

# HTTP 路由、错误与流式接口

`createApp()` 在所有 `/api` 响应上设置 JSON 类型，并依次应用 `requireSameOrigin`、内容类型守卫和 `express.json()`；Cookie 上传是唯一例外，`POST`/`PUT /authorizations/cookies/:platform` 必须是 `application/octet-stream` 且以请求流交给授权服务，其他 POST/PUT/PATCH 必须为 JSON。JSON 解析失败会转换为 `VALIDATION_ERROR`。未捕获异常不回显原始消息或堆栈，避免泄露代理/Cookie 路径；错误处理器只在服务端以结构化 `api_internal_error` 记录方法、路径和错误类名，再向客户端返回通用 `PERSISTENCE_ERROR`。

`BusinessError` 与 `ERROR_HTTP_STATUS` 是稳定错误面：400 是参数/Origin/媒体类型问题；404 是不存在或不可用文件；409 是名称、引用、重复下载和删除竞争；416 是 Range；422 是域验证、平台/元数据和下载根问题；500 是持久化失败。响应固定为 `{ "error": { "code", "message" } }`。所有 ID 路径参数必须是正的安全整数。

## 资源路由

| 路由族 | 方法与关键行为 | 所有者 |
| --- | --- | --- |
| `/api/settings`、`/api/proxies` | 设置读取/更新；代理 CRUD | `services/settings.ts`、`services/proxy.ts` |
| `/api/authorizations/cookies` | 已配置列表、流式创建/替换、引用安全删除 | `CookieAuthorizationService` |
| `/api/channels` | 频道 CRUD、首次同步、检查、暂停/恢复、视频/检查分页 | `services/channel.ts` |
| `/api/notifications` | 分页、单条/批量/全部标已读 | `services/notification.ts` |
| `/api/downloads` | 直连/频道创建、列表/详情、取消、重试、删除、媒体 | `services/download.ts` |
| `/api/yt-dlp/tasks` | 进程内任务快照 | `YtDlpTaskManager` |
| `/api/database` | 表列表和 prepared statement 只读 SQL | `routes/database.ts` |

列表分页统一用 `page` 正整数和 `PAGE_SIZE = 20`。频道视频、下载列表可用 `q` 做服务端标题筛选；下载 `tab` 是 active、completed、failed，分别映射活动、完成和失败终态集合。

## 实时与文件接口

`GET /api/downloads/events` 是 SSE：先发送当前分页快照，后每十秒重新查询，只有 JSON 字符串变化时发送 `event: downloads`。连接关闭时清理定时器和 `RuntimeCoordinator` 注册；服务器关闭也会结束全部此类流。

`GET /api/downloads/:id/{media,file,thumbnail}` 支持单一 `bytes=` Range 与 `HEAD`。读取前服务会重新做安全文件验证；成功范围返回 206 与 `Content-Range`，无效范围返回 416 和 `Content-Range: bytes */size`。`file` 设 attachment，media/thumbnail 内联。详见 [下载工作流](../downloads/workflow.md)。

页面路由不是 API：`src/routes/pages.ts` 提供 `/`、`/settings`、`/authorizations`、`/channels`、`/notifications`、`/downloads`、`/database`、`/downloads/preview`、`/guide`、`/channels/:id` 与 `/public/*`。HTTP 契约的聚焦测试是 `test/integration/http-contract.test.ts`、`test/integration/download-api.test.ts`、`test/integration/settings-proxy-api.test.ts` 和 `test/integration/yt-dlp-tasks-api.test.ts`。