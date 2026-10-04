## 直连下载支持微信视频号单视频

- 描述：直连下载支持提交微信视频号分享链接 `https://weixin.qq.com/sph/<id>`，经元宝解析拿到视频地址后归档到本地。
- issue整理:
  - 做什么：授权管理新增「元宝」Cookie；直连下载识别视频号分享链接，由 VidHarbor 调用元宝 `POST https://yuanbao.tencent.com/api/weixin/get_parse_result`（body `{"type":"video_channel_url","url":<分享链接>,"scene":1}`，带元宝 Cookie）取得 `playable_url` 中的 `token`、`eid`，再调用 `POST https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info`（body `{"baseReq":{"generalToken":token},"exportId":eid}`，无需 Cookie）取得标题、作者昵称和视频地址，视频地址交给 yt-dlp 通用下载。已实测 2 条真实链接，下载结果为可直接播放的明文 MP4，无需解密。
  - 边界：仅接受 `https://weixin.qq.com/sph/<id>`，其他视频号 URL 形式（finder-preview 页面、feed 地址等）不支持；不支持关注视频号频道和自动发现新视频；不支持直播、直播回放、图片类内容；不支持高级选项，提交非默认高级选项明确报错，前端对视频号链接禁用高级选项；未配置元宝 Cookie 时明确报错；不做本地代理抓包、PC 微信注入、第三方付费解析、视频解密；不下载封面缩略图。
  - 最终决策：视频号链接不走 yt-dlp 元数据探测；任务保存分享链接、不保存会过期的视频地址，每次执行下载和重试都重新解析；platform_video_id 使用分享短 ID（如 `AVIerfY9nv`）；元宝 Cookie 使用 Netscape 文件，复用现有授权管理的上传、替换、删除与校验；解析请求和 yt-dlp 下载都使用用户所选代理或直连，与其他平台一致；作者昵称作为建议保存子目录来源，与现有 channel/uploader 逻辑一致。
- 来源: Gitea #24
