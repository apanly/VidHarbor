已忽略 1 个文件（package-lock.json 1）

## 整体评价

**结论**：needs-fix

发现 1 条需修问题，修复后再合入。

---

## 问题列表

### [blocker] task-04 取消处于视频号解析阶段的下载会被记为 failed 并使整个 DownloadWorker 进入永久故障
- **位置**: `src/download-worker.ts:466`
- **问题**: Worker 在 media_download 任务内 await resolveWeixinVideo，并传入 operations.signal。用户取消，或服务停止时 YtDlpTaskManager.cancel/stop 会对该 signal 执行 abort(cancellationError())。src/weixin.ts:222 的 request 'error' 监听器（以及 200 行的 response 'error'）不区分是否已中止，统一 reject(fetchFailed())，抛出的是 BusinessError('VIDEO_FETCH_FAILED')，而不是 YtDlpTaskCancellationError。#run 的 catch 因此判定 failedStatus='failed'；又因为 operations.signal.aborted 为 true 且 boundaryFailure 未定义，第 614-620 行把它当作边界异常，最后经 #reportFailure 抛出 DownloadWorkerBoundaryError。新增测试只覆盖了单元层『已中止 signal → VIDEO_FETCH_FAILED』，没有覆盖 worker 在解析阶段被取消的状态转换。
- **建议**: 保持 VIDEO_FETCH_FAILED 契约不变，在 worker 中让解析阶段的取消回到既有取消边界。例如在 resolveWeixinVideo 的 await 失败路径上先执行 this.#throwIfCanceled(operations.signal)，即 signal 已中止时抛 YtDlpTaskCancellationError，否则原样抛出解析错误，不吞错。也可以在 src/weixin.ts 的 postJson 错误回调中，signal?.aborted 为 true 时 reject(signal.reason)。同时在 download-worker.test.ts 增加用例：resolveWeixinVideo 挂起期间调用 worker.cancel，断言行状态为 canceled、worker.waitForIdle() 正常 resolve，且后续任务仍能执行。
- **最终裁定**: 需修（原因：解析最多包含两次各 30 秒超时的请求。在这段时间里取消视频号下载，该行会被记为 failed 而不是 canceled，worker.failure 被置位，其它排队/运行中的下载全部被取消，此后每次 enqueue 都直接抛错，直到重启进程。服务正常停止时也会走这条边界失败路径。这违反了 task-04『不能改变取消/清理/归档状态转换』的约束。）

### [suggest] directCookiePlatform 新增 weixin→yuanbao 映射是死代码且语义违反元宝 Cookie 使用范围
- **位置**: `src/services/download.ts:325`
- **问题**: directCookiePlatform 只服务于传给 yt-dlp 的 cookieFilePath（findDirectCookieFilePath / findRetryCookieFilePath）。新增的 `if (isWeixinVideoHost(url)) return 'yuanbao';` 在新路径中不可达：probeDirectDownload 对 weixin host 已提前 return，retryDownload 对 platform='weixin' 也不调用 findRetryCookieFilePath。唯一可达情形是 source_url 为 weixin.qq.com / channels.weixin.qq.com 但 platform≠'weixin' 的 direct 行重试，此时会把元宝 Cookie 作为 cookieFilePath 交给 yt-dlp，与 §1.1「元宝 Cookie 只用于 get_parse_result，不传给 yt-dlp」及 task-03「不得复用传给 yt-dlp 的 cookieFilePath」直接冲突。
- **建议**: 删除第 325 行；元宝 Cookie 只经 findWeixinCookieFilePath → weixinCookieFilePath 这一条通道获取。
- **最终裁定**: 供参考（原因：suggest 不阻断合入）

### [suggest] 新平台标签只写死单一语言，未按契约提供中英文展示名
- **位置**: `src/public/downloads.js:31`
- **问题**: §1.6 要求列表平台前端显示「微信视频号 / WeChat Channels」，task-05 要求新增文案走 src/i18n.ts 中英文键；但 platformLabels 写死 `weixin: '微信视频号'`，英文界面同样显示中文。授权页 src/public/authorizations.js:10 同理写死 `yuanbao: 'Yuanbao'`，与 §1.1「展示名为“元宝 / Yuanbao”」不一致，中文界面显示 Yuanbao。（现有 douyin 标签也是写死的，所以这里定为 suggest 而非 blocker。）
- **建议**: 为 weixin 与 yuanbao 平台标签增加 i18n 键（如 platform.weixin = 微信视频号 / WeChat Channels，platform.yuanbao = 元宝 / Yuanbao），platformLabels 通过 t() 取值，并在 pages.test.ts 中按语言断言。
- **最终裁定**: 供参考（原因：suggest 不阻断合入）
