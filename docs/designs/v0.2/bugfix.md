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

## bugfix-06 · 关闭 completed 落库后的取消窗口

- 关联 task: task-18
- 描述: review-2 在 src/download-worker.ts:503 发现 completed 落库后仍 await 临时目录清理，任务保持 running 且可被取消，最终可能出现下载记录 completed、管理器 canceled 且归档文件保留。必须在成功落库前完成清理并作最后一次取消检查，在业务终态确定前保留归档回滚信息。

## bugfix-07 · 删除下载 worker 的错误消息取消判断

- 关联 task: task-18
- 描述: review-2 在 src/download-worker.ts:281 发现 isCancellationError 依赖固定英文 message，可能在取消期间把进程组终止等非固定消息异常当普通缩略图失败吞掉。必须使用任务 signal 或类型化取消契约判断，并覆盖取消期间底层抛出其他错误的负向测试。

## bugfix-08 · 取消不得掩盖执行阶段系统故障

- 关联 task: task-19
- 描述: review-2 在 src/yt-dlp-task-manager.ts:321 发现 cancelRequested 会把执行器随后抛出的任何持久化、归档、清理或未知系统错误改写为 canceled。只有可类型识别的正常取消结果才能落 canceled；真实系统错误必须保留 failed 终态和原始拒绝并继续上报。

## bugfix-09 · 失败任务必须有非空 failureReason

- 关联 task: task-20
- 描述: review-2 在 src/yt-dlp-task-manager.ts:342 发现执行器以空字符串拒绝或脱敏函数返回空字符串时可产生 failed 且 failureReason 为空，违反固定快照/API 契约。必须规范化并校验为固定非空失败描述。

## bugfix-10 · 窄桌面任务表格必须可查看全部字段

- 关联 task: task-21
- 描述: review-2 在 src/styles/main.scss:1182 发现自定义 overflow: hidden 覆盖 Bootstrap table-responsive 的横向滚动，略高于移动断点且有侧栏时会裁掉时间与失败原因列。必须保留横向滚动或调整卡片断点，确保固定字段可见。

## bugfix-11 · 取消不得掩盖进程组终止失败

- 关联 task: task-19
- 描述: review-2 在 src/yt-dlp-task-manager.ts:321 复现取消期间 process.kill(-pid) 失败后 stop 仍成功且任务为 canceled；进程组终止失败和频道清理持久化失败必须保留 failed 并让 stop 或 runtime 故障边界感知。

## bugfix-12 · 页面测试必须执行真实 load 接线

- 关联 task: task-22
- 描述: review-2 在 test/integration/pages.test.ts:741 发现核心页面用例自行请求 API、复制分类逻辑并直接调用 renderGroup，未执行生产模块的 load、fetch、分类与渲染接线。必须在可控 DOM 中执行完整加载路径并从最终 DOM 断言。

## bugfix-13 · 唯一入口扫描必须拒绝动态导入绕过

- 关联 task: task-23
- 描述: review-2 在 test/integration/pages.test.ts:823 发现唯一底层入口检查只匹配静态 from 语法，无法发现 import()、require() 或拼接动态导入。必须按确认契约覆盖并拒绝这些绕过形态，增加负向测试。
