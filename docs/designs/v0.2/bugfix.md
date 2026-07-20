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

## bugfix-14 · worker 正常取消必须抛类型化错误

- 关联 task: task-25
- 描述: review-3 在 src/download-worker.ts:281 发现 worker 主动取消及底层正常中止仍抛普通 Error，导致正常取消被管理器记为 failed。必须统一为 YtDlpTaskCancellationError，真实终止错误保持原异常。

## bugfix-15 · 下载记录状态必须按错误类型收敛

- 关联 task: task-25
- 描述: review-3 在 src/download-worker.ts:530 发现 catch 仅凭 signal.aborted 写 canceled，会把 kill、回滚、清理和持久化故障伪装为取消。只有类型化正常取消写 canceled，其余写 failed 并上报。

## bugfix-16 · 缩略图目录清理错误不得吞掉

- 关联 task: task-25
- 描述: review-3 在 src/download-worker.ts:276 发现 finally 无条件吞掉缩略图目录 rm 异常。普通缩略图下载失败仍可忽略，但清理失败必须保留 rejection 并进入系统故障边界。

## bugfix-17 · 排队媒体取消必须持久化 canceled

- 关联 task: task-26
- 描述: review-3 在 src/download-worker.ts:321 发现 execute 前取消的排队媒体任务不会运行 #run，数据库记录残留 pending。worker 观察到类型化排队取消时必须原子更新 pending 为 canceled，持久化失败上报。

## bugfix-18 · 底层正常进程取消必须保留类型身份

- 关联 task: task-24
- 描述: review-3 在 src/server.ts:290 发现 yt-dlp 正常中止在底层被重构为普通 Error，运行中下载停机使 manager.stop 拒绝。必须跨进程边界保留可识别取消类型，真实 kill 等错误不转换。

## bugfix-19 · 频道服务不得重写类型化取消

- 关联 task: task-27
- 描述: review-3 在 src/services/channel.ts:981 发现频道抓取和元数据 catch 将取消重写为 BusinessError，导致 runtime/scheduler 排除分支失效。记录既有频道失败状态后应重抛原取消类型；记录失败则抛 PERSISTENCE_ERROR。

## bugfix-20 · 停机排队下载不得残留 pending

- 关联 task: task-26
- 描述: review-3 在 src/server.ts:290 发现 manager.stop 直接取消排队媒体任务后数据库仍为 pending。停机后排队和运行下载都必须收敛为 canceled。

## bugfix-21 · yt-dlp 底层取消必须返回共享类型

- 关联 task: task-24
- 描述: review-3 在 src/yt-dlp.ts:239 发现真实 operation 取消返回普通 Error，manager.cancel 将任务标为 failed。底层固定协议必须返回管理器可识别的共享取消类型，并用真实 operation 集成测试证明。

## bugfix-22 · stop 必须等待全部取消任务 settled

- 关联 task: task-28
- 描述: review-3 在 src/yt-dlp-task-manager.ts:279 发现 Promise.all 在首个取消失败后立即拒绝，其他任务仍可能 running。stop 必须先等待全部 cancel settled，再聚合抛错。

## bugfix-23 · 取消不得掩盖 yt-dlp 启动失败

- 关联 task: task-24
- 描述: review-3 在 src/yt-dlp.ts:239 发现 signal 已取消且 executable ENOENT 时先返回取消。spawnError 必须优先保留并增加预取消叠加启动失败测试。

## bugfix-24 · 频道停机测试不得固化失败行为

- 关联 task: task-27
- 描述: review-3 在 test/integration/channel-notification-api.test.ts:439 发现测试期待 stop 以 CHANNEL_FETCH_FAILED 拒绝并将任务记 failed，与正常取消契约冲突。应断言 stop 成功、快照 canceled 且使用类型判断。

## bugfix-25 · 唯一入口扫描必须解析动态路径表达式

- 关联 task: task-29
- 描述: review-3 在 test/integration/pages.test.ts:169 发现扫描未解码转义字面量，也不分析模板插值和变量拼接。必须使用受限常量求值或 TypeScript parser 拒绝这些绕过方式。

## bugfix-26 · 进程树退出测试必须有界轮询 PID 消失

- 关联 task: task-24
- 描述: review-3 在 test/integration/yt-dlp.test.ts:51 发现 close 后立即 kill(pid,0) 会因僵尸回收时序随机失败。应有界轮询 ESRCH，超时才失败。

## bugfix-27 · 页面错误测试必须使用固定错误契约

- 关联 task: task-29
- 描述: review-3 在 test/integration/pages.test.ts:823 发现页面测试伪造 503/TASK_SNAPSHOT_FAILED。必须改为固定 500/PERSISTENCE_ERROR 并断言最终 DOM。
