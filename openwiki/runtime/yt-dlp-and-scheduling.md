---
type: 运行时子系统
title: yt-dlp 任务与频道调度
description: 说明 yt-dlp 子进程隔离、任务类型、媒体并发、取消和每分钟频道到期检查。
tags: [yt-dlp, scheduler]
---

# yt-dlp 任务与频道调度

`src/yt-dlp-task-manager.ts` 是所有 yt-dlp 工作的单一入口。任务类型为 `media_download`、`metadata_probe`、`channel_initial_sync`、`channel_manual_check`、`channel_scheduled_check`；任务快照仅保存在内存，重启后 ID 从 1 重启且历史消失。媒体任务走 FIFO 队列并受启动时固定的下载并发限制，其它任务立即以 microtask 启动，因此频道探测不占媒体并发槽。

`YtDlpTaskManager.cancel()` 可从队列移除尚未开始的媒体任务，或以 `AbortController` 中止运行任务；`stop()` 取消全部活动任务并等待收敛。其状态为 queued、running、succeeded、failed、canceled。队列行为由 `test/unit/yt-dlp-task-manager.test.ts`，与 worker 的协作由 `test/integration/download-worker.test.ts` 覆盖。

## 子进程边界

`src/yt-dlp.ts` 用 `spawn(..., { detached: true, shell: false })` 启动进程组，不经过 shell。通用参数包括 `--ignore-config`、Node JS runtime、30 秒 socket timeout；频道/元数据读取用 `--dump-json`，限时 15 分钟；媒体下载用无活动输出 15 分钟超时。超时、取消或解析回调错误会对整个进程组 SIGKILL。

探测强制 `--no-playlist` 且必须恰好一个 JSON 值；频道可使用日期下界和 `--flat-playlist`。下载强制 `--no-playlist`，用 `after_move:filepath` 交回主媒体路径，并从标准输出/错误中的专用进度行持久化百分比、速度和 ETA。stderr 最多捕获 8 KiB，代理 URL 在错误中被脱敏。高级选项可映射格式、音频、字幕、章节、分辨率、转码和时间段参数。

## 调度器

`ChannelScheduler` 每 60 秒执行 `tick()`，只加载首次同步成功的频道。它跳过暂停频道、没有有效间隔的异常记录和同一频道仍在执行的检查；到期依据优先使用 `next_check_at`，否则由初始/上次开始时间加间隔计算。每个合格频道并行提交 scheduled check，但同一频道在 `#runningChecks` 中至多一项。

检查的业务执行会记录获取/元数据失败，调度器将这些已记录失败及取消视为可收敛结果；其他拒绝被上报给 `RuntimeCoordinator`，导致服务器失败与关闭。`test/unit/scheduler.test.ts` 覆盖到期、暂停和去重；`test/integration/channel-scheduled-check.test.ts` 覆盖真实服务转换。