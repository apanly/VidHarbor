---
type: 快速开始
title: VidHarbor 代码 Wiki 导航
description: VidHarbor 的架构入口、核心工作流、变更路由和验证索引。
tags: [overview, navigation]
---

# VidHarbor 代码 Wiki 导航

VidHarbor 是部署在可信内网的单用户视频管理服务：订阅 YouTube/Bilibili 频道、发现新视频、产生站内提醒，并只在用户明确选择时用 yt-dlp 归档媒体。运行入口是 `src/server.ts:startServer`；核心耐久状态在 SQLite，外部工具为 yt-dlp 和 ffmpeg。

## 系统地图

- [运行时架构](architecture/overview.md)：启动装配、恢复、故障升级、关闭和单实例约束。
- [SQLite 模式与状态](architecture/persistence.md)：实体、迁移、事务、升级与重启恢复。
- [下载工作流](downloads/workflow.md)：直连/频道创建、worker、归档、删除、媒体流。
- [频道工作流](channels/workflow.md)：首次同步、定时发现、提醒和平台元数据。
- [yt-dlp 与调度](runtime/yt-dlp-and-scheduling.md)：任务队列、子进程、超时、取消和到期检查。
- [安全与配置](operations/security-and-configuration.md)：可信内网、挂载、代理、Cookie 和文件路径安全。
- [构建与发布](operations/build-and-release.md)：`dist`、Docker、Compose 和 CI。
- [HTTP API](api/http-contract.md)：路由、中间件、错误、SSE、Range。
- [Web 与双语](web/interface-and-i18n.md)：EJS、浏览器模块、翻译、README guide。
- [测试与验证](testing/validation.md)：按变更范围选择测试与完整检查。

## 任务路由

| 要改什么 | 先读 | 主要入口/符号 | 聚焦测试 | 最小验证 |
| --- | --- | --- | --- | --- |
| 下载创建、状态、归档或删除 | [下载工作流](downloads/workflow.md) | `createDirectDownload`、`DownloadWorker`、`deleteDownload` | `download-service`、`download-worker` | `npm test -- --run test/integration/download-worker.test.ts` |
| 频道平台、同步或提醒 | [频道工作流](channels/workflow.md) | `parseChannelSource`、`completeScheduledCheck` | `channel-initial-sync`、`channel-scheduled-check` | `npm test -- --run test/integration/channel-scheduled-check.test.ts` |
| yt-dlp 参数、队列或调度 | [yt-dlp 与调度](runtime/yt-dlp-and-scheduling.md) | `YtDlpTaskManager`、`ChannelScheduler` | `yt-dlp-task-manager`、`scheduler` | `npm test -- --run test/unit/yt-dlp-task-manager.test.ts test/unit/scheduler.test.ts` |
| SQL/迁移/恢复 | [SQLite 模式与状态](architecture/persistence.md) | `migrateDatabase`、`recoverInterruptedChannelSyncs` | `database`、`restart-recovery` | `npm test -- --run test/integration/database.test.ts` |
| Cookie、代理或路径安全 | [安全与配置](operations/security-and-configuration.md) | `CookieAuthorizationService`、`validateDownloadFile` | `cookie-authorization`、`filesystem` | `npm test -- --run test/unit/cookie-authorization.test.ts test/unit/filesystem.test.ts` |
| API、SSE 或文件响应 | [HTTP API](api/http-contract.md) | `createApp`、`createDownloadsRouter` | `http-contract`、`download-api` | `npm test -- --run test/integration/http-contract.test.ts` |
| 页面、语言或系统说明 | [Web 与双语](web/interface-and-i18n.md) | `createPagesRouter`、`i18n.ts` | `pages`、`i18n` | `npm test -- --run test/integration/pages.test.ts test/unit/i18n.test.ts` |
| Docker、依赖或 CI | [构建与发布](operations/build-and-release.md) | `package.json`、`Dockerfile`、`ci.yml` | `server-lifecycle` | `npm run build && docker compose config --quiet` |

## 不可破坏的边界

- 频道发现不自动下载；历史同步不创建提醒，后续检查只为新平台视频 ID 创建提醒。
- 下载根和媒体文件必须经真实路径、包含关系和安全打开验证；完成删除是可恢复的 `deleting` 协议。
- Cookie 与代理凭据是敏感数据：不回读 Cookie，不在错误中暴露代理凭据，只限可信内网。
- SQLite 模式必须精确匹配内置迁移；下载并发在服务器启动时读取，修改设置后需重启生效。
- Docker 仅支持 amd64/arm64，且运行期需要模板、静态资源、迁移和两份 README。

## 完整检查

```sh
npm test -- --run --maxWorkers=1
npm run build
docker compose config --quiet
```

## Backlog

无：当前仓库内可安全检查的主要服务、API、工作流、构建和测试均已覆盖。