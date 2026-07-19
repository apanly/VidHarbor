import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiRouter, createApp } from '../../src/app.js';
import { RuntimeCoordinator } from '../../src/runtime.js';
import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import type { DownloadQueue } from '../../src/services/download.js';

let sandbox: string;
let database: DatabaseConnection;
let baseUrl: string;
let stopServer: (() => Promise<void>) | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-pages-'));
  const downloadsMountPath = join(sandbox, 'downloads');
  await mkdir(downloadsMountPath);
  database = openDatabase(join(sandbox, 'vidharbor.sqlite'));
  migrateDatabase(database);

  const queue: DownloadQueue = { enqueue: () => undefined };
  const app = createApp(
    createApiRouter(database, downloadsMountPath, new RuntimeCoordinator(() => undefined), 'unused-yt-dlp', queue),
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
  database.close();
  await rm(sandbox, { recursive: true, force: true });
});

async function getPage(path: string): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  return response.text();
}

describe('server-rendered pages', () => {
  it.each([
    ['/', '<h1 class="mb-4">总览</h1>'],
    ['/settings', '<h1>配置</h1>'],
    ['/channels', '<h1>频道</h1>'],
    ['/channels/7', '频道详情'],
    ['/notifications', '新视频提醒'],
    ['/downloads', '<h1>下载</h1>'],
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
    expect(html).toContain('href="/guide">说明</a>');
    expect(html).toMatch(/href="\/">总览<\/a>[\s\S]*href="\/downloads">下载<\/a>[\s\S]*href="\/channels">频道<\/a>[\s\S]*href="\/notifications">提醒<\/a>[\s\S]*href="\/settings">配置<\/a>[\s\S]*href="\/guide">说明<\/a>/);
    expect(html).not.toContain('navbar-nav flex-row');
    expect(html).not.toContain('deployment-warning');
    expect(html).not.toContain('切勿直接暴露到公网');
    expect(html).not.toContain('可信内网视频管理');
    expect(html).not.toContain('class="eyebrow');
    expect(html).not.toContain('class="app-footer"');
  });

  it('explains the complete current project contract on the guide page', async () => {
    const html = await getPage('/guide');
    const guideTemplate = await readFile(join(process.cwd(), 'src/views/guide.ejs'), 'utf8');
    const dockerfile = await readFile(join(process.cwd(), 'Dockerfile'), 'utf8');

    expect(html).toContain('只能部署在可信内网');
    expect(html).toContain('最近 1、3、6 或 12 个月');
    expect(html).toContain('固定为检查开始时间之前最近 1 个自然月');
    expect(html).toContain('YouTube、Bilibili、Vimeo、X');
    expect(html).toContain('&lt;下载根目录&gt;/&lt;下载ID&gt;/');
    expect(html).toContain('主媒体文件成功并通过校验，任务就算成功');
    expect(html).toContain('当前不提供');
    expect(html).toContain('class="sidebar-link sidebar-guide-link active" href="/guide">说明</a>');
    expect(html).toContain('id="guide-content" class="guide-markdown"');
    expect(html).toContain("document.querySelectorAll('#guide-content h2')");
    expect(html).toContain('<strong>成功条件：</strong>');
    expect(guideTemplate).toContain('<%- guideHtml %>');
    expect(guideTemplate).not.toContain('主媒体文件成功并通过校验');
    expect(dockerfile).toContain('COPY README.md ./');
    expect(dockerfile).toContain('/app/README.md ./README.md');
  });

  it('renders add and edit forms in dialogs with single-column fields', async () => {
    const channelsHtml = await getPage('/channels');
    const settingsHtml = await getPage('/settings');

    expect(channelsHtml).toContain('data-bs-target="#channel-modal"');
    expect(channelsHtml).toContain('id="channel-modal"');
    expect(channelsHtml).toContain('id="channel-modal-title"');
    expect(channelsHtml).toContain('id="channel-form"');
    expect(channelsHtml).toContain('openChannelCreateModal()');
    expect(channelsHtml).toContain('openChannelEditModal(channel)');
    expect(channelsHtml).toContain('>新增频道</button>');
    expect(channelsHtml).not.toContain('已添加频道');
    expect(channelsHtml).toContain('id="channel-list" class="row row-cols-1 row-cols-md-2 row-cols-xl-3 g-4"');
    expect(channelsHtml).toContain("card.className = 'card h-100 channel-card'");
    expect(channelsHtml).toContain("card.setAttribute('role', 'link')");
    expect(channelsHtml).toContain("window.open(`/channels/${channel.id}`, '_blank', 'noopener')");
    expect(channelsHtml).toContain("event.target.closest('a, button, input, select, textarea, label')");
    expect(channelsHtml).toContain("link.target = '_blank'; link.rel = 'noopener'");
    expect(channelsHtml).toContain('confirm(`确认删除频道「${channel.customName}」？`)');
    expect(channelsHtml).toContain("request(`/api/channels/${channel.id}`, 'DELETE')");
    expect(channelsHtml).toContain('container.hidden = value.totalItems === 0');
    expect(channelsHtml).toContain("timeZone: 'Asia/Shanghai'");
    expect(channelsHtml).toContain("formatChinaTime(channel.lastCheck.nextAt)");
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
    expect(channelsHtml).toContain("request(`/api/channels/${initialSyncChannelId}/initial-sync`, 'POST'");
    expect(channelsHtml).toContain("submit.textContent = '同步中'");

    expect(settingsHtml).toContain('data-bs-target="#proxy-modal"');
    expect(settingsHtml).toContain('id="proxy-modal"');
    expect(settingsHtml).toContain('id="proxy-modal-title"');
    expect(settingsHtml).toContain('id="proxy-form"');
    expect(settingsHtml).toContain('openProxyCreateModal()');
    expect(settingsHtml).toContain('openProxyEditModal(proxy)');
    expect(settingsHtml).toContain('class="proxy-modal-form"');
    expect(settingsHtml).not.toContain('data-proxy-edit-modal-root');
    expect(settingsHtml).not.toContain('buildProxyEditModal');
    expect(settingsHtml).not.toContain('proxy-create-modal');
    expect(settingsHtml).not.toContain('id="proxy-create-form" class="row g-3');
  });

  it('submits only explicitly selected channel videos', async () => {
    const html = await getPage('/channels/7');

    expect(html).toContain('id="download-form"');
    expect(html).toContain('role="tablist" aria-label="频道详情"');
    expect(html).toContain('data-channel-tab="videos">视频列表</button>');
    expect(html).toContain('data-channel-tab="checks">检查记录</button>');
    expect(html).toContain('data-channel-panel="videos"');
    expect(html).toContain('data-channel-panel="checks" hidden');
    expect(html).toContain('id="video-list"');
    expect(html).toContain('id="check-list"');
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html).not.toContain('返回频道');
    expect(html).not.toContain('channel-back-link');
    expect(html).toContain("const row = document.createElement('tr')");
    expect(html).toContain('setChannelTab(button.dataset.channelTab)');
    expect(html).toContain("pending: '等待下载'");
    expect(html).toContain("completed: '下载完成'");
    expect(html).toContain("interrupted: '已中断'");
    expect(html).toContain("video.downloadStatus === null ? '尚未下载' : downloadStatusLabels[video.downloadStatus]");
    expect(html).toContain('name="proxyId"');
    expect(html).toContain('<option value="channel">沿用频道代理</option>');
    expect(html).toContain("request('/api/proxies')");
    expect(html).toContain("checkbox.name = 'videoIds'");
    expect(html).toContain(
      "form.querySelectorAll('input[name=\"videoIds\"]:checked')",
    );
    expect(html).toContain(
      "request('/api/downloads/channel', 'POST', { videoIds, proxyId: channelProxyId() })",
    );
    expect(html).not.toMatch(/自动选择|自动下载|删除频道|手动检查/);
  });

  it('renders notifications as a table with channel, video, and read actions', async () => {
    const html = await getPage('/notifications');

    expect(html).toContain('request(`/api/notifications?page=${requestedPage}`)');
    expect(html).toContain('<table class="table channel-detail-table notification-table align-middle mb-0">');
    expect(html).toContain('<th scope="col">视频</th><th scope="col">频道</th><th scope="col">发布日期</th><th scope="col">发现时间</th><th scope="col">状态</th><th scope="col">操作</th>');
    expect(html).toContain("const row = document.createElement('tr')");
    expect(html).toContain("row.append(videoCell, channelCell, publishedCell, createdCell, stateCell, actionCell)");
    expect(html).toContain('`/channels/${notification.channel.id}`');
    expect(html).toContain('notification.video.url');
    expect(html).toContain('notification.video.title');
    expect(html).toContain('notification.video.publishedDate');
    expect(html).toMatch(/已读|未读/);
    expect(html).toContain('标记已读');
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

    expect(html).toContain('name="url"');
    expect(html).toContain('name="proxyId"');
    expect(html).toContain("request('/api/proxies')");
    expect(html).not.toContain('name="targetSubdirectory"');
    expect(html).not.toContain('name="writeThumbnail"');
    expect(html).toContain('name="mediaType"');
    expect(html).toContain('name="format"');
    expect(html).toContain('name="quality"');
    expect(html).toContain('advancedOptions(form)');
    expect(html).toContain("request('/api/downloads/direct', 'POST', { url: form.elements.url.value, proxyId: nullableNumber(form.elements.proxyId.value), advancedOptions: advancedOptions(form) })");
    expect(html).toContain("let selectedTab = 'completed'");
    expect(html).not.toMatch(/name="(?:autoplay|autoDownload)"/);
    expect(html).not.toContain('proxy.url');
  });

  it('renders proxy create and edit forms in the requested grouped layout', async () => {
    const html = await getPage('/settings');

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
    expect(html).toContain('proxy.maskedPassword');
    expect(html).not.toContain('id="proxy-create-form" class="row g-3');
  });

  it('submits structured proxy fields and renders only masked proxy passwords', async () => {
    const html = await getPage('/settings');

    expect(html).toContain('name="protocol"');
    expect(html).toContain('name="host"');
    expect(html).toContain('name="port"');
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
    expect(html).toContain('proxyPayload(form)');
    expect(html).toContain("protocol: form.elements.protocol.value");
    expect(html).toContain("password: optionalText(form.elements.password.value)");
    expect(html).toContain('proxy.protocol');
    expect(html).toContain('proxy.host');
    expect(html).toContain('proxy.port');
    expect(html).toContain('proxy.username');
    expect(html).not.toContain('proxy.password');
    expect(html).not.toContain('name="url"');
  });

  it('keeps all four download states distinct and displays persisted history fields', async () => {
    const html = await getPage('/downloads');

    expect(html).toContain('id="download-list" class="download-list"');
    expect(html).toContain("article.className = 'download-card'");
    expect(html).toContain("header.className = 'download-card-header'");
    expect(html).toContain("metrics.className = 'download-card-metrics'");
    expect(html).toContain("details.className = 'download-card-details'");
    expect(html).toContain("meta.className = 'download-card-meta'");
    expect(html).toContain("const source = fieldElement('span', 'badge download-source'");
    expect(html).not.toContain('<thead>');
    expect(html).not.toContain('<th>标题</th>');
    expect(html).toContain("pending: '等待下载'");
    expect(html).toContain("running: '运行中'");
    expect(html).toContain("downloading: '运行中'");
    expect(html).toContain("completed: '下载完成'");
    expect(html).toContain("failed: '下载失败'");
    expect(html).toContain("canceled: '已取消'");
    expect(html).toContain("interrupted: '已中断'");
    expect(html).toContain("download.sourceType === 'channel' ? '频道视频' : '单视频'");
    expect(html).toContain('download.title');
    expect(html).toContain('download.outputPath');
    expect(html).toContain('download.failureReason');
    expect(html).toContain('download.progressPercent');
    expect(html).toContain('download.speedText');
    expect(html).toContain('download.etaSeconds');
    expect(html).toContain("new EventSource(downloadUrl('/api/downloads/events'))");
    expect(html).toContain('download.createdAt');
    expect(html).toContain('download.startedAt');
    expect(html).toContain('download.finishedAt');
    expect(html).toContain('download.proxyName');
    expect(html).toContain("download.networkMode === 'direct' ? '直连' : download.proxyName");
    expect(html).toContain("download.status === 'pending' || download.status === 'running' || download.status === 'downloading'");
    expect(html).toContain("mutateDownload(`/api/downloads/${download.id}/cancel`, 'POST', {}, cancel)");
    expect(html).toContain("download.status === 'failed' || download.status === 'canceled' || download.status === 'interrupted'");
    expect(html).toContain("mutateDownload(`/api/downloads/${download.id}/retry`, 'POST', {}, retry)");
    expect(html).toContain('if (trigger.disabled) return;');
    expect(html).toContain('trigger.disabled = true;');
    expect(html).toContain('if (trigger.isConnected) trigger.disabled = false;');
    expect(html).toContain("download.status === 'completed' || download.status === 'failed' || download.status === 'canceled' || download.status === 'interrupted'");
    expect(html).toContain("confirm(`确认永久删除下载「${download.title}」及其文件？`)");
    expect(html).toContain("mutateDownload(`/api/downloads/${download.id}`, 'DELETE', undefined, remove)");
    expect(html).not.toContain('location.reload()');
    expect(html).not.toContain("list.textContent = ''");
    expect(html).toContain('if (field.textContent !== nextValue)');
    expect(html).toContain('previous === undefined || JSON.stringify(previous) !== JSON.stringify(download)');
    expect(html).toContain("downloadEvents.addEventListener('downloads'");
    expect(html).toContain("if (download.status === 'completed')");
    expect(html).toContain('`/downloads/preview?id=${download.id}`');
    expect(html).toContain('`/api/downloads/${download.id}/file`');
    expect(html).toContain('original.href = download.sourceUrl');
    expect(html).toContain("original.target = '_blank'");
    expect(html).toContain("original.rel = 'noopener noreferrer'");
    expect(html).not.toMatch(/自动下载|播放/);
  });

  it('filters downloads by title and exposes distinct tab and empty-state contracts', async () => {
    const html = await getPage('/downloads');

    expect(html).toContain('id="download-search" type="search" placeholder="搜索下载标题"');
    expect(html).toContain('role="tablist" aria-label="下载状态"');
    expect(html).toContain('class="download-tab" type="button" role="tab" aria-selected="false" aria-controls="download-list" data-download-tab="active"');
    expect(html).toContain('class="download-tab is-active" type="button" role="tab" aria-selected="true" aria-controls="download-list" data-download-tab="completed"');
    expect(html).toContain("let selectedTab = 'completed'");
    expect(html).toContain('id="download-empty-state"');
    expect(html).toContain('data-empty-title');
    expect(html).toContain('data-empty-description');
    expect(html).toContain('data-empty-action');

    const functionSource = html.slice(
      html.indexOf('function emptyStateFor'),
      html.indexOf('function setSelectedTab'),
    );
    const helpers = new Function(
      `${functionSource}; return { emptyStateFor };`,
    )() as {
      emptyStateFor(tab: string, query: string, total: number): { title: string; action: string };
    };

    expect(html).toContain("new URLSearchParams({ page: String(page), tab: selectedTab })");
    expect(html).toContain("parameters.set('q', searchQuery)");
    expect(html).toContain('statusCounts.pending + statusCounts.downloading + statusCounts.running + statusCounts.failed + statusCounts.canceled + statusCounts.interrupted');
    expect(helpers.emptyStateFor('active', '', 0)).toMatchObject({ title: '还没有下载任务', action: 'create' });
    expect(helpers.emptyStateFor('active', '测试', 2)).toMatchObject({ title: '没有找到“测试”', action: 'clear' });
    expect(helpers.emptyStateFor('completed', '', 2)).toMatchObject({ title: '还没有完成的下载', action: 'active' });
    expect(helpers.emptyStateFor('active', '', 2)).toMatchObject({ title: '当前没有下载中的任务', action: 'create' });
  });

  it('renders and executes the standalone download preview contract', async () => {
    const html = await getPage('/downloads/preview?id=1');

    expect(html).toContain('<body class="preview-page">');
    expect(html).toContain('id="preview-player"');
    expect(html).toContain('id="preview-error"');
    expect(html).toContain('controls preload="metadata" hidden');
    expect(html).toContain('page.title = download.title');
    expect(html).not.toContain('download-preview-toolbar');
    expect(html).not.toContain('preview-download');
    expect(html).not.toContain('preview-original');
    expect(html).toContain('浏览器无法播放此文件，请返回下载页面下载后查看');
    expect(html).toContain("error.code === 'DOWNLOAD_NOT_FOUND' ? '下载记录不存在' : '无法加载下载记录'");
    expect(html).not.toContain('class="app-shell"');
    expect(html).not.toContain('class="app-sidebar"');
    expect(html).not.toContain('class="app-topbar"');
    expect(html).not.toContain('deployment-warning');
    expect(html).not.toContain('可信内网');
    expect(html).not.toContain('class="app-footer"');
    expect(html).toContain('request(`/api/downloads/${id}`)');
    expect(html).toContain("new URLSearchParams(location.search).get('id')");

    const functionSource = html.slice(
      html.indexOf('function parseDownloadId'),
      html.indexOf('async function load'),
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

  it('formats download times and preserves complete output paths', async () => {
    const html = await getPage('/downloads');
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
    const functionSource = html.slice(
      html.indexOf('function displayValue'),
      html.indexOf('function renderDownloads'),
    );
    const helpers = new Function(
      'document',
      `${functionSource}; return { displayValue, formatTimestamp };`,
    )(fakeDocument) as {
      displayValue(value: string | null): string;
      formatTimestamp(value: string | null): string;
    };
    const value = '2026-07-18T09:43:33.709Z';
    const timestamp = new Date(value);
    const pad = (part: number) => String(part).padStart(2, '0');
    const expected = `${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}-${pad(timestamp.getDate())} ${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}:${pad(timestamp.getSeconds())}`;

    expect(helpers.displayValue(null)).toBe('—');
    expect(helpers.displayValue('0s')).toBe('0s');
    expect(helpers.formatTimestamp(value)).toBe(expected);
    expect(helpers.formatTimestamp(null)).toBe('—');
    expect(helpers.formatTimestamp('invalid')).toBe('invalid');
    expect(html).toContain('formatTimestamp(download.createdAt)');
    expect(html).toContain('formatTimestamp(download.startedAt)');
    expect(html).toContain('formatTimestamp(download.finishedAt)');
    expect(html).toContain("setField(article, 'outputPath', download.outputPath)");
    expect(html).toContain("outputPath.title = download.outputPath ?? ''");
  });

  it('keeps download cards readable across desktop and mobile widths', async () => {
    const styles = await readFile(
      new URL('../../src/styles/main.scss', import.meta.url),
      'utf8',
    );

    expect(styles).toMatch(/\.download-card-identity\s*\{[^}]*flex: 1 1 24rem;/s);
    expect(styles).toMatch(/\.download-path-value\s*\{[^}]*text-overflow: ellipsis;/s);
    expect(styles).toMatch(/\.download-card-times\s*\{[^}]*grid-column: 1 \/ -1;/s);
    expect(styles).toContain('.download-source {');
    expect(styles).toContain('.download-controls {');
    expect(styles).toContain('.download-tabs {');
    expect(styles).toContain('.download-empty-state {');
    expect(styles).toContain('@media (max-width: 575.98px)');
    expect(styles).toMatch(/@media \(max-width: 575\.98px\)[\s\S]*\.download-card-header\s*\{[^}]*flex-direction: column;/);
    expect(styles).toMatch(/@media \(max-width: 575\.98px\)[\s\S]*\.download-controls\s*\{[^}]*flex-direction: column;/);
    expect(styles).toMatch(/@media \(max-width: 575\.98px\)[\s\S]*\.download-card-metrics,[\s\S]*\.download-card-details,[\s\S]*\.download-card-times\s*\{[^}]*grid-template-columns: 1fr;/);
    expect(styles).not.toMatch(/\.download-detail-value\s*\{[^}]*text-overflow: ellipsis;/s);
    expect(styles).toMatch(/\.preview-page\s*\{[^}]*width: 100dvw;[^}]*height: 100dvh;[^}]*overflow: hidden;[^}]*background:/s);
    expect(styles).toMatch(/\.download-preview\s*\{[^}]*width: 100%;[^}]*height: 100%;/s);
    expect(styles).toMatch(/\.download-preview-player\s*\{[^}]*width: 100%;[^}]*height: 100%;[^}]*object-fit: contain;[^}]*background:/s);
    expect(styles).not.toContain('.download-preview-toolbar');
    expect(styles).not.toContain('.download-preview-actions');
    expect(styles).toContain('.download-preview-error');
  });

  it('requires confirmation before page delete actions', async () => {
    const settingsHtml = await getPage('/settings');
    const downloadsHtml = await getPage('/downloads');

    expect(settingsHtml).toContain("confirm(`确认删除代理「${proxy.name}」？`)");
    expect(settingsHtml).toContain('if (!confirmed) return;');
    expect(settingsHtml).toContain("request(`/api/proxies/${proxy.id}`, 'DELETE')");

    expect(downloadsHtml).toContain("confirm(`确认永久删除下载「${download.title}」及其文件？`)");
    expect(downloadsHtml).toContain('if (!confirmed) return;');
    expect(downloadsHtml).toContain("mutateDownload(`/api/downloads/${download.id}`, 'DELETE', undefined, remove)");
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
