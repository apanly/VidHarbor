# v0.5 bugfix

## bugfix-01 · task-09 测试更新未完成

- 关联 task: task-10 (补完 task-07 直下载页), task-11 (清理重格式漂移 + i18n 错误码映射), task-12 (task-09 既有契约测试 + 新增用例), task-13 (parseChannelInput 契约导致的测试失败)
- 来源 task: task-09
- 描述: task-09 worker 超时/中断后未产出 `.cc-drive-agent/runs/v0.5/task-09/result.json`，CLI 标记失败。已留下部分测试与前端/i18n 修改，需要完成 task-09 验收：补齐 `targetSubdirectory` 相关测试、保证必要测试通过，并清理非必要格式漂移。
