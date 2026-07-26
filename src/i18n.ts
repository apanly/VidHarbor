export const LANGUAGES = ['zh-CN', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'zh-CN';
export const LANGUAGE_COOKIE_NAME = 'vidharbor_language';
export const I18N_ELEMENT_ID = 'vidharbor-i18n';

const zhCN = {
  'language.zh-CN': '中文',
  'language.en': 'English',
  'nav.main': '主导航',
  'nav.dashboard': '总览',
  'nav.downloads': '下载管理',
  'nav.channels': '频道管理',
  'nav.notifications': '提醒列表',
  'nav.authorizations': '授权管理',
  'nav.settings': '配置管理',
  'nav.database': '数据库管理',
  'nav.guide': '系统说明',
  'common.menu': '菜单',
  'common.close': '关闭',
  'common.closeMenu': '关闭菜单',
  'common.cancel': '取消',
  'common.save': '保存',
  'common.edit': '编辑',
  'common.delete': '删除',
  'common.retry': '重试',
  'common.preview': '预览',
  'common.download': '下载',
  'common.originalUrl': '原始地址',
  'common.direct': '直连',
  'common.none': '—',
  'common.loading': '加载中',
  'common.inProgress': '进行中',
  'common.failed': '失败',
  'common.optional': '可选',
  'common.required': '必填',
  'field.actions': '操作',
  'field.status': '状态',
  'field.type': '类型',
  'field.platform': '平台',
  'field.name': '名称',
  'field.createdAt': '创建时间',
  'field.startedAt': '开始时间',
  'field.finishedAt': '结束时间',
  'field.failureReason': '失败原因',
  'field.publishedDate': '发布日期',
  'field.duration': '时长',
  'field.fileSize': '文件大小',
  'field.storagePath': '存储路径',
  'field.network': '网络路径',
  'field.progress': '进度',
  'field.speed': '速度',
  'field.result': '结果',
  'field.video': '视频',
  'field.channel': '频道',
  'field.updatedAt': '更新时间',
  'page.dashboard.title': '总览',
  'page.downloads.title': '下载',
  'page.channels.title': '频道',
  'page.channelDetail.title': '频道详情',
  'page.notifications.title': '新视频提醒',
  'page.authorizations.title': '授权管理',
  'page.settings.title': '配置',
  'page.database.title': '数据库',
  'page.guide.title': '系统说明',
  'page.preview.title': '下载预览',
  'status.download.pending': '等待下载',
  'status.download.running': '运行中',
  'status.download.downloading': '运行中',
  'status.download.completed': '下载完成',
  'status.download.failed': '下载失败',
  'status.download.canceled': '已取消',
  'status.download.interrupted': '已中断',
  'status.download.deleting': '删除中',
  'status.task.queued': '排队中',
  'status.task.running': '运行中',
  'status.task.succeeded': '已成功',
  'status.task.failed': '已失败',
  'status.task.canceled': '已取消',
  'task.type.media_download': '媒体下载',
  'task.type.metadata_probe': '元数据探测',
  'task.type.channel_initial_sync': '频道首次同步',
  'task.type.channel_manual_check': '频道手动检查',
  'task.type.channel_scheduled_check': '频道定时检查',
  'status.sync.pending': '待首次同步',
  'status.sync.syncing': '首次同步中',
  'status.sync.failed': '首次同步失败',
  'status.sync.succeeded': '运行中',
  'status.channel.running': '运行中',
  'status.channel.paused': '已暂停',
  'status.check.success': '有更新',
  'status.check.no_updates': '无更新',
  'status.check.failed': '检查失败',
  'status.check.running': '进行中',
  'check.type.initial': '首次同步',
  'check.type.scheduled': '定时检查',
  'dashboard.activeTasks': '活动任务',
  'dashboard.finishedTasks': '最近已结束任务',
  'dashboard.noActiveTasks': '当前没有排队或运行中的任务。',
  'dashboard.noFinishedTasks': '当前没有已结束的任务。',
  'dashboard.summary': '未读提醒：{unread}；进行中下载：{running}；失败/中断下载：{failed}',
  'dashboard.noScheduledCheck': '尚无定时检查',
  'pagination.previous': '上一页',
  'pagination.next': '下一页',
  'pagination.pageLabel': '第 {page} 页',
  'pagination.summary': '第 {page} / {totalPages} 页 · 共 {totalItems} 条',
  'downloads.summary': '跟踪进行中的任务，查找并管理已经归档的内容。',
  'downloads.create': '新建直下载',
  'downloads.tab.completed': '已完成',
  'downloads.tab.active': '下载中',
  'downloads.tab.failed': '失败',
  'downloads.search': '搜索下载标题',
  'downloads.noTasks': '还没有下载任务',
  'downloads.noTasksHelp': '粘贴一个受支持的 HTTPS 地址，第一条任务会出现在这里。',
  'downloads.noSearchResults': '没有找到“{query}”',
  'downloads.noSearchResultsHelp': '试试更短的标题关键词，或清除当前搜索。',
  'downloads.clearSearch': '清除搜索',
  'downloads.noCompleted': '还没有完成的下载',
  'downloads.noCompletedHelp': '任务完成后会自动归档到这里。',
  'downloads.noFailed': '没有失败的下载',
  'downloads.noFailedHelp': '失败、取消和中断的任务会显示在这里。',
  'downloads.noActive': '当前没有下载中的任务',
  'downloads.noActiveHelp': '新任务和正在执行的任务会显示在这里。',
  'downloads.viewActive': '查看下载中',
  'downloads.cancel': '取消',
  'downloads.downloadFile': '下载文件',
  'downloads.deleteConfirm': '确认永久删除下载“{title}”及其文件？',
  'downloads.source.channel': '频道视频',
  'downloads.source.direct': '单视频',
  'downloads.totalDuration': '总时长',
  'downloads.elapsed': '总下载耗时',
  'downloads.directTitle': '单视频直下载',
  'downloads.source': '下载来源',
  'downloads.sourcePrompt': '粘贴一个公开单视频地址',
  'downloads.videoUrl': '视频地址',
  'downloads.urlHelp': '支持公开单视频 HTTPS 地址，不展开频道主页、列表或合集。',
  'downloads.urlRules': '查看平台地址规则',
  'downloads.urlRulesBeforeBilibiliPart': '当前官方范围包括 YouTube、Bilibili、X、Facebook 公开单视频或 Reel，以及抖音公开单视频；其他 HTTPS URL 仍按通用单资源契约探测，但不属于官方支持或验证范围。Bilibili 用',
  'downloads.urlRulesIndex': '序号',
  'downloads.urlRulesBetweenSelectors': '选择分 P，X 一帖多视频用',
  'downloads.urlRulesAfterXVideo': '选择。',
  'downloads.mediaType': '媒体类型',
  'downloads.mediaType.video': '视频',
  'downloads.mediaType.audio': '音频',
  'downloads.advanced': '高级选项',
  'downloads.advancedHelp': '质量、转码、字幕与时间裁剪',
  'downloads.mediaProcessing': '媒体处理',
  'downloads.quality': '最高分辨率',
  'downloads.unlimited': '不限制',
  'downloads.codec': '转码格式',
  'downloads.noTranscode': '不转码',
  'downloads.extra': '附加内容',
  'downloads.subtitles': '字幕',
  'downloads.subtitlesHelp': '保存视频提供的字幕文件',
  'downloads.timeRange': '时间裁剪',
  'downloads.timeStart': '起始时间',
  'downloads.timeEnd': '结束时间',
  'downloads.timeHelp': '起始时间和结束时间需要同时填写；全部留空则下载完整视频。',
  'downloads.start': '开始下载',
  'channels.create': '新增频道',
  'channels.subscription': '频道订阅',
  'channels.emptyTitle': '从一个频道开始',
  'channels.emptyHelp': '添加 YouTube 频道或 Bilibili UP 主空间，首次同步后即可集中查看视频，并按计划发现更新。',
  'channels.addFirst': '添加第一个频道',
  'channels.edit': '编辑频道',
  'channels.save': '保存频道配置',
  'channels.url': '频道地址',
  'channels.urlHelp': '支持 YouTube 频道和 Bilibili UP 主空间，例如',
  'channels.customName': '自定义名称',
  'channels.authorization': '授权配置',
  'channels.noAuthorization': '不使用授权',
  'channels.authorizationHelp': '仅可选择与频道相同平台的授权。',
  'channels.useAuthorization': '使用 {platform} 授权',
  'channels.interval': '频道覆盖间隔（分钟）',
  'channels.intervalPlaceholder': '留空使用全局值',
  'channels.initialSync': '首次同步',
  'channels.historyRange': '历史范围',
  'channels.historyMonths.1': '最近 1 个月',
  'channels.historyMonths.3': '最近 3 个月',
  'channels.historyMonths.6': '最近 6 个月',
  'channels.historyMonths.12': '最近 1 年',
  'channels.startSync': '开始同步',
  'channels.syncing': '同步中',
  'channels.checkNow': '立即检查',
  'channels.resync': '重新同步',
  'channels.pause': '暂停',
  'channels.resume': '恢复',
  'channels.open': '打开频道 {name}',
  'channels.deleteConfirm': '确认删除频道“{name}”？',
  'channels.authorizationField': '授权',
  'channels.checkInterval': '检查间隔',
  'channels.globalInterval': '{minutes} 分钟（全局）',
  'channels.overrideInterval': '{minutes} 分钟（频道覆盖）',
  'channels.unreadNotifications': '未读提醒',
  'channels.lastCheck': '最近检查',
  'channels.nextCheck': '下次检查',
  'channels.notPlanned': '未计划',
  'channelDetail.loading': '正在载入频道资料…',
  'channelDetail.videos': '视频列表',
  'channelDetail.checks': '检查记录',
  'channelDetail.filter': '筛选视频',
  'channelDetail.filterPlaceholder': '输入标题关键字',
  'channelDetail.selected': '已选择 {count} 个',
  'channelDetail.downloadSelected': '下载所选视频',
  'channelDetail.useChannelProxy': '沿用频道代理',
  'channelDetail.select': '选择',
  'channelDetail.selectVideo': '选择 {title}',
  'channelDetail.notDownloaded': '尚未下载',
  'channelDetail.durationUnknown': '时长未知',
  'channelDetail.openVideo': '打开视频',
  'channelDetail.noVideos': '当前范围内没有视频。',
  'channelDetail.noSearchResults': '没有找到“{query}”。',
  'channelDetail.noChecks': '尚无检查记录。',
  'channelDetail.summary': '{videos} 个视频 · {checks} 次检查',
  'channelDetail.selectAtLeastOne': '请至少选择一个视频',
  'notifications.summary': '这里展示频道后续检查发现的新视频。进入对应频道可选择是否下载。',
  'notifications.markAllRead': '全部标记已读',
  'notifications.markRead': '标记已读',
  'notifications.unread': '未读',
  'notifications.readAt': '已读：{time}',
  'notifications.empty': '暂无新视频提醒。',
  'authorizations.summary': '管理各平台的 Netscape Cookie 文件，每个平台最多保存一份。',
  'authorizations.create': '新增授权',
  'authorizations.edit': '编辑 {platform} 授权',
  'authorizations.scope': '使用范围',
  'authorizations.scopeHelp': '频道可选择同平台授权用于首次同步、手动检查和定时检查；直接下载、媒体下载及未选择授权的频道不会使用 Cookie。',
  'authorizations.configured': '已配置授权',
  'authorizations.replaceHelp': '编辑会完整替换原文件；删除会立即移除文件且无法恢复。',
  'authorizations.safety': '安全获取与导出说明',
  'authorizations.safetyExportBeforeLink': '只在可信设备上登录目标平台，可使用',
  'authorizations.safetyExportAfterLink': '从 Chrome/Edge 当前登录会话导出 Netscape 格式文件。',
  'authorizations.safetyUpload': '新增授权时选择平台并上传文件；编辑授权时重新上传完整文件。系统不会读取浏览器资料目录、代替你登录、转换其他授权格式或验证远端有效性。',
  'authorizations.safetyCredential': 'Cookie 等同账号登录凭据。不要通过聊天、工单、截图、日志或公开文件传递原文；不再需要或怀疑泄露时，请删除授权或重新导出后替换。',
  'authorizations.safetyConfiguredDisclaimer': '“已配置”仅表示文件已保存且格式正确，不代表登录态当前有效。',
  'authorizations.file': 'Netscape Cookie 文件',
  'authorizations.empty': '尚未添加授权。',
  'authorizations.status.configured': '已配置',
  'authorizations.deleteConfirm': '确认删除 {platform} 的 Cookie 配置？删除后无法恢复。',
  'settings.global': '全局设置',
  'settings.downloadRoot': '下载根目录',
  'settings.downloadRootHelp': '由部署配置固定，不能在此修改。',
  'settings.checkInterval': '全局检查间隔（分钟）',
  'settings.downloadConcurrency': '下载并发数',
  'settings.save': '保存设置',
  'settings.proxies': '代理',
  'settings.proxyHelp': '代理密码仅以脱敏形式展示；编辑时必须重新输入完整密码。',
  'settings.proxyCreate': '新增代理',
  'settings.proxyEdit': '编辑代理',
  'settings.proxyDelete': '删除代理',
  'settings.proxyEmpty': '尚未添加代理。',
  'settings.proxyDeleteConfirm': '确认删除代理“{name}”？',
  'settings.protocol': '协议',
  'settings.host': '主机',
  'settings.hostPlaceholder': '例如：192.168.1.100',
  'settings.port': '端口',
  'settings.portPlaceholder': '例如：1080',
  'settings.username': '用户名',
  'settings.password': '密码',
  'database.summary': '查看当前 SQLite 数据；查询仅支持只读 SQL。',
  'database.tables': '数据表',
  'database.readonlySql': '只读 SQL',
  'database.run': '执行查询',
  'database.prompt': '选择数据表或输入查询。',
  'database.resultSummary': '共 {rows} 行 · {columns} 列',
  'database.noData': '无数据',
  'guide.toc': '说明目录',
  'guide.quickNav': '快速导航',
  'preview.invalidId': '下载记录参数无效',
  'preview.notFound': '下载记录不存在',
  'preview.unavailable': '文件尚不可预览',
  'preview.playbackFailed': '浏览器无法播放此文件，请返回下载页面下载后查看',
  'error.VALIDATION_ERROR': '请求参数无效',
  'error.PROXY_NOT_FOUND': '代理不存在',
  'error.CHANNEL_NOT_FOUND': '频道不存在',
  'error.VIDEO_NOT_FOUND': '视频不存在',
  'error.NOTIFICATION_NOT_FOUND': '提醒不存在',
  'error.DOWNLOAD_NOT_FOUND': '下载记录不存在',
  'error.DOWNLOAD_FILE_UNAVAILABLE': '下载文件不可用',
  'error.DOWNLOAD_DELETE_FAILED': '删除下载文件失败',
  'error.DOWNLOAD_DELETE_IN_PROGRESS': '下载文件正在删除',
  'error.DOWNLOAD_RANGE_NOT_SATISFIABLE': '请求的文件范围无效',
  'error.PROXY_NAME_EXISTS': '代理名称已存在',
  'error.PROXY_IN_USE': '代理正在使用',
  'error.CHANNEL_ALREADY_EXISTS': '频道已存在',
  'error.CHANNEL_NAME_EXISTS': '频道名称已存在',
  'error.CHANNEL_IN_USE': '频道正在使用',
  'error.AUTHORIZATION_IN_USE': '授权配置正在使用',
  'error.DOWNLOAD_ALREADY_EXISTS': '该视频的下载已存在',
  'error.DOWNLOAD_ROOT_OUTSIDE_MOUNT': '下载根目录不在允许的挂载范围内',
  'error.DOWNLOAD_ROOT_UNAVAILABLE': '下载根目录不可用',
  'error.DOWNLOAD_ROOT_NOT_CONFIGURED': '未配置下载根目录',
  'error.UNSUPPORTED_PLATFORM': '不支持的平台',
  'error.NOT_A_CHANNEL_URL': '不是有效的频道地址',
  'error.NOT_A_VIDEO_URL': '不是有效的视频地址',
  'error.GLOBAL_INTERVAL_NOT_CONFIGURED': '未配置全局检查间隔',
  'error.CHANNEL_FETCH_FAILED': '获取频道失败',
  'error.CHANNEL_METADATA_INVALID': '频道元数据无效',
  'error.VIDEO_FETCH_FAILED': '获取视频失败',
  'error.VIDEO_METADATA_INVALID': '视频元数据无效',
  'error.PERSISTENCE_ERROR': '数据保存失败',
} as const;

export type TranslationKey = keyof typeof zhCN;
type Catalog = Readonly<Record<TranslationKey, string>>;

const en: Catalog = {
  'language.zh-CN': '中文', 'language.en': 'English', 'nav.main': 'Main navigation', 'nav.dashboard': 'Dashboard', 'nav.downloads': 'Downloads', 'nav.channels': 'Channels', 'nav.notifications': 'Notifications', 'nav.authorizations': 'Authorizations', 'nav.settings': 'Settings', 'nav.database': 'Database', 'nav.guide': 'Guide',
  'common.menu': 'Menu', 'common.close': 'Close', 'common.closeMenu': 'Close menu', 'common.cancel': 'Cancel', 'common.save': 'Save', 'common.edit': 'Edit', 'common.delete': 'Delete', 'common.retry': 'Retry', 'common.preview': 'Preview', 'common.download': 'Download', 'common.originalUrl': 'Original URL', 'common.direct': 'Direct', 'common.none': '—', 'common.loading': 'Loading', 'common.inProgress': 'In progress', 'common.failed': 'Failed', 'common.optional': 'Optional', 'common.required': 'Required',
  'field.actions': 'Actions', 'field.status': 'Status', 'field.type': 'Type', 'field.platform': 'Platform', 'field.name': 'Name', 'field.createdAt': 'Created at', 'field.startedAt': 'Started at', 'field.finishedAt': 'Finished at', 'field.failureReason': 'Failure reason', 'field.publishedDate': 'Published date', 'field.duration': 'Duration', 'field.fileSize': 'File size', 'field.storagePath': 'Storage path', 'field.network': 'Network route', 'field.progress': 'Progress', 'field.speed': 'Speed', 'field.result': 'Result', 'field.video': 'Video', 'field.channel': 'Channel', 'field.updatedAt': 'Updated at',
  'page.dashboard.title': 'Dashboard', 'page.downloads.title': 'Downloads', 'page.channels.title': 'Channels', 'page.channelDetail.title': 'Channel details', 'page.notifications.title': 'New video notifications', 'page.authorizations.title': 'Authorizations', 'page.settings.title': 'Settings', 'page.database.title': 'Database', 'page.guide.title': 'Guide', 'page.preview.title': 'Download preview',
  'status.download.pending': 'Waiting', 'status.download.running': 'Running', 'status.download.downloading': 'Running', 'status.download.completed': 'Completed', 'status.download.failed': 'Failed', 'status.download.canceled': 'Canceled', 'status.download.interrupted': 'Interrupted', 'status.download.deleting': 'Deleting',
  'status.task.queued': 'Queued', 'status.task.running': 'Running', 'status.task.succeeded': 'Succeeded', 'status.task.failed': 'Failed', 'status.task.canceled': 'Canceled',
  'task.type.media_download': 'Media download', 'task.type.metadata_probe': 'Metadata probe', 'task.type.channel_initial_sync': 'Initial channel sync', 'task.type.channel_manual_check': 'Manual channel check', 'task.type.channel_scheduled_check': 'Scheduled channel check',
  'status.sync.pending': 'Awaiting initial sync', 'status.sync.syncing': 'Initial sync in progress', 'status.sync.failed': 'Initial sync failed', 'status.sync.succeeded': 'Running', 'status.channel.running': 'Running', 'status.channel.paused': 'Paused', 'status.check.success': 'Updates found', 'status.check.no_updates': 'No updates', 'status.check.failed': 'Check failed', 'status.check.running': 'In progress', 'check.type.initial': 'Initial sync', 'check.type.scheduled': 'Scheduled check',
  'dashboard.activeTasks': 'Active tasks', 'dashboard.finishedTasks': 'Recently finished tasks', 'dashboard.noActiveTasks': 'There are no queued or running tasks.', 'dashboard.noFinishedTasks': 'There are no finished tasks.', 'dashboard.summary': 'Unread notifications: {unread}; active downloads: {running}; failed/interrupted downloads: {failed}', 'dashboard.noScheduledCheck': 'No scheduled check yet',
  'pagination.previous': 'Previous', 'pagination.next': 'Next', 'pagination.pageLabel': 'Page {page}', 'pagination.summary': 'Page {page} / {totalPages} · {totalItems} items',
  'downloads.summary': 'Track active tasks and find and manage archived content.', 'downloads.create': 'New direct download', 'downloads.tab.completed': 'Completed', 'downloads.tab.active': 'Active', 'downloads.tab.failed': 'Failed', 'downloads.search': 'Search download titles', 'downloads.noTasks': 'No download tasks yet', 'downloads.noTasksHelp': 'Paste a supported HTTPS URL and the first task will appear here.', 'downloads.noSearchResults': 'No results for “{query}”', 'downloads.noSearchResultsHelp': 'Try a shorter title keyword or clear the current search.', 'downloads.clearSearch': 'Clear search', 'downloads.noCompleted': 'No completed downloads yet', 'downloads.noCompletedHelp': 'Completed tasks are archived here automatically.', 'downloads.noFailed': 'No failed downloads', 'downloads.noFailedHelp': 'Failed, canceled, and interrupted tasks appear here.', 'downloads.noActive': 'No active downloads', 'downloads.noActiveHelp': 'New and running tasks appear here.', 'downloads.viewActive': 'View active downloads', 'downloads.cancel': 'Cancel', 'downloads.downloadFile': 'Download file', 'downloads.deleteConfirm': 'Permanently delete “{title}” and its files?', 'downloads.source.channel': 'Channel video', 'downloads.source.direct': 'Single video', 'downloads.totalDuration': 'Total duration', 'downloads.elapsed': 'Total download time', 'downloads.directTitle': 'Direct single-video download', 'downloads.source': 'Download source', 'downloads.sourcePrompt': 'Paste a public single-video URL', 'downloads.videoUrl': 'Video URL', 'downloads.urlHelp': 'Supports public single-video HTTPS URLs; channel pages, lists, and collections are not expanded.', 'downloads.urlRules': 'View platform URL rules', 'downloads.urlRulesBeforeBilibiliPart': 'The current official scope includes public single-video or Reel URLs from YouTube, Bilibili, X, and Facebook, plus public single-video URLs from Douyin. Other HTTPS URLs are still probed under the generic single-resource contract, but are not officially supported or verified. Use', 'downloads.urlRulesIndex': 'number', 'downloads.urlRulesBetweenSelectors': 'to select a Bilibili part and', 'downloads.urlRulesAfterXVideo': 'to select one video from an X post with multiple videos.', 'downloads.mediaType': 'Media type', 'downloads.mediaType.video': 'Video', 'downloads.mediaType.audio': 'Audio', 'downloads.advanced': 'Advanced options', 'downloads.advancedHelp': 'Quality, transcoding, subtitles, and time trimming', 'downloads.mediaProcessing': 'Media processing', 'downloads.quality': 'Maximum resolution', 'downloads.unlimited': 'No limit', 'downloads.codec': 'Transcode format', 'downloads.noTranscode': 'Do not transcode', 'downloads.extra': 'Additional content', 'downloads.subtitles': 'Subtitles', 'downloads.subtitlesHelp': 'Save subtitle files provided by the video', 'downloads.timeRange': 'Time range', 'downloads.timeStart': 'Start time', 'downloads.timeEnd': 'End time', 'downloads.timeHelp': 'Start and end time must be supplied together; leave both blank to download the complete video.', 'downloads.start': 'Start download',
  'channels.create': 'Add channel', 'channels.subscription': 'Channel subscriptions', 'channels.emptyTitle': 'Start with a channel', 'channels.emptyHelp': 'Add a YouTube channel or Bilibili creator page to browse videos after the initial sync and discover updates on schedule.', 'channels.addFirst': 'Add the first channel', 'channels.edit': 'Edit channel', 'channels.save': 'Save channel settings', 'channels.url': 'Channel URL', 'channels.urlHelp': 'Supports YouTube channels and Bilibili creator pages, for example', 'channels.customName': 'Custom name', 'channels.authorization': 'Authorization', 'channels.noAuthorization': 'Do not use authorization', 'channels.authorizationHelp': 'Only authorizations for the same platform as the channel are available.', 'channels.useAuthorization': 'Use {platform} authorization', 'channels.interval': 'Channel override interval (minutes)', 'channels.intervalPlaceholder': 'Leave blank to use the global value', 'channels.initialSync': 'Initial sync', 'channels.historyRange': 'History range', 'channels.historyMonths.1': 'Last month', 'channels.historyMonths.3': 'Last 3 months', 'channels.historyMonths.6': 'Last 6 months', 'channels.historyMonths.12': 'Last year', 'channels.startSync': 'Start sync', 'channels.syncing': 'Syncing', 'channels.checkNow': 'Check now', 'channels.resync': 'Sync again', 'channels.pause': 'Pause', 'channels.resume': 'Resume', 'channels.open': 'Open channel {name}', 'channels.deleteConfirm': 'Delete channel “{name}”?', 'channels.authorizationField': 'Authorization', 'channels.checkInterval': 'Check interval', 'channels.globalInterval': '{minutes} minutes (global)', 'channels.overrideInterval': '{minutes} minutes (channel override)', 'channels.unreadNotifications': 'Unread notifications', 'channels.lastCheck': 'Latest check', 'channels.nextCheck': 'Next check', 'channels.notPlanned': 'Not scheduled',
  'channelDetail.loading': 'Loading channel details…', 'channelDetail.videos': 'Videos', 'channelDetail.checks': 'Check history', 'channelDetail.filter': 'Filter videos', 'channelDetail.filterPlaceholder': 'Enter title keywords', 'channelDetail.selected': '{count} selected', 'channelDetail.downloadSelected': 'Download selected videos', 'channelDetail.useChannelProxy': 'Use channel proxy', 'channelDetail.select': 'Select', 'channelDetail.selectVideo': 'Select {title}', 'channelDetail.notDownloaded': 'Not downloaded', 'channelDetail.durationUnknown': 'Unknown duration', 'channelDetail.openVideo': 'Open video', 'channelDetail.noVideos': 'There are no videos in the current range.', 'channelDetail.noSearchResults': 'No results for “{query}”.', 'channelDetail.noChecks': 'No check history yet.', 'channelDetail.summary': '{videos} videos · {checks} checks', 'channelDetail.selectAtLeastOne': 'Select at least one video',
  'notifications.summary': 'New videos found by subsequent channel checks appear here. Open the channel to choose whether to download them.', 'notifications.markAllRead': 'Mark all as read', 'notifications.markRead': 'Mark as read', 'notifications.unread': 'Unread', 'notifications.readAt': 'Read: {time}', 'notifications.empty': 'No new video notifications.',
  'authorizations.summary': 'Manage one Netscape Cookie file for each platform.', 'authorizations.create': 'Add authorization', 'authorizations.edit': 'Edit {platform} authorization', 'authorizations.scope': 'Usage scope', 'authorizations.scopeHelp': 'Channels may use same-platform authorization for initial syncs and manual or scheduled checks. Direct and media downloads, and channels without authorization, do not use Cookie files.', 'authorizations.configured': 'Configured authorizations', 'authorizations.replaceHelp': 'Editing replaces the complete file; deleting removes it immediately and cannot be undone.', 'authorizations.safety': 'Safe export instructions', 'authorizations.safetyExportBeforeLink': 'Sign in to the target platform only on a trusted device. You may use', 'authorizations.safetyExportAfterLink': 'to export a Netscape-format file from the current Chrome/Edge signed-in session.', 'authorizations.safetyUpload': 'Choose a platform and upload a file when adding an authorization; upload the complete file again when editing. The system does not read browser profile directories, sign in on your behalf, convert other authorization formats, or validate the authorization remotely.', 'authorizations.safetyCredential': 'Cookie data is equivalent to account sign-in credentials. Do not share its contents through chats, issues, screenshots, logs, or public files. Delete the authorization when it is no longer needed, or replace it with a fresh export if exposure is suspected.', 'authorizations.safetyConfiguredDisclaimer': '“Configured” only means the file was saved and its format is valid; it does not mean the sign-in session remains valid.', 'authorizations.file': 'Netscape Cookie file', 'authorizations.empty': 'No authorization added.', 'authorizations.status.configured': 'Configured', 'authorizations.deleteConfirm': 'Delete the Cookie configuration for {platform}? This cannot be undone.',
  'settings.global': 'Global settings', 'settings.downloadRoot': 'Download root', 'settings.downloadRootHelp': 'Fixed by deployment configuration and cannot be changed here.', 'settings.checkInterval': 'Global check interval (minutes)', 'settings.downloadConcurrency': 'Download concurrency', 'settings.save': 'Save settings', 'settings.proxies': 'Proxies', 'settings.proxyHelp': 'Proxy passwords are shown only in redacted form; enter the complete password again when editing.', 'settings.proxyCreate': 'Add proxy', 'settings.proxyEdit': 'Edit proxy', 'settings.proxyDelete': 'Delete proxy', 'settings.proxyEmpty': 'No proxy added.', 'settings.proxyDeleteConfirm': 'Delete proxy “{name}”?', 'settings.protocol': 'Protocol', 'settings.host': 'Host', 'settings.hostPlaceholder': 'For example: 192.168.1.100', 'settings.port': 'Port', 'settings.portPlaceholder': 'For example: 1080', 'settings.username': 'Username', 'settings.password': 'Password',
  'database.summary': 'Browse current SQLite data; only read-only SQL queries are supported.', 'database.tables': 'Tables', 'database.readonlySql': 'Read-only SQL', 'database.run': 'Run query', 'database.prompt': 'Select a table or enter a query.', 'database.resultSummary': '{rows} rows · {columns} columns', 'database.noData': 'No data', 'guide.toc': 'Guide contents', 'guide.quickNav': 'Quick navigation',
  'preview.invalidId': 'Invalid download ID', 'preview.notFound': 'Download not found', 'preview.unavailable': 'File is not available for preview', 'preview.playbackFailed': 'The browser cannot play this file. Return to Downloads and download it instead.',
  'error.VALIDATION_ERROR': 'Invalid request parameters', 'error.PROXY_NOT_FOUND': 'Proxy not found', 'error.CHANNEL_NOT_FOUND': 'Channel not found', 'error.VIDEO_NOT_FOUND': 'Video not found', 'error.NOTIFICATION_NOT_FOUND': 'Notification not found', 'error.DOWNLOAD_NOT_FOUND': 'Download not found', 'error.DOWNLOAD_FILE_UNAVAILABLE': 'Download file unavailable', 'error.DOWNLOAD_DELETE_FAILED': 'Failed to delete download files', 'error.DOWNLOAD_DELETE_IN_PROGRESS': 'Download files are being deleted', 'error.DOWNLOAD_RANGE_NOT_SATISFIABLE': 'Invalid file range', 'error.PROXY_NAME_EXISTS': 'Proxy name already exists', 'error.PROXY_IN_USE': 'Proxy is in use', 'error.CHANNEL_ALREADY_EXISTS': 'Channel already exists', 'error.CHANNEL_NAME_EXISTS': 'Channel name already exists', 'error.CHANNEL_IN_USE': 'Channel is in use', 'error.AUTHORIZATION_IN_USE': 'Authorization is in use', 'error.DOWNLOAD_ALREADY_EXISTS': 'A download for this video already exists', 'error.DOWNLOAD_ROOT_OUTSIDE_MOUNT': 'Download root is outside the allowed mount', 'error.DOWNLOAD_ROOT_UNAVAILABLE': 'Download root is unavailable', 'error.DOWNLOAD_ROOT_NOT_CONFIGURED': 'Download root is not configured', 'error.UNSUPPORTED_PLATFORM': 'Unsupported platform', 'error.NOT_A_CHANNEL_URL': 'Invalid channel URL', 'error.NOT_A_VIDEO_URL': 'Invalid video URL', 'error.GLOBAL_INTERVAL_NOT_CONFIGURED': 'Global check interval is not configured', 'error.CHANNEL_FETCH_FAILED': 'Failed to fetch channel', 'error.CHANNEL_METADATA_INVALID': 'Invalid channel metadata', 'error.VIDEO_FETCH_FAILED': 'Failed to fetch video', 'error.VIDEO_METADATA_INVALID': 'Invalid video metadata', 'error.PERSISTENCE_ERROR': 'Failed to save data',
};

export const TRANSLATIONS: Readonly<Record<Language, Catalog>> = {
  'zh-CN': zhCN,
  en,
};

export type TranslationParams = Readonly<Record<string, string | number>>;

export function validateCatalogs(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('translation catalogs must be an object');
  }
  const catalogs = value as Record<string, unknown>;
  const languages = Object.keys(catalogs);
  if (languages.length !== LANGUAGES.length || LANGUAGES.some((language) => !Object.hasOwn(catalogs, language))) {
    throw new TypeError('translation catalogs must contain exactly zh-CN and en');
  }
  const base = validateCatalog(catalogs['zh-CN'], 'zh-CN');
  const english = validateCatalog(catalogs.en, 'en');
  if (base.length !== english.length || base.some((key, index) => key !== english[index])) {
    throw new TypeError('translation catalog keys must match');
  }
}

function validateCatalog(value: unknown, language: Language): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${language} translation catalog must be a flat object`);
  }
  const entries = Object.entries(value);
  for (const [key, translation] of entries) {
    if (key === '' || typeof translation !== 'string' || translation.trim() === '') {
      throw new TypeError(`${language} translation ${key || '<empty>'} must be a non-empty string`);
    }
  }
  return entries.map(([key]) => key).sort();
}

export function selectLanguage(cookieHeader: string | undefined): Language {
  if (cookieHeader === undefined) return DEFAULT_LANGUAGE;
  for (const part of cookieHeader.split(';')) {
    const cookie = part.trim();
    const separator = cookie.indexOf('=');
    if (separator === -1 || cookie.slice(0, separator) !== LANGUAGE_COOKIE_NAME) continue;
    const value = cookie.slice(separator + 1);
    return value === 'zh-CN' || value === 'en' ? value : DEFAULT_LANGUAGE;
  }
  return DEFAULT_LANGUAGE;
}

export function getCatalog(language: Language): Catalog {
  if (!LANGUAGES.includes(language)) throw new TypeError(`unknown language: ${String(language)}`);
  return TRANSLATIONS[language];
}

export function t(language: Language, key: TranslationKey, params?: TranslationParams): string {
  const catalog = getCatalog(language);
  if (!Object.hasOwn(catalog, key)) throw new TypeError(`unknown translation key: ${String(key)}`);
  return interpolate(catalog[key], params);
}

export function createTranslator(language: Language): (key: TranslationKey, params?: TranslationParams) => string {
  getCatalog(language);
  return (key, params) => t(language, key, params);
}

function interpolate(template: string, params?: TranslationParams): string {
  const placeholders = [...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1] as string);
  const expected = new Set(placeholders);
  const supplied = Object.keys(params ?? {});
  if (expected.size !== supplied.length || supplied.some((name) => !expected.has(name))) {
    throw new TypeError(`translation parameters must be exactly: ${[...expected].join(', ')}`);
  }
  return template.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => String(params?.[name]));
}

export function safeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('value is not JSON serializable');
  return json.replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

export function serializeI18n(language: Language): string {
  return safeJson({ language, translations: getCatalog(language) });
}

validateCatalogs(TRANSLATIONS);
