## Cookie 登录态管理

- 描述：新增授权管理入口，按当前官方支持平台保存一份 Netscape 格式 cookies.txt，支持上传、替换和删除，并提供安全的 Cookie 获取说明；第一版只管理，不验证远端有效性，也不接入频道或下载流程。
- issue整理:
  - 做什么：为 YouTube、Bilibili、X、Facebook、抖音分别管理最多一份 Netscape 格式 cookies.txt，展示配置状态和更新时间，并提供获取教程。
  - 边界：只支持 Cookie；不支持 Vimeo、多个账号、用户名密码、Token、OAuth、Local Storage、额外请求头、自动格式转换、远端验证或业务流程注入。
  - 最终决策：上传时严格校验 Netscape Cookie 文件，拒绝空文件和损坏格式；Cookie 原文不得通过页面、API、日志或错误信息暴露，已配置只代表保存且格式正确。
- 来源: Gitea #14

## 取消 Vimeo 官方支持

- 描述：从当前文档、界面和测试契约中移除 Vimeo 官方支持及验证承诺，但不新增平台黑名单，保留通用 HTTPS 直链探测能力和旧记录显示兼容。
