import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiRouter, createApp } from '../../src/app.js';
import { RuntimeCoordinator } from '../../src/runtime.js';
import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { formatFailureReason } from '../../src/redaction.js';
import type { DownloadQueue } from '../../src/services/download.js';
import {
  YtDlpTaskManager,
  type YtDlpTaskSnapshot,
} from '../../src/yt-dlp-task-manager.js';

const credentialedProxyUrl = 'http://alice:secret@proxy.example:8080';

let sandbox: string;
let database: DatabaseConnection;
let baseUrl: string;
let stopServer: (() => Promise<void>) | undefined;
let taskManager: YtDlpTaskManager;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-pages-'));
  const downloadsMountPath = join(sandbox, 'downloads');
  await mkdir(downloadsMountPath);
  database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
  migrateDatabase(database);

  taskManager = new YtDlpTaskManager(
    join(sandbox, 'yt-dlp'),
    1,
    (message) => formatFailureReason(message, [credentialedProxyUrl]),
  );
  const queue: DownloadQueue = {
    enqueue: () => undefined,
    cancel: async () => undefined,
  };
  const app = createApp(
    createApiRouter(
      database,
      downloadsMountPath,
      new RuntimeCoordinator(() => undefined),
      taskManager,
      queue,
    ),
  );
  app.set('views', new URL('../../src/views', import.meta.url).pathname);
  app.set('view engine', 'ejs');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  stopServer = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
});

afterEach(async () => {
  await stopServer?.();
  await taskManager.stop();
  database.close();
  await rm(sandbox, { recursive: true, force: true });
});

async function getPage(path: string): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  return response.text();
}

function getPublicScript(name: string): Promise<string> {
  return readFile(join(process.cwd(), 'src/public', name), 'utf8');
}

async function schedulingTurn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

interface FakeTaskNode {
  className: string;
  textContent: string;
  hidden: boolean;
  readonly dataset: Record<string, string>;
  readonly children: FakeTaskNode[];
  append(...children: FakeTaskNode[]): void;
}

function fakeTaskNode(): FakeTaskNode {
  return {
    className: '',
    textContent: '',
    hidden: false,
    dataset: {},
    children: [],
    append(...children) {
      this.children.push(...children);
    },
  };
}

function taskNodeText(node: FakeTaskNode): string {
  return [node.textContent, ...node.children.map(taskNodeText)].join(' ');
}

function taskPageHelpers(script: string): {
  readonly nodes: ReadonlyMap<string, FakeTaskNode>;
  readonly taskRow: (task: YtDlpTaskSnapshot) => FakeTaskNode;
  readonly renderGroup: (
    tasks: readonly YtDlpTaskSnapshot[],
    listId: string,
    emptyId: string,
    countId: string,
  ) => void;
} {
  const ids = [
    'page-error',
    'active-task-list',
    'active-task-empty',
    'active-task-count',
    'terminal-task-list',
    'terminal-task-empty',
    'terminal-task-count',
  ];
  const nodes = new Map(ids.map((id) => [id, fakeTaskNode()]));
  const fakeDocument = {
    createElement: () => fakeTaskNode(),
    querySelector: (selector: string) => nodes.get(selector.slice(1)),
  };
  const executableSource = script.slice(
    script.indexOf('const taskTypeLabels'),
    script.indexOf('\nload().catch'),
  );
  const helpers = new Function(
    'document',
    'formatChinaTimestamp',
    `${executableSource}; return { taskRow, renderGroup };`,
  )(
    fakeDocument,
    (value: string) => value,
  ) as {
    taskRow: (task: YtDlpTaskSnapshot) => FakeTaskNode;
    renderGroup: (
      tasks: readonly YtDlpTaskSnapshot[],
      listId: string,
      emptyId: string,
      countId: string,
    ) => void;
  };
  return { nodes, ...helpers };
}

async function typeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

describe('server-rendered pages', () => {
  it.each([
    ['/', '<h1 class="mb-4">总览</h1>'],
    ['/settings', '<h1>配置</h1>'],
    ['/channels', '<h1>频道</h1>'],
    ['/channels/7', '频道详情'],
    ['/notifications', '新视频提醒'],
    ['/downloads', '<h1>下载</h1>'],
    ['/yt-dlp-tasks', '<h1>任务状态</h1>'],
    ['/guide', '<h1>VidHarbor</h1>'],
  ] as const)('renders %s with the shared page shell', async (path, marker) => {
    const html = await getPage(path);

    expect(html).toContain(marker);
    expect(html).toContain('class="app-shell"');
    expect(html).toContain('class="sidebar-nav"');
    expect(html).toContain('data-bs-toggle="offcanvas"');
    expect(html).toContain('href="/">总览</a>');
    expect(html).toContain('href="/settings">配置</a>');
    expect(html).toContain('href="/channels">频道</a>');
    expect(html).toContain('href="/notifications">提醒</a>');
    expect(html).toContain('href="/downloads">下载</a>');
    expect(html).toContain('href="/yt-dlp-tasks">任务状态</a>');
    expect(html).toContain('href="/guide">说明</a>');
    expect(html).toMatch(/href="\/">总览<\/a>[\s\S]*href="\/downloads">下载<\/a>[\s\S]*href="\/yt-dlp-tasks">任务状态<\/a>[\s\S]*href="\/channels">频道<\/a>[\s\S]*href="\/notifications">提醒<\/a>[\s\S]*href="\/settings">配置<\/a>[\s\S]*href="\/guide">说明<\/a>/);
    expect(html).not.toContain('navbar-nav flex-row');
    expect(html).not.toContain('deployment-warning');
    expect(html).not.toContain('切勿直接暴露到公网');
    expect(html).not.toContain('可信内网视频管理');
    expect(html).not.toContain('class="eyebrow');
    expect(html).not.toContain('class="app-footer"');
  });

  it('explains the complete current project contract on the guide page', async () => {
    const html = await getPage('/guide');
    const script = await getPublicScript('guide.js');
    const guideTemplate = await readFile(join(process.cwd(), 'src/views/guide.ejs'), 'utf8');
    const dockerfile = await readFile(join(process.cwd(), 'Dockerfile'), 'utf8');

    expect(html).toContain('只能部署在可信内网');
    expect(html).toContain('最近 1、3、6 或 12 个月');
    expect(html).toContain('固定为检查开始时间之前最近 1 个自然月');
    expect(html).toContain('YouTube、Bilibili、Vimeo、X');
    expect(html).toContain('Facebook 公开单视频或 Reel');
    expect(html).toContain('抖音公开单视频地址可提交');
    expect(html).toContain('space.bilibili.com/&lt;数字UID&gt;');
    expect(html).toContain('&lt;下载根目录&gt;/&lt;下载ID&gt;/');
    expect(html).toContain('主媒体文件成功并通过校验，任务就算成功');
    expect(html).toContain('当前不提供');
    expect(html).toContain('class="sidebar-link sidebar-guide-link active" href="/guide">说明</a>');
    expect(html).toContain('id="guide-content" class="guide-markdown"');
    expect(html).toContain('<script src="/public/guide.js"></script>');
    expect(script).toContain("document.querySelectorAll('#guide-content h2')");
    expect(html).toContain('<strong>成功条件：</strong>');
    expect(guideTemplate).toContain('<%- guideHtml %>');
    expect(guideTemplate).not.toContain('主媒体文件成功并通过校验');
    expect(dockerfile).toContain('COPY README.md ./');
    expect(dockerfile).toContain('/app/README.md ./README.md');
  });

  it('renders add and edit forms in dialogs with single-column fields', async () => {
    const channelsHtml = await getPage('/channels');
    const settingsHtml = await getPage('/settings');
    const channelsScript = await getPublicScript('channels.js');
    const settingsScript = await getPublicScript('settings.js');
    const paginationScript = await getPublicScript('pagination.js');

    expect(channelsHtml).toContain('data-bs-target="#channel-modal"');
    expect(channelsHtml).toContain('id="channel-modal"');
    expect(channelsHtml).toContain('id="channel-modal-title"');
    expect(channelsHtml).toContain('id="channel-form"');
    expect(channelsHtml).toContain('支持 YouTube 频道和 Bilibili UP 主空间');
    expect(channelsScript).toContain("bilibili: 'Bilibili'");
    expect(channelsScript).toContain('openChannelCreateModal()');
    expect(channelsScript).toContain('openChannelEditModal(channel)');
    expect(channelsHtml).toContain('>新增频道</button>');
    expect(channelsHtml).not.toContain('已添加频道');
    expect(channelsHtml).toContain('id="channel-list" class="row row-cols-1 row-cols-md-2 row-cols-xl-3 g-4"');
    expect(channelsScript).toContain("card.className = 'card h-100 channel-card'");
    expect(channelsScript).toContain("card.setAttribute('role', 'link')");
    expect(channelsScript).toContain("window.open(`/channels/${channel.id}`, '_blank', 'noopener')");
    expect(channelsScript).toContain("event.target.closest('a, button, input, select, textarea, label')");
    expect(channelsScript).toContain("link.target = '_blank'; link.rel = 'noopener'");
    expect(channelsScript).toContain('confirm(`确认删除频道「${channel.customName}」？`)');
    expect(channelsScript).toContain("request(`/api/channels/${channel.id}`, 'DELETE')");
    expect(paginationScript).toContain('container.hidden = value.totalItems === 0');
    expect(channelsScript).toContain('formatChinaTimestamp(channel.lastCheck.nextAt)');
    expect(channelsHtml).not.toContain('<table');
    expect(channelsHtml).toContain('class="form-stack"');
    expect(channelsHtml).not.toContain('data-channel-edit-modal-root');
    expect(channelsHtml).not.toContain('buildChannelEditModal');
    expect(channelsHtml).not.toContain('channel-create-modal');
    expect(channelsHtml).not.toContain('id="channel-create-form" class="row g-3"');
    expect(channelsHtml).not.toContain('新增并同步');
    expect(channelsHtml).toContain('id="initial-sync-modal"');
    expect(channelsHtml).toContain('<option value="1">最近 1 个月</option>');
    expect(channelsHtml).toContain('<option value="12">最近 1 年</option>');
    expect(channelsScript).toContain("request(`/api/channels/${initialSyncChannelId}/initial-sync`, 'POST'");
    expect(channelsScript).toContain("submit.textContent = '同步中'");

    expect(settingsHtml).toContain('data-bs-target="#proxy-modal"');
    expect(settingsHtml).toContain('id="proxy-modal"');
    expect(settingsHtml).toContain('id="proxy-modal-title"');
    expect(settingsHtml).toContain('id="proxy-form"');
    expect(settingsScript).toContain('openProxyCreateModal()');
    expect(settingsScript).toContain('openProxyEditModal(proxy)');
    expect(settingsHtml).toContain('class="proxy-modal-form"');
    expect(settingsHtml).not.toContain('data-proxy-edit-modal-root');
    expect(settingsHtml).not.toContain('buildProxyEditModal');
    expect(settingsHtml).not.toContain('proxy-create-modal');
    expect(settingsHtml).not.toContain('id="proxy-create-form" class="row g-3');
  });

  it('submits only explicitly selected channel videos', async () => {
    const html = await getPage('/channels/7');
    const script = await getPublicScript('channel-detail.js');

    expect(html).toContain('id="download-form"');
    expect(html).toContain('role="tablist" aria-label="频道详情"');
    expect(html).toContain('data-channel-tab="videos">视频列表</button>');
    expect(html).toContain('data-channel-tab="checks">检查记录</button>');
    expect(html).toContain('data-channel-panel="videos"');
    expect(html).toContain('data-channel-panel="checks" hidden');
    expect(html).toMatch(/class="channel-proxy-field"[\s\S]*class="channel-filter-field"[\s\S]*class="channel-selection-action"/);
    expect(html).toContain('id="video-list"');
    expect(html).toContain('id="check-list"');
    expect(html).toContain('class="table channel-detail-table channel-check-table align-middle mb-0"');
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html).not.toContain('返回频道');
    expect(html).not.toContain('channel-back-link');
    expect(html).toContain('data-channel-id="7"');
    expect(script).toContain("const row = document.createElement('tr')");
    expect(script).toContain('setChannelTab(button.dataset.channelTab)');
    expect(script).toContain("pending: '等待下载'");
    expect(script).toContain("completed: '下载完成'");
    expect(script).toContain("interrupted: '已中断'");
    expect(script).toContain("video.downloadStatus === null ? '尚未下载' : downloadStatusLabels[video.downloadStatus]");
    expect(script).toContain("video.downloadStatus === 'completed'");
    expect(script).toContain('formatBytes(video.downloadOutputSizeBytes)');
    expect(script).toContain('formatCompletedAt(video.downloadFinishedAt)');
    expect(script).toContain('`/downloads/preview?id=${video.downloadId}`');
    expect(script).toContain('`/api/downloads/${video.downloadId}/file`');
    expect(script).toContain('video.downloadFailureReason');
    expect(html).toContain('name="proxyId"');
    expect(html).toContain('<option value="channel">沿用频道代理</option>');
    expect(script).toContain("request('/api/proxies')");
    expect(script).toContain("checkbox.name = 'videoIds'");
    expect(script).toContain(
      "form.querySelectorAll('input[name=\"videoIds\"]:checked')",
    );
    expect(script).toContain(
      "request('/api/downloads/channel', 'POST', { videoIds, proxyId: channelProxyId() })",
    );
    expect(html).not.toMatch(/自动选择|自动下载|删除频道|手动检查/);
  });

  it('renders notifications as a table with channel, video, and read actions', async () => {
    const html = await getPage('/notifications');
    const script = await getPublicScript('notifications.js');

    expect(script).toContain('request(`/api/notifications?page=${requestedPage}`)');
    expect(html).toContain('<table class="table channel-detail-table notification-table align-middle mb-0">');
    expect(html).toContain('<th scope="col">视频</th><th scope="col">频道</th><th scope="col">发布日期</th><th scope="col">发现时间</th><th scope="col">状态</th><th scope="col">操作</th>');
    expect(script).toContain("const row = document.createElement('tr')");
    expect(script).toContain("row.append(videoCell, channelCell, publishedCell, createdCell, stateCell, actionCell)");
    expect(script).toContain('`/channels/${notification.channel.id}`');
    expect(script).toContain('notification.video.url');
    expect(script).toContain('notification.video.title');
    expect(script).toContain('notification.video.publishedDate');
    expect(script).toContain('formatChinaTimestamp(notification.createdAt)');
    expect(script).toContain('formatChinaTimestamp(notification.readAt)');
    expect(script).toMatch(/已读|未读/);
    expect(script).toContain('标记已读');
  });

  it('renders direct download form in an official modal with single-column groups', async () => {
    const html = await getPage('/downloads');

    expect(html).toContain('data-bs-target="#direct-download-modal"');
    expect(html).toContain('id="direct-download-modal"');
    expect(html).toContain('class="modal-dialog modal-dialog-centered modal-lg modal-dialog-scrollable"');
    expect(html).toContain('<form id="direct-download-form" class="modal-content form-stack">');
    expect(html).not.toContain('下载历史');
    expect(html).not.toContain('id="direct-download-form" class="row g-3"');
    expect(html).not.toContain('col-md-8');
  });

  it('submits explicit direct download fields and advanced options', async () => {
    const html = await getPage('/downloads');
    const script = await getPublicScript('downloads.js');

    expect(html).toContain('name="url"');
    expect(html).toContain('Facebook 公开单视频或 Reel');
    expect(html).toContain('抖音公开单视频');
    expect(html).toContain('name="proxyId"');
    expect(script).toContain("request('/api/proxies')");
    expect(html).not.toContain('name="targetSubdirectory"');
    expect(html).not.toContain('name="writeThumbnail"');
    expect(html).toContain('name="mediaType"');
    expect(html).toContain('name="format"');
    expect(html).toContain('name="quality"');
    expect(script).toContain('advancedOptions(form)');
    expect(script).toContain("request('/api/downloads/direct', 'POST', { url: form.elements.url.value, proxyId: nullableNumber(form.elements.proxyId.value), advancedOptions: advancedOptions(form) })");
    expect(script).toContain("let selectedTab = 'completed'");
    expect(script).toContain("facebook: 'Facebook'");
    expect(script).toContain("douyin: '抖音'");
    expect(html).not.toMatch(/name="(?:autoplay|autoDownload)"/);
    expect(html).not.toContain('proxy.url');
  });

  it('renders proxy create and edit forms in the requested grouped layout', async () => {
    const html = await getPage('/settings');
    const script = await getPublicScript('settings.js');

    expect(html).toContain('class="proxy-modal-form"');
    expect(html).toContain('class="proxy-field-full"');
    expect(html).toContain('class="proxy-field-pair"');
    expect(html).toContain('id="proxy-protocol"');
    expect(html).toContain('id="proxy-host"');
    expect(html).toContain('id="proxy-port"');
    expect(html).toContain('id="proxy-modal"');
    expect(html).toContain('id="proxy-form"');
    expect(html).toContain('id="proxy-table"');
    expect(html).toContain('<th>名称</th><th>协议</th><th>主机</th><th>端口</th><th>用户名</th><th>密码</th><th>操作</th>');
    expect(html).toContain('tbody id="proxy-list"');
    expect(script).toContain('proxy.maskedPassword');
    expect(html).not.toContain('id="proxy-create-form" class="row g-3');
  });

  it('submits structured proxy fields and renders only masked proxy passwords', async () => {
    const html = await getPage('/settings');
    const script = await getPublicScript('settings.js');

    expect(html).toContain('name="protocol"');
    expect(html).toContain('name="host"');
    expect(html).toContain('name="port"');
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
    expect(script).toContain('proxyPayload(form)');
    expect(script).toContain("protocol: form.elements.protocol.value");
    expect(script).toContain("password: optionalText(form.elements.password.value)");
    expect(script).toContain('proxy.protocol');
    expect(script).toContain('proxy.host');
    expect(script).toContain('proxy.port');
    expect(script).toContain('proxy.username');
    expect(script).not.toContain('proxy.password');
    expect(html).not.toContain('name="url"');
  });

  it('renders status-specific download cards and actions', async () => {
    const html = await getPage('/downloads');
    const script = await getPublicScript('downloads.js');

    expect(html).toContain('id="download-list" class="download-list"');
    expect(script).toContain("article.className = 'download-card'");
    expect(script).toContain("header.className = 'download-card-header'");
    expect(script).toContain("metrics.className = 'download-card-metrics'");
    expect(script).toContain("failure = detail('失败原因', 'failureReason', 'download-card-failure')");
    expect(script).toContain("meta.className = 'download-card-meta'");
    expect(script).toContain("const source = fieldElement('span', 'badge download-source'");
    expect(script).toContain("const platform = fieldElement('span', 'badge download-platform'");
    expect(html).not.toContain('<thead>');
    expect(html).not.toContain('<th>标题</th>');
    expect(script).toContain("pending: '等待下载'");
    expect(script).toContain("running: '运行中'");
    expect(script).toContain("downloading: '运行中'");
    expect(script).toContain("completed: '下载完成'");
    expect(script).toContain("failed: '下载失败'");
    expect(script).toContain("canceled: '已取消'");
    expect(script).toContain("interrupted: '已中断'");
    expect(script).toContain("download.sourceType === 'channel' ? '频道视频' : '单视频'");
    expect(script).toContain("platformLabels[download.platform] ?? download.platform");
    expect(script).toContain('download.title');
    expect(script).toContain('download.failureReason');
    expect(script).toContain('download.progressPercent');
    expect(script).toContain('download.speedText');
    expect(script).toContain('download.etaSeconds');
    expect(script).toContain("new EventSource(downloadUrl('/api/downloads/events'))");
    expect(script).toContain('download.startedAt');
    expect(script).toContain('download.finishedAt');
    expect(script).toContain('download.outputSizeBytes');
    expect(script).toContain("detail('总时长', 'durationSeconds')");
    expect(script).toContain("detail('文件大小', 'outputSizeBytes')");
    expect(script).toContain("detail('完成时间', 'finishedAt')");
    expect(script).toContain("detail('存储路径', 'outputPath', 'download-card-storage')");
    expect(script).not.toContain("detail('创建时间'");
    expect(script).toContain('download.proxyName');
    expect(script).toContain("download.networkMode === 'direct' ? '直连' : download.proxyName");
    expect(script).toContain("download.status === 'pending' || download.status === 'running' || download.status === 'downloading'");
    expect(script).toContain("mutateDownload(`/api/downloads/${download.id}/cancel`, 'POST', {}, cancel)");
    expect(script).toContain("download.status === 'failed' || download.status === 'canceled' || download.status === 'interrupted'");
    expect(script).toContain("mutateDownload(`/api/downloads/${download.id}/retry`, 'POST', {}, retry)");
    expect(script).toContain('if (trigger.disabled) return;');
    expect(script).toContain('trigger.disabled = true;');
    expect(script).toContain('if (trigger.isConnected) trigger.disabled = false;');
    expect(script).toContain("download.status === 'completed' || download.status === 'failed' || download.status === 'canceled' || download.status === 'interrupted'");
    expect(script).toContain("confirm(`确认永久删除下载「${download.title}」及其文件？`)");
    expect(script).toContain("mutateDownload(`/api/downloads/${download.id}`, 'DELETE', undefined, remove)");
    expect(script).not.toContain('location.reload()');
    expect(script).not.toContain("list.textContent = ''");
    expect(script).toContain('if (field.textContent !== nextValue)');
    expect(script).toContain('previous === undefined || JSON.stringify(previous) !== JSON.stringify(download)');
    expect(script).toContain("downloadEvents.addEventListener('downloads'");
    expect(script).toContain("if (download.status === 'completed')");
    expect(script).toContain('`/downloads/preview?id=${download.id}`');
    expect(script).toContain('`/api/downloads/${download.id}/file`');
    expect(script).toContain('original.href = download.sourceUrl');
    expect(script).toContain("original.target = '_blank'");
    expect(script).toContain("original.rel = 'noopener noreferrer'");
    expect(html).not.toMatch(/自动下载|播放/);
  });

  it('filters downloads by title and exposes distinct tab and empty-state contracts', async () => {
    const html = await getPage('/downloads');
    const script = await getPublicScript('downloads.js');

    expect(html).toContain('id="download-search" type="search" placeholder="搜索下载标题"');
    expect(html).toContain('role="tablist" aria-label="下载状态"');
    expect(html).toMatch(/class="download-tabs"[\s\S]*class="download-search"/);
    expect(html).toContain('class="download-tab" type="button" role="tab" aria-selected="false" aria-controls="download-list" data-download-tab="active"');
    expect(html).toContain('class="download-tab is-active" type="button" role="tab" aria-selected="true" aria-controls="download-list" data-download-tab="completed"');
    expect(html).toContain('class="download-tab" type="button" role="tab" aria-selected="false" aria-controls="download-list" data-download-tab="failed"');
    expect(script).toContain("let selectedTab = 'completed'");
    expect(html).toContain('id="download-empty-state"');
    expect(html).toContain('data-empty-title');
    expect(html).toContain('data-empty-description');
    expect(html).toContain('data-empty-action');

    const functionSource = script.slice(
      script.indexOf('function emptyStateFor'),
      script.indexOf('function setSelectedTab'),
    );
    const helpers = new Function(
      `${functionSource}; return { emptyStateFor };`,
    )() as {
      emptyStateFor(tab: string, query: string, total: number): { title: string; action: string };
    };

    expect(script).toContain("new URLSearchParams({ page: String(page), tab: selectedTab })");
    expect(script).toContain("parameters.set('q', searchQuery)");
    expect(script).toContain('statusCounts.pending + statusCounts.downloading + statusCounts.running');
    expect(script).toContain('statusCounts.failed + statusCounts.canceled + statusCounts.interrupted');
    expect(helpers.emptyStateFor('active', '', 0)).toMatchObject({ title: '还没有下载任务', action: 'create' });
    expect(helpers.emptyStateFor('active', '测试', 2)).toMatchObject({ title: '没有找到“测试”', action: 'clear' });
    expect(helpers.emptyStateFor('completed', '', 2)).toMatchObject({ title: '还没有完成的下载', action: 'active' });
    expect(helpers.emptyStateFor('active', '', 2)).toMatchObject({ title: '当前没有下载中的任务', action: 'create' });
    expect(helpers.emptyStateFor('failed', '', 2)).toMatchObject({ title: '没有失败的下载', action: 'active' });
  });

  it('renders and executes the standalone download preview contract', async () => {
    const html = await getPage('/downloads/preview?id=1');
    const script = await getPublicScript('download-preview.js');

    expect(html).toContain('<body class="preview-page">');
    expect(html).toContain('id="preview-player"');
    expect(html).toContain('id="preview-error"');
    expect(html).toContain('controls preload="metadata" hidden');
    expect(script).toContain('page.title = download.title');
    expect(html).not.toContain('download-preview-toolbar');
    expect(html).not.toContain('preview-download');
    expect(html).not.toContain('preview-original');
    expect(script).toContain('浏览器无法播放此文件，请返回下载页面下载后查看');
    expect(script).toContain("error.code === 'DOWNLOAD_NOT_FOUND' ? '下载记录不存在' : '无法加载下载记录'");
    expect(html).not.toContain('class="app-shell"');
    expect(html).not.toContain('class="app-sidebar"');
    expect(html).not.toContain('class="app-topbar"');
    expect(html).not.toContain('deployment-warning');
    expect(html).not.toContain('可信内网');
    expect(html).not.toContain('class="app-footer"');
    expect(script).toContain('request(`/api/downloads/${id}`)');
    expect(script).toContain("new URLSearchParams(location.search).get('id')");

    const functionSource = script.slice(
      script.indexOf('function parseDownloadId'),
      script.indexOf('async function load'),
    );
    const helpers = new Function(
      `${functionSource}; return { renderPreview };`,
    )() as {
      renderPreview(download: Record<string, unknown>, rawId: string | null, player: Record<string, unknown>, page: Record<string, unknown>, error: Record<string, unknown>): void;
    };
    const player = () => ({ src: '', hidden: true });

    for (const [rawId, download, message] of [
      ['x', { status: 'pending' }, '下载记录参数无效'],
      ['2', { id: 2, status: 'pending' }, '文件尚不可预览'],
    ] as const) {
      const media = player();
      const page = { title: '下载预览' };
      const error = { textContent: '', hidden: true };
      helpers.renderPreview(download, rawId, media, page, error);
      expect(media.src).toBe('');
      expect(media.hidden).toBe(true);
      expect(page.title).toBe('下载预览');
      expect(error).toEqual({ textContent: message, hidden: false });
    }

    const media = player();
    const page = { title: '下载预览' };
    helpers.renderPreview(
      { id: 2, status: 'completed', title: 'Video', sourceUrl: 'https://media.example/items/2' },
      '2',
      media,
      page,
      { textContent: '', hidden: true },
    );
    expect(page.title).toBe('Video');
    expect(media.src).toBe('/api/downloads/2/media');
    expect(media.hidden).toBe(false);
  });

  it('formats download times and completed file sizes', async () => {
    const script = await getPublicScript('downloads.js');
    const timeScript = await getPublicScript('time.js');
    type FakeNode = {
      className: string;
      textContent: string;
      children: FakeNode[];
      title?: string;
      append(...children: FakeNode[]): void;
      readonly lastElementChild: FakeNode | null;
    };
    const fakeDocument = {
      createElement: (): FakeNode => ({
        className: '',
        textContent: '',
        children: [],
        append(...children: FakeNode[]) {
          this.children.push(...children);
        },
        get lastElementChild() {
          return this.children.at(-1) ?? null;
        },
      }),
    };
    const functionSource = script.slice(
      script.indexOf('function displayValue'),
      script.indexOf('function renderDownloads'),
    );
    const timeHelpers = new Function(
      `${timeScript.replace('export function', 'function')}; return { formatChinaTimestamp };`,
    )() as {
      formatChinaTimestamp(value: string): string;
    };
    const helpers = new Function(
      'document',
      'formatChinaTimestamp',
      `${functionSource}; return { displayValue, formatTimestamp, formatBytes };`,
    )(fakeDocument, timeHelpers.formatChinaTimestamp) as {
      displayValue(value: string | null): string;
      formatTimestamp(value: string | null): string;
      formatBytes(value: number | null): string;
    };
    const value = '2026-07-18T09:43:33.709Z';

    expect(helpers.displayValue(null)).toBe('—');
    expect(helpers.displayValue('0s')).toBe('0s');
    expect(helpers.formatTimestamp(value)).toBe('2026-07-18 17:43:33');
    expect(helpers.formatTimestamp(null)).toBe('—');
    expect(helpers.formatTimestamp('invalid')).toBe('invalid');
    expect(helpers.formatBytes(2048)).toBe('2 KiB');
    expect(helpers.formatBytes(null)).toBe('—');
    expect(script).toContain('formatTimestamp(download.startedAt)');
    expect(script).toContain('formatTimestamp(download.finishedAt)');
    expect(script).toContain("setField(article, 'outputSizeBytes', formatBytes(download.outputSizeBytes))");
    expect(script).toContain("setField(article, 'outputPath', download.outputPath)");
  });

  it('uses China Standard Time for every visible timestamp', async () => {
    const [timeScript, channelsScript, channelDetailScript, downloadsScript, notificationsScript] = await Promise.all([
      getPublicScript('time.js'),
      getPublicScript('channels.js'),
      getPublicScript('channel-detail.js'),
      getPublicScript('downloads.js'),
      getPublicScript('notifications.js'),
    ]);

    expect(timeScript).toContain("timeZone: 'Asia/Shanghai'");
    expect(channelsScript).toContain("from '/public/time.js'");
    expect(channelDetailScript).toContain("from '/public/time.js'");
    expect(downloadsScript).toContain("from '/public/time.js'");
    expect(notificationsScript).toContain("from '/public/time.js'");
    expect(channelDetailScript).not.toContain('toLocaleString');
    expect(downloadsScript).not.toMatch(/get(?:FullYear|Month|Date|Hours|Minutes|Seconds)\(/);
  });

  it('renders the task snapshot page with fixed tables, empty states, and refresh contract', async () => {
    const html = await getPage('/yt-dlp-tasks');
    const script = await getPublicScript('yt-dlp-tasks.js');

    expect(html).toContain('<title>任务状态 · VidHarbor</title>');
    expect(html).toContain('class="sidebar-link active" href="/yt-dlp-tasks">任务状态</a>');
    expect(html).toContain('刷新浏览器可查看最新状态。');
    expect(html).toContain('<h2 id="active-tasks-title">活动任务</h2>');
    expect(html).toContain('<h2 id="terminal-tasks-title">已结束任务</h2>');
    expect(html.match(/<table class="table yt-dlp-tasks-table align-middle mb-0">/g)).toHaveLength(2);
    expect(html.match(/<th scope="col">任务 ID<\/th><th scope="col">任务类型<\/th><th scope="col">状态<\/th><th scope="col">创建时间<\/th><th scope="col">开始时间<\/th><th scope="col">结束时间<\/th><th scope="col">失败原因<\/th>/g)).toHaveLength(2);
    expect(html).toContain('id="active-task-empty" class="yt-dlp-tasks-empty" role="status" hidden>当前没有排队或运行中的任务。</div>');
    expect(html).toContain('id="terminal-task-empty" class="yt-dlp-tasks-empty" role="status" hidden>当前没有已结束的任务。</div>');
    expect(html).toContain('<script type="module" src="/public/yt-dlp-tasks.js"></script>');

    expect(script.match(/fetch\('\/api\/yt-dlp\/tasks'/g)).toHaveLength(1);
    expect(script).toContain("fetch('/api/yt-dlp/tasks', { credentials: 'same-origin' })");
    expect(script).toContain("if (!Array.isArray(body.tasks)) throw new Error('任务快照格式错误')");
    expect(script).not.toMatch(/setInterval|setTimeout|WebSocket|EventSource/);
    expect(script).not.toContain('/cancel');
    expect(script).not.toContain('/api/downloads');
    expect(script).not.toContain('/api/channels');

    const helpers = taskPageHelpers(script);
    helpers.renderGroup([], 'active-task-list', 'active-task-empty', 'active-task-count');
    helpers.renderGroup([], 'terminal-task-list', 'terminal-task-empty', 'terminal-task-count');
    expect(helpers.nodes.get('active-task-empty')).toMatchObject({ hidden: false });
    expect(helpers.nodes.get('terminal-task-empty')).toMatchObject({ hidden: false });
    expect(helpers.nodes.get('active-task-count')?.textContent).toBe('0');
    expect(helpers.nodes.get('terminal-task-count')?.textContent).toBe('0');
  });

  it('renders all fixed task types and statuses from one redacted manager snapshot', async () => {
    let finishRunning!: () => void;
    let finishQueued!: () => void;
    const runningGate = new Promise<void>((resolve) => {
      finishRunning = resolve;
    });
    const queuedGate = new Promise<void>((resolve) => {
      finishQueued = resolve;
    });
    const running = taskManager.submit({
      type: 'media_download',
      execute: () => runningGate,
    });
    const queued = taskManager.submit({
      type: 'media_download',
      execute: () => queuedGate,
    });
    const succeeded = taskManager.submit({
      type: 'metadata_probe',
      execute: async () => undefined,
    });
    const failed = taskManager.submit({
      type: 'channel_initial_sync',
      execute: async () => {
        throw new Error(`request failed via ${credentialedProxyUrl}`);
      },
    });
    void failed.result.catch(() => undefined);
    const canceled = taskManager.submit({
      type: 'channel_manual_check',
      execute: async () => undefined,
    });
    void canceled.result.catch(() => undefined);
    await taskManager.cancel(canceled.id);
    const scheduled = taskManager.submit({
      type: 'channel_scheduled_check',
      execute: async () => undefined,
    });

    await Promise.all([
      succeeded.result,
      failed.result.catch(() => undefined),
      scheduled.result,
    ]);
    await schedulingTurn();

    const response = await fetch(`${baseUrl}/api/yt-dlp/tasks`);
    const rawBody = await response.text();
    const body = JSON.parse(rawBody) as { tasks: YtDlpTaskSnapshot[] };
    expect(response.status).toBe(200);
    expect(body.tasks.map(({ status }) => status)).toEqual([
      'running',
      'queued',
      'succeeded',
      'failed',
      'canceled',
      'succeeded',
    ]);
    expect(new Set(body.tasks.map(({ type }) => type))).toEqual(new Set([
      'media_download',
      'metadata_probe',
      'channel_initial_sync',
      'channel_manual_check',
      'channel_scheduled_check',
    ]));
    expect(rawBody).toContain('http://***@proxy.example:8080');
    expect(rawBody).not.toContain(credentialedProxyUrl);
    expect(rawBody).not.toContain('alice:secret');

    const helpers = taskPageHelpers(await getPublicScript('yt-dlp-tasks.js'));
    const activeTasks = body.tasks.filter(({ status }) => status === 'queued' || status === 'running');
    const terminalTasks = body.tasks.filter(({ status }) => status === 'succeeded' || status === 'failed' || status === 'canceled');
    helpers.renderGroup(activeTasks, 'active-task-list', 'active-task-empty', 'active-task-count');
    helpers.renderGroup(terminalTasks, 'terminal-task-list', 'terminal-task-empty', 'terminal-task-count');
    const pageDom = [...helpers.nodes.values()].map(taskNodeText).join(' ');

    for (const label of ['媒体下载', '元数据探测', '频道首次同步', '频道手动检查', '频道定时检查']) {
      expect(pageDom).toContain(label);
    }
    for (const label of ['排队中', '运行中', '已成功', '已失败', '已取消']) {
      expect(pageDom).toContain(label);
    }
    expect(pageDom).toContain('request failed via http://***@proxy.example:8080');
    expect(pageDom).not.toContain(credentialedProxyUrl);
    expect(pageDom).not.toContain('alice:secret');
    expect(helpers.nodes.get('active-task-count')?.textContent).toBe('2');
    expect(helpers.nodes.get('terminal-task-count')?.textContent).toBe('4');
    expect(helpers.nodes.get('active-task-empty')).toMatchObject({ hidden: true });
    expect(helpers.nodes.get('terminal-task-empty')).toMatchObject({ hidden: true });

    finishRunning();
    finishQueued();
    await Promise.all([running.result, queued.result]);
  });

  it('rejects task types and statuses outside the fixed page contract', async () => {
    const helpers = taskPageHelpers(await getPublicScript('yt-dlp-tasks.js'));
    const task: YtDlpTaskSnapshot = {
      id: 1,
      type: 'media_download',
      status: 'queued',
      createdAt: '2026-07-19T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      failureReason: null,
    };

    expect(() => helpers.taskRow({ ...task, type: 'unknown' as YtDlpTaskSnapshot['type'] }))
      .toThrow('未知任务类型：unknown');
    expect(() => helpers.taskRow({ ...task, status: 'unknown' as YtDlpTaskSnapshot['status'] }))
      .toThrow('未知任务状态：unknown');
  });

  it('keeps the task table readable on mobile and wraps long failure reasons', async () => {
    const styles = await readFile(
      new URL('../../src/styles/main.scss', import.meta.url),
      'utf8',
    );

    expect(styles).toMatch(/\.yt-dlp-task-failure\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/s);
    expect(styles).toMatch(/@media \(max-width: 991\.98px\)[\s\S]*\.yt-dlp-tasks-table thead\s*\{[^}]*display: none;/);
    expect(styles).toMatch(/@media \(max-width: 991\.98px\)[\s\S]*\.yt-dlp-tasks-table td\s*\{[^}]*grid-template-columns: 6\.5rem minmax\(0, 1fr\);[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
    expect(styles).toMatch(/@media \(max-width: 991\.98px\)[\s\S]*\.yt-dlp-task-failure\s*\{[^}]*min-width: 0;[^}]*max-width: none;/);
  });

  it('allows only the task manager to import the low-level yt-dlp module', async () => {
    const sourceRoot = join(process.cwd(), 'src');
    const importPattern = /from ['"](?:\.\.?\/)*yt-dlp\.js['"]/;
    const importingFiles: string[] = [];

    for (const file of await typeScriptFiles(sourceRoot)) {
      if (importPattern.test(await readFile(file, 'utf8'))) {
        importingFiles.push(relative(process.cwd(), file));
      }
    }

    expect(importingFiles.sort()).toEqual(['src/yt-dlp-task-manager.ts']);
  });

  it('keeps download cards readable across desktop and mobile widths', async () => {
    const styles = await readFile(
      new URL('../../src/styles/main.scss', import.meta.url),
      'utf8',
    );

    expect(styles).toMatch(/\.download-card-identity\s*\{[^}]*flex: 1 1 24rem;/s);
    expect(styles).toContain('.download-card-failure {');
    expect(styles).toContain('.download-card-storage {');
    expect(styles).toContain('.download-source {');
    expect(styles).toContain('.download-platform {');
    expect(styles).toContain('.download-controls {');
    expect(styles).toContain('.download-tabs {');
    expect(styles).toMatch(/\.download-tabs\s*\{[^}]*grid-template-columns: repeat\(3, max-content\);/s);
    expect(styles).toContain('.download-empty-state {');
    expect(styles).toContain('@media (max-width: 575.98px)');
    expect(styles).toMatch(/@media \(max-width: 575\.98px\)[\s\S]*\.download-card-header\s*\{[^}]*flex-direction: column;/);
    expect(styles).toMatch(/@media \(max-width: 575\.98px\)[\s\S]*\.download-controls\s*\{[^}]*flex-direction: column;/);
    expect(styles).toMatch(/@media \(max-width: 575\.98px\)[\s\S]*\.download-card-metrics\s*\{[^}]*grid-template-columns: 1fr;/);
    expect(styles).not.toMatch(/\.download-detail-value\s*\{[^}]*text-overflow: ellipsis;/s);
    expect(styles).toMatch(/\.preview-page\s*\{[^}]*width: 100dvw;[^}]*height: 100dvh;[^}]*overflow: hidden;[^}]*background:/s);
    expect(styles).toMatch(/\.download-preview\s*\{[^}]*width: 100%;[^}]*height: 100%;/s);
    expect(styles).toMatch(/\.download-preview-player\s*\{[^}]*width: 100%;[^}]*height: 100%;[^}]*object-fit: contain;[^}]*background:/s);
    expect(styles).not.toContain('.download-preview-toolbar');
    expect(styles).not.toContain('.download-preview-actions');
    expect(styles).toContain('.download-preview-error');
  });

  it('keeps compact channel check fields on one line and wraps long failure reasons', async () => {
    const styles = await readFile(
      new URL('../../src/styles/main.scss', import.meta.url),
      'utf8',
    );

    expect(styles).toMatch(/\.channel-check-table td:not\(:last-child\)\s*\{[^}]*white-space: nowrap;/s);
    expect(styles).toMatch(/\.channel-check-table td:last-child\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/s);
  });

  it('requires confirmation before page delete actions', async () => {
    const settingsScript = await getPublicScript('settings.js');
    const downloadsScript = await getPublicScript('downloads.js');

    expect(settingsScript).toContain("confirm(`确认删除代理「${proxy.name}」？`)");
    expect(settingsScript).toContain('if (!confirmed) return;');
    expect(settingsScript).toContain("request(`/api/proxies/${proxy.id}`, 'DELETE')");

    expect(downloadsScript).toContain("confirm(`确认永久删除下载「${download.title}」及其文件？`)");
    expect(downloadsScript).toContain('if (!confirmed) return;');
    expect(downloadsScript).toContain("mutateDownload(`/api/downloads/${download.id}`, 'DELETE', undefined, remove)");
  });

  it.each(['/', '/settings', '/channels', '/channels/7', '/notifications', '/downloads', '/yt-dlp-tasks', '/guide', '/downloads/preview?id=1'])('keeps JavaScript and CSS external on %s', async (path) => {
    const html = await getPage(path);

    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style(?:\s|>)/);
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('keeps modals open when clicking outside their dialog', async () => {
    const channelsHtml = await getPage('/channels');
    const settingsHtml = await getPage('/settings');
    const downloadsHtml = await getPage('/downloads');

    expect(channelsHtml).toContain(
      'id="channel-modal" tabindex="-1" aria-labelledby="channel-modal-title" aria-hidden="true" data-bs-backdrop="static"',
    );
    expect(settingsHtml).toContain(
      'id="proxy-modal" tabindex="-1" aria-labelledby="proxy-modal-title" aria-hidden="true" data-bs-backdrop="static"',
    );
    expect(downloadsHtml).toContain(
      'id="direct-download-modal" tabindex="-1" aria-labelledby="direct-download-title" aria-hidden="true" data-bs-backdrop="static"',
    );
  });
});
