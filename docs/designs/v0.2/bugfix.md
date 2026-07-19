## bugfix-01 · 复验唯一 yt-dlp 底层导入

- 关联 task: task-13
- 描述: task-02 的管理器实现及测试均通过，但执行当时 src/download-worker.ts 仍直接导入 src/yt-dlp.ts；该旧导入已由后续 task-03 移除，需要按当前最终代码重新执行唯一入口静态验收并关闭失败状态。

## bugfix-02 · 修正元数据探测静态验收冲突

- 关联 task: task-14
- 描述: task-04 已移除下载服务对底层 fetchVideoMetadata 的直接导入和可选 cancel，并通过 20 个集成测试；失败来自静态命令同时匹配管理器契约要求的 operations.fetchVideoMetadata 方法名，需要在不使用字符串拼接等投机规避的前提下，使验收检查准确区分底层直连与受控 operation 调用。
