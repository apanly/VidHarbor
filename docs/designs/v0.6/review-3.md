## 整体评价

**结论**：pass

未发现阻断性问题，1 条供参考，建议合入。

---

## 问题列表

### [nit] postJson 通过端点对象身份判断附加来源头，调用点看不出 feed 请求的完整请求头
- **位置**: `src/weixin.ts:186`
- **问题**: postJson 是两个请求共用的传输函数，Cookie 由调用方以参数传入，而本次新增的 Origin/Referer 却在函数内部以 `endpoint === WEIXIN_FEED_ENDPOINT` 的对象引用比较隐式附加。请求头来源被分散在调用参数与传输函数内部两处，阅读 resolveWeixinVideo 中 feed 调用点（第 344 行）无法看出该请求实际携带的头；且判断依赖模块级 URL 实例的引用相等，而非显式契约。
- **建议**: 保持行为不变的前提下，把请求头的差异集中到调用方：例如将 postJson 的 cookieHeader 参数改为 extraHeaders: Record<string,string>，元宝调用传 { Cookie }，feed 调用传固定 { Origin, Referer }；或保留现状但在 feed 调用点注释说明来源头由 postJson 附加。
- **最终裁定**: 供参考（原因：nit 不阻断合入）
