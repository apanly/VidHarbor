---
type: 构建与发布
title: 构建产物、容器与持续集成
description: 说明源码如何生成 dist、Docker 如何验证运行依赖，以及 CI 如何测试、构建并发布多架构镜像。
tags: [build, docker, ci]
---

# 构建产物、容器与持续集成

`package.json` 要求 Node 24，`npm run build` 先清理 `dist`，以 `tsc` 编译 TypeScript，编译 Sass，然后复制 Bootstrap、`src/public/*`、迁移 SQL 和 EJS 模板。运行命令是 `node dist/server.js`。`src/db/migrate.ts` 从已复制的 `dist/db/migrations` 读取迁移，`src/routes/pages.ts` 从已复制视图与静态资源运行；漏复制任一类文件都会在发布产物中失败。

`README.md` 和 `README.en.md` 虽不在 `dist`，也是运行依赖：`/guide` 在启动时读取它们。构建镜像必须带上二者，详情见 [Web 界面](../web/interface-and-i18n.md)。本地完整检查为：

```sh
npm ci
npm test -- --run --maxWorkers=1
npm run build
docker compose config --quiet
```

## Docker 与 Compose

`Dockerfile` 的三个阶段均固定为带 digest 的 `node:24.18.0-bookworm-slim` 基础镜像，并只为 amd64 和 arm64 构建。yt-dlp 阶段下载固定版本二进制，校验 SHA-256、ELF 架构与版本；build 阶段以 `npm ci` 安装依赖、从源构建 `better-sqlite3` 并验证架构，随后 `npm prune --omit=dev` 只保留生产依赖；runtime 只复制这些裁剪后的 `node_modules`、`dist` 和运行 README，安装固定 ffmpeg 并再次验证 yt-dlp、原生模块和 ffmpeg。其他架构会明确失败。

运行镜像以 `node` 用户运行，创建并拥有 `/data` 与 `/downloads`，默认环境与应用配置一致，声明两个卷，健康检查为 `GET /` 返回 200。健康只证明 Web 进程可响应，不证明外部平台、代理或下载能力可用。

`compose.yaml` 构建 `vidharbor:v0.2`，把 `127.0.0.1:3002` 映射到容器 3000，并使用命名卷持久化 `/data`、`/downloads`。若改成局域网监听，仍须在网络层限制来源。备份和单实例限制见 [安全与配置](security-and-configuration.md)。

## CI 发布契约

`.github/workflows/ci.yml` 的 test job 在 Node 24 上执行串行 Vitest、构建和 `docker compose config --quiet`。docker job 依赖测试成功，设置 QEMU/Buildx，并构建 `linux/amd64,linux/arm64`；仅 push 事件登录 GHCR 并推送 `latest` 与 `sha-<short SHA>` 标签，PR 只构建。改动 Docker、包脚本、运行期复制文件或 Compose 时应运行上述完整检查。