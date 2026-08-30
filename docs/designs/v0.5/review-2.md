## 整体评价

**结论**：needs-fix

发现 1 条需修问题，修复后再合入。

---

## 问题列表

### [blocker] task-15 未完全清理 src/i18n.ts 重格式漂移
- **位置**: `src/i18n.ts:313`
- **问题**: 上一轮要求恢复 src/i18n.ts 的无关重格式漂移，只保留必要翻译键；当前文件虽然恢复为单引号，但 en catalog 从第 313 行开始仍把大量既有翻译键压成超长单行，后续 validateCatalogs、t、interpolate、safeJson 等函数也继续被压缩成单行，变更集仍携带与 DOWNLOAD_MOVE_* 和 downloads.move 文案无关的整文件重排。
- **建议**: 按任务基线恢复 src/i18n.ts 的原有换行与排版，只保留本次需要的 downloads.move、downloads.movePrompt 以及 DOWNLOAD_MOVE_* 翻译键增量。
- **最终裁定**: 需修（原因：不修复时，本批仍会把大段无关格式噪音合入，后续审查和回滚无法可靠区分真实 i18n 文案变更与格式漂移。）
