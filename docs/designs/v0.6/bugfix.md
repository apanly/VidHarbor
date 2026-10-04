# v0.6 bugfix

## bugfix-01 · task-04 解析阶段取消被记为 failed 并使 DownloadWorker 永久故障

- 来源 review: review-1.md
- 关联 task: task-06
- 描述: `src/download-worker.ts:466` Worker 在 media_download 任务内 await resolveWeixinVideo 并传入 operations.signal；用户取消或服务停止时 signal 被 abort，`src/weixin.ts:222`（及 200 行 response 'error'）统一 reject(fetchFailed())，抛出 BusinessError('VIDEO_FETCH_FAILED') 而非 YtDlpTaskCancellationError，#run 判定为 failed，又因 signal.aborted 且无 boundaryFailure 走边界异常路径，经 #reportFailure 抛出 DownloadWorkerBoundaryError，worker 进入永久故障直到重启。修复要求：保持 VIDEO_FETCH_FAILED 契约，解析阶段 signal 已中止时回到既有取消边界（如 await 失败路径先 this.#throwIfCanceled(operations.signal)，否则原样抛出解析错误，不吞错）；在 download-worker.test.ts 增加用例：resolveWeixinVideo 挂起期间调用 worker.cancel，断言行状态为 canceled、worker.waitForIdle() 正常 resolve、后续任务仍能执行。

## bugfix-02 · directCookiePlatform 的 weixin→yuanbao 映射违反元宝 Cookie 使用范围

- 来源 review: review-1.md
- 关联 task: task-07
- 描述: `src/services/download.ts:325` directCookiePlatform 只服务于传给 yt-dlp 的 cookieFilePath，新增的 `if (isWeixinVideoHost(url)) return 'yuanbao';` 在视频号路径中不可达，唯一可达情形会把元宝 Cookie 作为 cookieFilePath 交给 yt-dlp，违反「元宝 Cookie 只用于 get_parse_result，不传给 yt-dlp」。修复要求：删除该行，元宝 Cookie 只经 findWeixinCookieFilePath → weixinCookieFilePath 获取。

## bugfix-03 · weixin / yuanbao 平台标签写死单一语言

- 来源 review: review-1.md
- 关联 task: task-08
- 描述: `src/public/downloads.js:31` platformLabels 写死 `weixin: '微信视频号'`，`src/public/authorizations.js:10` 写死 `yuanbao: 'Yuanbao'`，违反契约中「微信视频号 / WeChat Channels」「元宝 / Yuanbao」的中英文展示名要求。修复要求：在 src/i18n.ts 为这两个平台标签增加中英文键，前端通过 t() 取值，并在 pages.test.ts 按语言断言；不改动现有其他平台标签。
