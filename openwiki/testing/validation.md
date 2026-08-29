---
type: 测试指南
title: 测试分层与变更验证
description: 将 VidHarbor 的单元、集成和端到端测试映射到系统所有者，并给出最小验证命令。
tags: [testing, validation]
---

# 测试分层与变更验证

测试使用 Vitest。单元测试隔离纯解析、配置、调度、文件流、语言与任务管理器；集成测试以临时 SQLite、临时下载目录和伪 yt-dlp/ffmpeg 覆盖路由、事务、恢复及安全失败；`test/integration/end-to-end.test.ts` 连接设置、频道、提醒、下载、归档和重启后的读取，是跨域行为的最高密度证据。

| 变更意图 | 聚焦测试 | 最小命令 |
| --- | --- | --- |
| 下载状态、归档、删除 | `download-service`、`download-worker`、`download-delete-recovery` | `npm test -- --run test/integration/download-service.test.ts test/integration/download-worker.test.ts test/integration/download-delete-recovery.test.ts` |
| 频道同步、提醒、Bilibili | `channel-initial-sync`、`channel-scheduled-check`、`channel-notification-api` | `npm test -- --run test/integration/channel-initial-sync.test.ts test/integration/channel-scheduled-check.test.ts test/integration/channel-notification-api.test.ts` |
| Cookie/代理/设置 | `cookie-authorization-api`、`settings-proxy-api`、`cookie-authorization` | `npm test -- --run test/integration/cookie-authorization-api.test.ts test/integration/settings-proxy-api.test.ts test/unit/cookie-authorization.test.ts` |
| HTTP、分页、媒体服务 | `http-contract`、`download-api`、`file-stream`、`pagination` | `npm test -- --run test/integration/http-contract.test.ts test/integration/download-api.test.ts test/unit/file-stream.test.ts test/unit/pagination.test.ts` |
| 启动、迁移、恢复 | `server-lifecycle`、`database`、`restart-recovery` | `npm test -- --run test/integration/server-lifecycle.test.ts test/integration/database.test.ts test/integration/restart-recovery.test.ts` |
| 页面与双语 | `pages`、`i18n` | `npm test -- --run test/integration/pages.test.ts test/unit/i18n.test.ts` |

完整仓库验证与 CI 一致：

```sh
npm test -- --run --maxWorkers=1
npm run build
docker compose config --quiet
```

`npm run build` 同时验证 TypeScript、Sass 和运行期资源复制；Dockerfile 或容器依赖改动还应执行 `docker compose build`。不要用真实 Cookie、代理凭据或外网平台作为测试输入；现有夹具 `test/fixtures/fake-yt-dlp.mjs` 与集成测试内置脚本正是为可重复、离线验证而存在。