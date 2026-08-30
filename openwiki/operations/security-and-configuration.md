---
type: 运维与安全
title: 部署配置、凭据与文件安全
description: 说明 VidHarbor 的可信内网边界、挂载和环境配置、代理与 Cookie 凭据生命周期，以及下载文件防护。
tags: [security, operations]
---

# 部署配置、凭据与文件安全

VidHarbor 没有登录、用户隔离或授权系统，只能部署到可信内网。`requireSameOrigin` 仅要求所有写请求的 `Origin` 精确等于请求协议和 `Host`，是 CSRF 限制而不是身份认证；不要将服务端口直接暴露到公网。数据库浏览 API 虽拒绝写 SQL，但查询结果仍可能含代理凭据。

## 配置、挂载和代理

`src/config.ts` 从 `PORT`、`DATABASE_PATH`、`DOWNLOADS_MOUNT_PATH` 读取配置，默认分别为 `3000`、`/data/vidharbor.db`、`/downloads`。启动前必须能访问下载挂载，并能执行 yt-dlp 与 ffmpeg。`/data` 同时保存数据库和 `cookies/`，`/downloads` 保存归档；两者均须持久化和受备份保护。

`src/services/settings.ts` 保存全局检查间隔和下载并发，下载根只从部署配置暴露。并发更新需重启，原因见 [运行时架构](../architecture/overview.md)。代理支持 `http`、`https`、`socks5`，数据库中保存完整 URL（可能含凭据）；响应只返回用户名和遮罩密码。代理被频道引用时不能删除。失败原因经 `src/redaction.ts` 擦除代理 URL/凭据；不要把原始代理 URL 写进日志或文档。

## Cookie 授权存储

`CookieAuthorizationService` 管理 youtube、bilibili、x、facebook、douyin 五个固定平台，每个平台最多一个 `*.cookies.txt`。YouTube/Bilibili 频道可选择同平台授权；频道初始同步、手动检查、定时检查和频道视频下载会把 Cookie 文件路径传给 yt-dlp。直接下载会按 URL 所属平台自动使用已配置的同平台 Cookie，并把同一文件传给元数据探测、媒体下载和缩略图下载；未选择授权的频道不使用 Cookie。

上传是未缓冲的 `application/octet-stream` 请求。服务流式验证 Netscape 格式：至少一条数据记录、恰好七个 tab 字段、有效域/布尔字段/数字过期字段，并支持 `#HttpOnly_`。它以 `wx` 创建每平台固定临时文件、权限 `0600`、同步后 rename 原子替换；目录权限为 `0700`。启动会删除遗留临时文件并收紧已有文件权限，每个平台的写操作在进程内串行化。API 只返回 `configured` 和更新时间，永不回读内容；授权被频道引用时拒绝删除。

Cookie 等同登录凭据。不得将其传入聊天、截图、日志、工单、Git 或备份外部存储。`test/unit/cookie-authorization.test.ts` 与 `test/integration/cookie-authorization-api.test.ts` 覆盖格式、原子替换、权限、同源、非泄露和引用保护。

## 下载文件边界

`validateDownloadRoot()` 要求绝对路径，经 `realpath` 后位于真实下载挂载内且可读写进入。`validateDownloadFile()` 要求解析后的常规文件同时位于真实挂载和根内，以 `O_NOFOLLOW` 打开，并校验打开后 dev/inode 未变化，降低符号链接和验证后替换攻击。worker 的临时目录、归档与删除隔离目录也经过包含关系检查。修改路径或删除逻辑时先运行 `test/unit/filesystem.test.ts` 和 `test/integration/download-delete-recovery.test.ts`。