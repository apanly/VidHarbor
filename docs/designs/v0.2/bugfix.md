## bugfix-01 · 复验唯一 yt-dlp 底层导入

- 关联 task: task-13
- 描述: task-02 的管理器实现及测试均通过，但执行当时 src/download-worker.ts 仍直接导入 src/yt-dlp.ts；该旧导入已由后续 task-03 移除，需要按当前最终代码重新执行唯一入口静态验收并关闭失败状态。

## bugfix-02 · 修正元数据探测静态验收冲突

- 关联 task: task-14
- 描述: task-04 已移除下载服务对底层 fetchVideoMetadata 的直接导入和可选 cancel，并通过 20 个集成测试；失败来自静态命令同时匹配管理器契约要求的 operations.fetchVideoMetadata 方法名，需要在不使用字符串拼接等投机规避的前提下，使验收检查准确区分底层直连与受控 operation 调用。

## bugfix-03 · 取消下载时阻断后处理成功落库

- 关联 task: task-15
- 描述: review-1 在 src/download-worker.ts:619 发现管理器直接取消只设置 task cancelRequested，DownloadWorker 的后处理检查无法观察该取消；若取消发生在 yt-dlp 完成后的校验或归档阶段，下载仍可能归档并写为 completed，而管理器快照为 canceled。所有取消来源必须共享可观察取消状态，并在校验、归档和成功落库前阻断。

## bugfix-04 · 正常停机取消不得上报 runtime 故障

- 关联 task: task-16
- 描述: review-1 在 src/routes/channels.ts:41 发现管理器取消以普通 Error 拒绝，首次同步和 scheduler 会把正常停机取消当作系统故障上报，可能让 RunningServer.failure 拒绝并导致非零退出。必须提供可识别的取消错误，并在这些错误边界排除正常取消，同时保留任务和频道业务状态收敛。

## bugfix-05 · 页面任务测试失败路径必须释放 gate

- 关联 task: task-17
- 描述: review-1 在 test/integration/pages.test.ts:697 发现任务页面用例只在断言成功后释放两个 gate；任一断言失败会让 afterEach 的 taskManager.stop() 永久等待。必须用 try/finally 无条件释放 gate 并等待两个任务 allSettled。
