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
import {
  createTranslator,
  TRANSLATIONS,
  type Language,
} from '../../src/i18n.js';
import { createI18n as createBrowserI18n } from '../../src/public/i18n.js';
import { CookieAuthorizationService } from '../../src/services/cookie-authorization.js';
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
  const cookieAuthorizationService = new CookieAuthorizationService(
    join(sandbox, 'cookies'),
  );
  await cookieAuthorizationService.initialize();
  const app = createApp(
    createApiRouter(
      database,
      downloadsMountPath,
      new RuntimeCoordinator(() => undefined),
      taskManager,
      queue,
      cookieAuthorizationService,
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

async function getPage(path: string, headers?: HeadersInit): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  return response.text();
}

function browserI18n(language: Language): {
  readonly t: ReturnType<typeof createTranslator>;
  readonly formatNumber: (value: number) => string;
  readonly formatFileSize: (value: number) => string;
} {
  return createBrowserI18n(language, TRANSLATIONS[language]);
}

class ControlledNode {
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  type = '';
  href = '';
  src = '';
  title = '';
  value = '';
  ariaLabel = '';
  readonly dataset: Record<string, string> = {};
  readonly children: Array<ControlledNode | string> = [];
  private readonly listeners = new Map<string, Array<() => unknown>>();

  append(...children: Array<ControlledNode | string>): void {
    this.children.push(...children);
  }

  replaceChildren(...children: Array<ControlledNode | string>): void {
    this.children.splice(0, this.children.length, ...children);
  }

  addEventListener(type: string, listener: () => unknown): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatch(type: string): Promise<void> {
    for (const listener of this.listeners.get(type) ?? []) await listener();
  }

  setAttribute(name: string, value: string): void {
    if (name === 'aria-selected') this.ariaLabel = value;
  }

  querySelector(selector: string): ControlledNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ControlledNode[] {
    const matches = (node: ControlledNode): boolean => {
      const data = selector.match(/^\[data-([a-z-]+)(?:="([^"]+)")?\]$/);
      if (data !== null) {
        const key = data[1]!.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
        return Object.hasOwn(node.dataset, key) && (data[2] === undefined || node.dataset[key] === data[2]);
      }
      return selector.startsWith('.') && node.className.split(/\s+/).includes(selector.slice(1));
    };
    const descendants = this.children.flatMap((child) => typeof child === 'string' ? [] : [child, ...child.querySelectorAll(selector)]);
    return descendants.filter(matches);
  }
}

function controlledText(node: ControlledNode | string): string {
  return typeof node === 'string'
    ? node
    : [node.textContent, ...node.children.map(controlledText)].join(' ');
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

function taskPageHelpers(
  script: string,
  fetchTaskPage: (input: string, init?: RequestInit) => Promise<Response>,
  language: Language = 'zh-CN',
): {
  readonly nodes: ReadonlyMap<string, FakeTaskNode>;
  readonly loaded: Promise<void>;
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
  nodes.get('page-error')!.hidden = true;
  nodes.get('active-task-empty')!.hidden = true;
  nodes.get('terminal-task-empty')!.hidden = true;
  const fakeDocument = {
    createElement: () => fakeTaskNode(),
    querySelector: (selector: string) => nodes.get(selector.slice(1)),
  };
  const loadCallStart = script.indexOf('\nload().catch');
  const executableSource = script.slice(script.indexOf('const taskTypeKeys'), loadCallStart);
  const loadCall = script.slice(loadCallStart).trim();
  const i18n = browserI18n(language);
  const loaded = new Function(
    'document',
    'formatChinaTimestamp',
    'formatNumber',
    'formatApiError',
    't',
    'fetch',
    `${executableSource}; return ${loadCall}`,
  )(
    fakeDocument,
    (value: string) => value,
    i18n.formatNumber,
    (error: { code: string }) => i18n.t(`error.${error.code}` as keyof typeof TRANSLATIONS['zh-CN']),
    i18n.t,
    fetchTaskPage,
  ) as Promise<void>;
  return { nodes, loaded };
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
  const pages = [
    { contractPath: '/', path: '/', title: ['总览', 'Dashboard'], marker: ['活动任务', 'Active tasks'], shell: true },
    { contractPath: '/downloads', path: '/downloads', title: ['下载', 'Downloads'], marker: ['新建直下载', 'New direct download'], shell: true },
    { contractPath: '/channels', path: '/channels', title: ['频道', 'Channels'], marker: ['新增频道', 'Add channel'], shell: true },
    { contractPath: '/channels/:id', path: '/channels/7', title: ['频道详情', 'Channel details'], marker: ['正在载入频道资料', 'Loading channel details'], shell: true },
    { contractPath: '/notifications', path: '/notifications', title: ['新视频提醒', 'New video notifications'], marker: ['全部标记已读', 'Mark all as read'], shell: true },
    { contractPath: '/authorizations', path: '/authorizations', title: ['授权管理', 'Authorizations'], marker: ['新增授权', 'Add authorization'], shell: true },
    { contractPath: '/settings', path: '/settings', title: ['配置', 'Settings'], marker: ['全局设置', 'Global settings'], shell: true },
    { contractPath: '/database', path: '/database', title: ['数据库', 'Database'], marker: ['执行查询', 'Run query'], shell: true },
    { contractPath: '/guide', path: '/guide', title: ['系统说明', 'Guide'], marker: ['只能部署在可信内网', 'Deploy only on a trusted private network'], shell: true },
    { contractPath: '/downloads/preview', path: '/downloads/preview?id=7', title: ['下载预览', 'Download preview'], marker: ['id="preview-player"', 'id="preview-player"'], shell: false },
  ] as const;
  const languageRequests = [
    { name: 'without Cookie despite English Accept-Language', headers: { 'Accept-Language': 'en-US,en;q=0.9' }, language: 'zh-CN', index: 0 },
    { name: 'with a cleared Cookie despite English Accept-Language', headers: { Cookie: 'vidharbor_language=', 'Accept-Language': 'en' }, language: 'zh-CN', index: 0 },
    { name: 'with an invalid Cookie despite Chinese Accept-Language', headers: { Cookie: 'vidharbor_language=EN', 'Accept-Language': 'zh-CN' }, language: 'zh-CN', index: 0 },
    { name: 'with exact en despite Chinese Accept-Language', headers: { Cookie: 'vidharbor_language=en', 'Accept-Language': 'zh-CN,zh;q=0.9' }, language: 'en', index: 1 },
    { name: 'with exact zh-CN despite English Accept-Language', headers: { Cookie: 'vidharbor_language=zh-CN', 'Accept-Language': 'en' }, language: 'zh-CN', index: 0 },
  ] as const;

  it.each(languageRequests.flatMap((request) => pages.map((page) => ({ request, page }))))(
    'renders $page.contractPath $request.name',
    async ({ request, page }) => {
      const html = await getPage(page.path, request.headers);
      const catalog = TRANSLATIONS[request.language];

      expect(html).toContain(`<html lang="${request.language}">`);
      expect(html).toContain(`<title>${page.title[request.index]} · VidHarbor</title>`);
      expect(html).toContain(page.marker[request.index]);
      expect(html).toContain(`"language":"${request.language}"`);
      expect(html).toContain(`data-language-switch="${request.language}" aria-pressed="true"`);
      if (!page.shell) {
        expect(html).not.toContain('class="app-shell d-flex"');
        return;
      }
      expect(html).toContain('class="app-shell d-flex"');
      for (const [href, label] of [
        ['/', catalog['nav.dashboard']],
        ['/downloads', catalog['nav.downloads']],
        ['/channels', catalog['nav.channels']],
        ['/notifications', catalog['nav.notifications']],
        ['/authorizations', catalog['nav.authorizations']],
        ['/settings', catalog['nav.settings']],
        ['/database', catalog['nav.database']],
        ['/guide', catalog['nav.guide']],
      ]) expect(html).toContain(`href="${href}">${label}</a>`);
    },
  );

  it('switches language in place and keeps the Cookie across refresh and navigation', async () => {
    const script = (await getPublicScript('shell.js')).replace(
      "import { LANGUAGES } from './i18n.js';",
      "const LANGUAGES = ['zh-CN', 'en'];",
    );
    const english = new ControlledNode();
    english.dataset.languageSwitch = 'en';
    const chinese = new ControlledNode();
    chinese.dataset.languageSwitch = 'zh-CN';
    let writtenCookie = '';
    let reloads = 0;
    const location = {
      pathname: '/downloads/preview',
      search: '?id=7&from=channel',
      hash: '#player',
      reload: () => { reloads += 1; },
    };
    const document = {
      body: { classList: { toggle: () => undefined } },
      querySelectorAll(selector: string) {
        return selector === '[data-language-switch]' ? [chinese, english] : [];
      },
      set cookie(value: string) { writtenCookie = value; },
    };

    new Function('document', 'location', script)(document, location);
    await english.dispatch('click');

    expect(writtenCookie).toBe('vidharbor_language=en; Path=/; SameSite=Lax');
    expect(location).toMatchObject({
      pathname: '/downloads/preview',
      search: '?id=7&from=channel',
      hash: '#player',
    });
    expect(reloads).toBe(1);

    const refresh = await getPage('/downloads/preview?id=7', { Cookie: 'vidharbor_language=en' });
    const navigation = await getPage('/database', { Cookie: 'vidharbor_language=en' });
    const cleared = await getPage('/database', { Cookie: 'vidharbor_language=' });
    expect(refresh).toContain('<html lang="en">');
    expect(navigation).toContain('<html lang="en">');
    expect(cleared).toContain('<html lang="zh-CN">');
  });

  it.each(['zh-CN', 'en'] as const)('executes %s pagination with localized text and raw page callbacks', async (language) => {
    const script = (await getPublicScript('pagination.js'))
      .slice((await getPublicScript('pagination.js')).indexOf('export function'))
      .replace('export function', 'function');
    const i18n = browserI18n(language);
    const renderPagination = new Function(
      'document',
      'formatNumber',
      't',
      `${script}; return renderPagination;`,
    )(
      { createElement: () => new ControlledNode() },
      i18n.formatNumber,
      i18n.t,
    ) as (container: ControlledNode, value: Record<string, number>, onPage: (page: number) => void) => void;
    const container = new ControlledNode();
    const requested: number[] = [];

    renderPagination(container, { page: 2, pageSize: 20, totalItems: 1234, totalPages: 4 }, (page) => requested.push(page));

    expect(container.hidden).toBe(false);
    expect(controlledText(container)).toContain(i18n.t('pagination.previous'));
    expect(controlledText(container)).toContain(i18n.t('pagination.summary', {
      page: i18n.formatNumber(2),
      totalPages: i18n.formatNumber(4),
      totalItems: i18n.formatNumber(1234),
    }));
    await container.children[2]!.dispatch('click');
    expect(requested).toEqual([3]);

    renderPagination(container, { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 }, () => undefined);
    expect(container.hidden).toBe(true);
    expect(container.children).toHaveLength(0);
  });

  it.each(['zh-CN', 'en'] as const)('executes all fixed download states in %s', async (language) => {
    const script = await getPublicScript('downloads.js');
    const functionSource = script.slice(
      script.indexOf('const labelKeys'),
      script.indexOf('function renderDownloads'),
    );
    const i18n = browserI18n(language);
    const confirmations: string[] = [];
    let deleteRequests = 0;
    const helpers = new Function(
      'document',
      'formatChinaTimestamp',
      'formatApiError',
      'formatFileSize',
      'formatNumber',
      't',
      'confirm',
      'fetch',
      `${functionSource}; return { createDownloadCard, updateDownloadCard };`,
    )(
      { createElement: () => new ControlledNode() },
      (value: string) => value,
      () => '',
      i18n.formatFileSize,
      i18n.formatNumber,
      i18n.t,
      (message: string) => { confirmations.push(message); return false; },
      async () => { deleteRequests += 1; return new Response(null, { status: 204 }); },
    ) as {
      createDownloadCard(download: Record<string, unknown>): ControlledNode;
      updateDownloadCard(article: ControlledNode, previous: undefined, download: Record<string, unknown>): void;
    };
    const baseDownload = {
      id: 41,
      title: '用户标题 / User title',
      thumbnailUrl: null,
      sourceType: 'direct',
      platform: 'unknown-platform',
      sourceUrl: 'https://media.example/watch/41',
      progressPercent: 50,
      speedText: 'third-party speed',
      etaSeconds: 7,
      durationSeconds: 65,
      outputSizeBytes: 2048,
      startedAt: '2026-07-18T09:43:33.709Z',
      finishedAt: '2026-07-18T09:44:38.709Z',
      networkMode: 'direct',
      proxyName: null,
      outputPath: '/downloads/41/video.mp4',
      failureReason: 'third-party failure',
    };
    const statuses = ['pending', 'running', 'downloading', 'completed', 'failed', 'canceled', 'interrupted', 'deleting'] as const;

    for (const status of statuses) {
      const download = { ...baseDownload, status };
      const article = helpers.createDownloadCard(download);
      helpers.updateDownloadCard(article, undefined, download);
      expect(article.querySelector('[data-download-status]')?.textContent)
        .toBe(i18n.t(`status.download.${status}` as keyof typeof TRANSLATIONS['zh-CN']));
      expect(article.querySelector('[data-download-field="title"]')?.textContent).toBe(baseDownload.title);
      expect(article.querySelector('[data-download-field="platform"]')?.textContent).toBe(baseDownload.platform);
      if (status === 'failed') {
        expect(article.querySelector('[data-download-field="failureReason"]')?.textContent).toBe(baseDownload.failureReason);
      }
      if (status === 'completed') {
        const remove = article.querySelector('[data-download-actions]')?.children.at(-1);
        await remove?.dispatch('click');
        expect(confirmations.at(-1)).toBe(i18n.t('downloads.deleteConfirm', { title: baseDownload.title }));
      }
    }
    expect(() => helpers.createDownloadCard({ ...baseDownload, status: 'unknown' }))
      .toThrow('unknown download status: unknown');
    expect(deleteRequests).toBe(0);
  });

  it.each(['zh-CN', 'en'] as const)('executes channel detail states without translating business content in %s', async (language) => {
    const script = await getPublicScript('channel-detail.js');
    const functionSource = script.slice(
      script.indexOf('const downloadStatusKeys'),
      script.indexOf('function updateChannelSummary'),
    );
    const i18n = browserI18n(language);
    const helpers = new Function(
      'document',
      'formatChinaTimestamp',
      'formatApiError',
      'formatFileSize',
      'formatNumber',
      't',
      `${functionSource}; return { renderVideo, renderCheck };`,
    )(
      { createElement: () => new ControlledNode() },
      (value: string) => value,
      () => '',
      i18n.formatFileSize,
      i18n.formatNumber,
      i18n.t,
    ) as {
      renderVideo(video: Record<string, unknown>): ControlledNode;
      renderCheck(check: Record<string, unknown>): ControlledNode;
    };
    const video = {
      id: 9,
      title: '用户视频标题',
      thumbnailUrl: null,
      publishedDate: '2026-07-18',
      durationSeconds: 65,
      downloadId: 19,
      downloadOutputSizeBytes: 2048,
      downloadFinishedAt: '2026-07-18T09:43:33.709Z',
      downloadFailureReason: 'third-party failure',
      url: 'https://video.example/watch/9',
    };
    for (const status of [null, 'pending', 'running', 'downloading', 'completed', 'failed', 'canceled', 'interrupted', 'deleting'] as const) {
      const row = helpers.renderVideo({ ...video, downloadStatus: status });
      const text = controlledText(row);
      expect(text).toContain(video.title);
      expect(text).toContain(status === null
        ? i18n.t('channelDetail.notDownloaded')
        : i18n.t(`status.download.${status}` as keyof typeof TRANSLATIONS['zh-CN']));
      if (status === 'failed') expect(text).toContain(video.downloadFailureReason);
    }
    expect(() => helpers.renderVideo({ ...video, downloadStatus: 'unknown' }))
      .toThrow('unknown download status: unknown');

    for (const [kind, result] of [['initial', null], ['scheduled', 'success'], ['scheduled', 'no_updates'], ['scheduled', 'failed']] as const) {
      const row = helpers.renderCheck({ kind, result, startedAt: null, finishedAt: null, newVideoCount: 1234, failureReason: result === 'failed' ? 'platform detail' : null });
      expect(controlledText(row)).toContain(result === null
        ? i18n.t('status.check.running')
        : i18n.t(`status.check.${result}` as keyof typeof TRANSLATIONS['zh-CN']));
      if (result === 'failed') expect(controlledText(row)).toContain('platform detail');
    }
    expect(() => helpers.renderCheck({ kind: 'unknown', result: null, startedAt: null, finishedAt: null, newVideoCount: 0, failureReason: null }))
      .toThrow('unknown check type: unknown');
  });

  it.each(['zh-CN', 'en'] as const)('renders channel list states and rejects deletion in %s', async (language) => {
    const source = (await getPublicScript('channels.js'))
      .replace(/^import .*;\n/gm, '')
      .replace('load().catch((error) => showError(pageError, error));', 'return load().catch((error) => showError(pageError, error));');
    const i18n = browserI18n(language);
    const formError = new ControlledNode();
    formError.dataset.formError = '';
    const channelForm = new ControlledNode() as ControlledNode & { elements: Record<string, ControlledNode>; reset(): void };
    channelForm.append(formError);
    channelForm.elements = Object.fromEntries(['url', 'customName', 'proxyId', 'authorizationPlatform', 'checkIntervalMinutes'].map((name) => [name, new ControlledNode()]));
    channelForm.reset = () => undefined;
    const syncError = new ControlledNode();
    syncError.dataset.formError = '';
    const syncForm = new ControlledNode() as ControlledNode & { elements: Record<string, ControlledNode>; reset(): void };
    syncForm.append(syncError);
    syncForm.elements = { historyMonths: new ControlledNode() };
    syncForm.reset = () => undefined;
    const nodes = new Map<string, ControlledNode>([
      ['#channel-form', channelForm],
      ['#channel-modal', new ControlledNode()],
      ['#channel-modal-title', new ControlledNode()],
      ['[data-channel-submit]', new ControlledNode()],
      ['#initial-sync-form', syncForm],
      ['#initial-sync-modal', new ControlledNode()],
      ['#channel-page-error', new ControlledNode()],
      ['[data-channel-create]', new ControlledNode()],
      ['[data-channel-empty-create]', new ControlledNode()],
      ['#channel-list', new ControlledNode()],
      ['#channel-empty-state', new ControlledNode()],
      ['#channel-pagination', new ControlledNode()],
    ]);
    nodes.get('#channel-page-error')!.hidden = true;
    const statuses = ['pending', 'syncing', 'failed', 'succeeded'] as const;
    const results = [null, 'success', 'no_updates', 'failed'] as const;
    const channels = statuses.map((status, index) => ({
      id: index + 1,
      url: `https://www.youtube.com/channel/${index + 1}`,
      customName: `用户频道 ${index + 1}`,
      platform: 'youtube',
      proxyId: null,
      authorizationPlatform: null,
      checkIntervalMinutes: index === 0 ? null : 15,
      effectiveCheckIntervalMinutes: index === 0 ? 1234 : 5678,
      unreadNotificationCount: 1234,
      pausedAt: null,
      initialSync: { status, error: status === 'failed' ? 'third-party sync detail' : null },
      lastCheck: { result: results[index], error: results[index] === 'failed' ? 'third-party check detail' : null, nextAt: null },
    }));
    let deleteRequests = 0;
    const document = {
      createElement: () => new ControlledNode(),
      querySelector: (selector: string) => nodes.get(selector),
    };
    await new Function(
      'document',
      'location',
      'fetch',
      'bootstrap',
      'Option',
      'renderPagination',
      'formatChinaTimestamp',
      'formatApiError',
      'formatNumber',
      't',
      'confirm',
      source,
    )(
      document,
      { search: '', reload: () => undefined },
      async (path: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') deleteRequests += 1;
        if (path.startsWith('/api/channels?page=')) return new Response(JSON.stringify({ items: channels, pagination: { page: 1, pageSize: 20, totalItems: 4, totalPages: 1 } }));
        if (path === '/api/proxies') return new Response(JSON.stringify({ items: [] }));
        return new Response(JSON.stringify({ configurations: [] }));
      },
      { Modal: { getOrCreateInstance: () => ({ show: () => undefined }) } },
      function Option(this: ControlledNode, text: string, value: string) { const node = new ControlledNode(); node.textContent = text; node.value = value; return node; },
      () => undefined,
      (value: string) => value,
      () => '',
      i18n.formatNumber,
      i18n.t,
      () => false,
    );

    const list = nodes.get('#channel-list')!;
    const dom = controlledText(list);
    for (const status of statuses) {
      expect(dom).toContain(i18n.t(status === 'succeeded' ? 'status.channel.running' : `status.sync.${status}` as keyof typeof TRANSLATIONS['zh-CN']));
    }
    for (const name of channels.map((channel) => channel.customName)) expect(dom).toContain(name);
    expect(dom).toContain(i18n.t('channels.checkInterval'));
    expect(dom).toContain(i18n.t('channels.globalInterval', { minutes: i18n.formatNumber(1234) }));
    expect(dom).toContain(i18n.t('channels.overrideInterval', { minutes: i18n.formatNumber(5678) }));
    expect(dom).toContain('third-party sync detail');
    expect(dom).toContain('third-party check detail');
    const deleteButton = list.querySelectorAll('.btn-outline-danger')[0];
    await deleteButton?.dispatch('click');
    expect(deleteRequests).toBe(0);
  });

  it.each(['zh-CN', 'en'] as const)('renders notification DOM and errors in %s', async (language) => {
    const source = (await getPublicScript('notifications.js'))
      .replace(/^import .*;\n/gm, '')
      .replace('load().catch(showError);', 'return load().catch(showError);');
    const i18n = browserI18n(language);
    const nodes = new Map([
      ['#page-error', new ControlledNode()],
      ['#notification-list', new ControlledNode()],
      ['#notification-empty-state', new ControlledNode()],
      ['#mark-all-read', new ControlledNode()],
      ['#notification-pagination', new ControlledNode()],
    ]);
    nodes.get('#page-error')!.hidden = true;
    nodes.get('#notification-empty-state')!.hidden = true;
    const document = {
      createElement: () => new ControlledNode(),
      querySelector: (selector: string) => nodes.get(selector),
    };
    const payload = {
      items: [
        {
          id: 1,
          video: { title: '第三方标题', url: 'https://video.example/1', publishedDate: '2026-07-18' },
          channel: { id: 2, customName: '用户频道名' },
          createdAt: '2026-07-18T09:43:33.709Z',
          readAt: null,
        },
        {
          id: 2,
          video: { title: 'read item', url: 'https://video.example/2', publishedDate: '2026-07-17' },
          channel: { id: 3, customName: 'read channel' },
          createdAt: '2026-07-18T09:43:33.709Z',
          readAt: '2026-07-18T10:43:33.709Z',
        },
      ],
      unreadCount: 1,
      pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
    };
    await new Function(
      'document',
      'location',
      'fetch',
      'renderPagination',
      'formatChinaTimestamp',
      'formatApiError',
      't',
      source,
    )(
      document,
      { search: '' },
      async () => new Response(JSON.stringify(payload)),
      () => undefined,
      (value: string) => value,
      (error: { code: string }) => i18n.t(`error.${error.code}` as keyof typeof TRANSLATIONS['zh-CN']),
      i18n.t,
    );

    const dom = controlledText(nodes.get('#notification-list')!);
    expect(dom).toContain('第三方标题');
    expect(dom).toContain('用户频道名');
    expect(dom).toContain(i18n.t('notifications.unread'));
    expect(dom).toContain(i18n.t('notifications.markRead'));
    expect(dom).toContain(i18n.t('notifications.readAt', { time: '2026-07-18T10:43:33.709Z' }));

    await new Function(
      'document',
      'location',
      'fetch',
      'renderPagination',
      'formatChinaTimestamp',
      'formatApiError',
      't',
      source,
    )(
      document,
      { search: '' },
      async () => new Response(JSON.stringify({ error: { code: 'PERSISTENCE_ERROR', message: 'raw detail' } }), { status: 500 }),
      () => undefined,
      (value: string) => value,
      (error: { code: string }) => i18n.t(`error.${error.code}` as keyof typeof TRANSLATIONS['zh-CN']),
      i18n.t,
    );
    expect(nodes.get('#page-error')).toMatchObject({
      hidden: false,
      textContent: i18n.t('error.PERSISTENCE_ERROR'),
    });
  });

  it.each(['zh-CN', 'en'] as const)('renders database summaries while preserving cells in %s', async (language) => {
    const script = await getPublicScript('database.js');
    const functionSource = script.slice(
      script.indexOf('function renderResult'),
      script.indexOf('async function executeQuery'),
    );
    const i18n = browserI18n(language);
    const result = new ControlledNode();
    const renderResult = new Function(
      'document',
      'result',
      'formatNumber',
      't',
      `${functionSource}; return renderResult;`,
    )(
      { createElement: () => new ControlledNode() },
      result,
      i18n.formatNumber,
      i18n.t,
    ) as (columns: string[], rows: unknown[][]) => void;

    renderResult(['raw_column', 'title'], [[1234, '用户值 / user value']]);
    expect(controlledText(result)).toContain(i18n.t('database.resultSummary', {
      rows: i18n.formatNumber(1),
      columns: i18n.formatNumber(2),
    }));
    expect(controlledText(result)).toContain('raw_column');
    expect(controlledText(result)).toContain('1234');
    expect(controlledText(result)).toContain('用户值 / user value');

    renderResult(['raw_column'], []);
    expect(controlledText(result)).toContain(i18n.t('database.noData'));
  });

  it.each(['zh-CN', 'en'] as const)('generates authorization and settings state text in %s', async (language) => {
    const i18n = browserI18n(language);
    const authorizationScript = await getPublicScript('authorizations.js');
    const authorizationSource = authorizationScript.slice(
      authorizationScript.indexOf('const platformLabels'),
      authorizationScript.indexOf('const form'),
    ) + authorizationScript.slice(
      authorizationScript.indexOf('function platformLabel'),
      authorizationScript.indexOf('async function request'),
    );
    const authorization = new Function(
      't',
      `${authorizationSource}; return { platformLabel, statusLabel };`,
    )(i18n.t) as {
      platformLabel(value: string): string;
      statusLabel(value: boolean): string;
    };
    expect(authorization.platformLabel('youtube')).toBe('YouTube');
    expect(authorization.statusLabel(true)).toBe(i18n.t('authorizations.status.configured'));
    expect(() => authorization.statusLabel(false)).toThrow('unknown authorization configuration status: false');

    const settingsScript = await getPublicScript('settings.js');
    const settingsSource = settingsScript.slice(
      settingsScript.indexOf('function errorMessage'),
      settingsScript.indexOf('function showError'),
    );
    const errorMessage = new Function(
      't',
      'formatApiError',
      `${settingsSource}; return errorMessage;`,
    )(
      i18n.t,
      (error: { code: string }) => i18n.t(`error.${error.code}` as keyof typeof TRANSLATIONS['zh-CN']),
    ) as (error: Error | { code: string }) => string;
    expect(errorMessage(new Error('raw failure'))).toBe(`${i18n.t('common.failed')}: raw failure`);
    expect(errorMessage({ code: 'PERSISTENCE_ERROR' })).toBe(i18n.t('error.PERSISTENCE_ERROR'));
  });

  it('explains the complete current project contract on the guide page', async () => {
    const [html, englishHtml, chineseReadme, englishReadme] = await Promise.all([
      getPage('/guide', { Cookie: 'vidharbor_language=zh-CN' }),
      getPage('/guide', { Cookie: 'vidharbor_language=en' }),
      readFile(join(process.cwd(), 'README.md'), 'utf8'),
      readFile(join(process.cwd(), 'README.en.md'), 'utf8'),
    ]);
    const script = await getPublicScript('guide.js');
    const guideTemplate = await readFile(join(process.cwd(), 'src/views/guide.ejs'), 'utf8');
    const dockerfile = await readFile(join(process.cwd(), 'Dockerfile'), 'utf8');

    expect(html).toContain('只能部署在可信内网');
    expect(html).toContain('最近 1、3、6 或 12 个月');
    expect(html).toContain('固定为检查开始时间之前最近 1 个自然月');
    expect(html).toContain('YouTube、Bilibili、X');
    expect(html).not.toContain('Vimeo');
    expect(html).toContain('Facebook 公开单视频或 Reel');
    expect(html).toContain('抖音公开单视频地址可提交');
    expect(html).toContain('space.bilibili.com/&lt;数字UID&gt;');
    expect(html).toContain('&lt;下载挂载目录&gt;/&lt;下载ID&gt;/');
    expect(html).toContain('主媒体文件成功并通过校验，任务就算成功');
    expect(html).toContain('当前不提供');
    expect(html).toContain('class="sidebar-link sidebar-guide-link d-block active" href="/guide">系统说明</a>');
    expect(html).toContain('class="guide-layout d-grid align-items-start"');
    expect(html).toContain('id="guide-toc" class="guide-toc d-grid"');
    expect(html).toContain('id="guide-content" class="guide-markdown"');
    expect(html).toContain('<script src="/public/guide.js"></script>');
    expect(script).toContain("document.querySelectorAll('#guide-content h2')");
    expect(html).toContain('<strong>成功条件：</strong>');
    expect(html).not.toContain('<h2>界面预览</h2>');
    expect(html).not.toContain('docs/screenshots/');
    expect(chineseReadme).toContain('只能部署在可信内网');
    expect(englishReadme).toContain('Deploy only on a trusted private network');
    expect(englishHtml).toContain('Deploy only on a trusted private network');
    expect(englishHtml).toContain('<h2>Current Features</h2>');
    expect(englishHtml).not.toContain('<h2>Interface Preview</h2>');
    expect(englishHtml).not.toContain('docs/screenshots/');
    expect(englishHtml).not.toContain('只能部署在可信内网');
    expect(guideTemplate).toContain('<%- guideHtml %>');
    expect(guideTemplate).not.toContain('主媒体文件成功并通过校验');
    expect(dockerfile).toContain('COPY README.md ./');
    expect(dockerfile).toContain('/app/README.md ./README.md');
    expect(dockerfile).toContain("amd64) yt_dlp_asset='yt-dlp_linux'");
    expect(dockerfile).toContain("arm64) yt_dlp_asset='yt-dlp_linux_aarch64'");
    expect(dockerfile).toContain('node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d');
    expect(dockerfile).toContain('ARG TARGETARCH');
    expect(dockerfile).toContain('{ test -z "$TARGETARCH" || test "$architecture" = "$TARGETARCH"; }');
    expect(dockerfile).not.toContain('ARG TARGETARCH=arm64');
  });

  it('renders authorization table and form without exposing saved Cookie material', async () => {
    const sensitiveMarker = 'pages-cookie-sensitive-marker';
    const upload = await fetch(`${baseUrl}/api/authorizations/cookies/youtube`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        origin: baseUrl,
      },
      body: `.example.test\tTRUE\t/\tFALSE\t0\tsession\t${sensitiveMarker}\n`,
    });
    expect(upload.status).toBe(200);

    const [html, script] = await Promise.all([
      getPage('/authorizations'),
      getPublicScript('authorizations.js'),
    ]);
    expect(html).toContain('<title>授权管理 · VidHarbor</title>');
    expect(html).toContain('<link rel="icon" href="/public/favicon.svg" type="image/svg+xml">');
    expect(html).toContain('<link rel="icon" href="/public/favicon.ico" sizes="any">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/public/apple-touch-icon.png">');
    expect(html).toContain('class="sidebar-link d-block active" href="/authorizations">授权管理</a>');
    expect(html).toContain('data-authorization-create>新增授权</button>');
    expect(html).toContain('class="authorization-page-heading d-flex flex-column flex-lg-row align-items-stretch align-items-lg-end justify-content-between gap-3 mb-4"');
    expect(html).toContain('<table class="table align-middle authorization-table">');
    expect(html).toContain('<th scope="col">平台</th>');
    expect(html).toContain('<th scope="col">状态</th>');
    expect(html).toContain('<th scope="col">更新时间</th>');
    expect(html).toContain('<th scope="col">操作</th>');
    expect(html).toContain('<tbody id="authorization-list"></tbody>');
    expect(html).toContain('id="authorization-modal"');
    expect(html).toContain('data-bs-backdrop="static"');
    expect(html).toContain('<form id="authorization-form" class="modal-content authorization-modal-form">');
    expect(html).toContain('class="modal-body d-grid gap-3"');
    expect(html).toContain('id="authorization-platform" name="platform"');
    expect(html.match(/name="cookieFile"/g)).toHaveLength(1);
    expect(html).toContain('删除会立即移除文件且无法恢复');
    expect(html).toContain('使用范围');
    expect(html).toContain('频道可选择同平台授权用于首次同步、手动检查和定时检查');
    expect(html).toContain('<script type="module" src="/public/authorizations.js"></script>');
    expect(html).not.toContain('Vimeo');
    expect(html.includes(sensitiveMarker)).toBe(false);
    expect(html).not.toContain('authorization-platform-card');
    expect(html).not.toMatch(/data-authorization-(?:domain|cookie-name|cookie-value|file-name|path|preview|download)/);
    expect(html).not.toContain('预览 Cookie');
    expect(html).not.toContain('下载 Cookie');
    expect(html).not.toMatch(/<a[^>]+\bdownload(?:\s|=|>)/);
    expect(script).toContain("statusBadge.className = 'authorization-status rounded-pill'");
    expect(script).toContain("actions.className = 'authorization-actions d-flex align-items-center flex-nowrap flex-sm-wrap'");
  });

  it.each([
    {
      language: 'zh-CN',
      beforeLink: '只在可信设备上登录目标平台，可使用',
      afterLink: '从 Chrome/Edge 当前登录会话导出 Netscape 格式文件。',
      upload: '新增授权时选择平台并上传文件；编辑授权时重新上传完整文件。系统不会读取浏览器资料目录、代替你登录、转换其他授权格式或验证远端有效性。',
      credential: 'Cookie 等同账号登录凭据。不要通过聊天、工单、截图、日志或公开文件传递原文；不再需要或怀疑泄露时，请删除授权或重新导出后替换。',
      disclaimer: '“已配置”仅表示文件已保存且格式正确，不代表登录态当前有效。',
    },
    {
      language: 'en',
      beforeLink: 'Sign in to the target platform only on a trusted device. You may use',
      afterLink: 'to export a Netscape-format file from the current Chrome/Edge signed-in session.',
      upload: 'Choose a platform and upload a file when adding an authorization; upload the complete file again when editing. The system does not read browser profile directories, sign in on your behalf, convert other authorization formats, or validate the authorization remotely.',
      credential: 'Cookie data is equivalent to account sign-in credentials. Do not share its contents through chats, issues, screenshots, logs, or public files. Delete the authorization when it is no longer needed, or replace it with a fresh export if exposure is suspected.',
      disclaimer: '“Configured” only means the file was saved and its format is valid; it does not mean the sign-in session remains valid.',
    },
  ] as const)('renders $language authorization safety copy from the catalog', async ({ language, beforeLink, afterLink, upload, credential, disclaimer }) => {
    const html = await getPage('/authorizations', { Cookie: `vidharbor_language=${language}` });
    const link = '<a href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc" target="_blank" rel="noopener noreferrer">Get cookies.txt LOCALLY</a>';

    expect(html).toContain(`<li>${beforeLink} ${link} ${afterLink}</li>`);
    expect(html).toContain(`<li>${upload}</li>`);
    expect(html).toContain(`<li>${credential}</li>`);
    expect(html).toContain(`<strong>${disclaimer}</strong>`);
  });

  it('keeps authorization safety translations as plain text', () => {
    const keys = [
      'authorizations.safetyExportBeforeLink',
      'authorizations.safetyExportAfterLink',
      'authorizations.safetyUpload',
      'authorizations.safetyCredential',
      'authorizations.safetyConfiguredDisclaimer',
    ] as const;

    for (const catalog of Object.values(TRANSLATIONS)) {
      for (const key of keys) expect(catalog[key]).not.toMatch(/<|https?:\/\/|target=|rel=/);
    }
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
    expect(channelsHtml).toContain('<form id="channel-form" class="modal-content">');
    expect(channelsHtml).toContain('支持 YouTube 频道和 Bilibili UP 主空间');
    expect(channelsScript).toContain("bilibili: 'Bilibili'");
    expect(channelsScript).toContain('openChannelCreateModal()');
    expect(channelsScript).toContain('openChannelEditModal(channel)');
    expect(channelsHtml).toContain('>新增频道</button>');
    expect(channelsHtml).toContain('id="channel-empty-state" class="channel-empty-state position-relative overflow-hidden text-center"');
    expect(channelsHtml).toContain('class="channel-empty-mark position-relative d-grid rounded-circle"');
    expect(channelsHtml).toContain('class="mb-0" id="channel-empty-title"');
    expect(channelsHtml).toContain('从一个频道开始');
    expect(channelsHtml).toContain('data-channel-empty-create>添加第一个频道</button>');
    expect(channelsScript).toContain("document.querySelector('[data-channel-empty-create]')");
    expect(channelsScript).toContain('emptyState.hidden = false');
    expect(channelsHtml).not.toContain('已添加频道');
    expect(channelsHtml).toContain('id="channel-list" class="row row-cols-1 row-cols-md-2 row-cols-xl-3 g-4"');
    expect(channelsScript).toContain("card.className = 'card h-100 channel-card'");
    expect(channelsScript).toContain("card.setAttribute('role', 'link')");
    expect(channelsScript).toContain("window.open(`/channels/${channel.id}`, '_blank', 'noopener')");
    expect(channelsScript).toContain("event.target.closest('a, button, input, select, textarea, label')");
    expect(channelsScript).toContain("link.target = '_blank'; link.rel = 'noopener'");
    expect(channelsScript).toContain("confirm(t('channels.deleteConfirm', { name: channel.customName }))");
    expect(channelsScript).toContain("request(`/api/channels/${channel.id}`, 'DELETE')");
    expect(paginationScript).toContain('container.hidden = value.totalItems === 0');
    expect(paginationScript).toContain("pages.className = 'pagination-pages d-flex align-items-center'");
    expect(channelsScript).toContain('formatChinaTimestamp(channel.lastCheck.nextAt)');
    expect(channelsHtml).not.toContain('<table');
    expect(channelsHtml).toContain('name="authorizationPlatform"');
    expect(channelsHtml).toContain('仅可选择与频道相同平台的授权');
    expect(channelsScript).toContain("request('/api/authorizations/cookies')");
    expect(channelsScript).toContain('authorizationPlatform');
    expect(channelsHtml).not.toContain('data-channel-edit-modal-root');
    expect(channelsHtml).not.toContain('buildChannelEditModal');
    expect(channelsHtml).not.toContain('channel-create-modal');
    expect(channelsHtml).not.toContain('id="channel-create-form" class="row g-3"');
    expect(channelsHtml).not.toContain('新增并同步');
    expect(channelsHtml).toContain('id="initial-sync-modal"');
    expect(channelsHtml).toContain('<option value="1">最近 1 个月</option>');
    expect(channelsHtml).toContain('<option value="12">最近 1 年</option>');
    expect(channelsScript).toContain("request(`/api/channels/${initialSyncChannelId}/initial-sync`, 'POST'");
    expect(channelsScript).toContain("submit.textContent = t('channels.syncing')");

    expect(settingsHtml).toContain('data-bs-target="#proxy-modal"');
    expect(settingsHtml).toContain('id="proxy-modal"');
    expect(settingsHtml).toContain('id="proxy-modal-title"');
    expect(settingsHtml).toContain('id="proxy-form"');
    expect(settingsScript).toContain('openProxyCreateModal()');
    expect(settingsScript).toContain('openProxyEditModal(proxy)');
    expect(settingsHtml).toContain('<form id="proxy-form" class="modal-content proxy-modal-form">');
    expect(settingsHtml).not.toContain('data-proxy-edit-modal-root');
    expect(settingsHtml).not.toContain('buildProxyEditModal');
    expect(settingsHtml).not.toContain('proxy-create-modal');
    expect(settingsHtml).not.toContain('id="proxy-create-form"');
  });

  it.each([
    ['zh-CN', '沿用频道代理'],
    ['en', 'Use channel proxy'],
  ] as const)('renders the channel proxy strategy with its fixed value in %s', async (language, label) => {
    const html = await getPage('/channels/7', { Cookie: `vidharbor_language=${language}` });

    expect(html).toContain(`<option value="channel">${label}</option>`);
  });

  it('submits only explicitly selected channel videos', async () => {
    const html = await getPage('/channels/7');
    const script = await getPublicScript('channel-detail.js');

    expect(html).toContain('id="download-form"');
    expect(html).toContain('class="channel-detail-hero position-relative overflow-hidden mb-4"');
    expect(html).toContain('class="channel-detail-heading d-flex flex-column flex-md-row align-items-start align-items-md-end justify-content-between gap-4"');
    expect(html).toContain('role="tablist" aria-label="频道详情"');
    expect(html).toContain('class="channel-detail-tabs nav nav-pills d-flex mb-3"');
    expect(html).toContain('class="channel-detail-tab nav-link active"');
    expect(html).toContain('data-channel-tab="videos">视频列表</button>');
    expect(html).toContain('data-channel-tab="checks">检查记录</button>');
    expect(html).toContain('data-channel-panel="videos"');
    expect(html).toContain('data-channel-panel="checks" hidden');
    expect(html).toContain('class="channel-video-toolbar d-grid align-items-end mb-3"');
    expect(html).toMatch(/class="channel-proxy-field"[\s\S]*class="channel-filter-field"[\s\S]*class="channel-selection-action d-grid"/);
    expect(html).toContain('id="video-list"');
    expect(html).toContain('id="check-list"');
    expect(html).toContain('id="video-empty-state" class="channel-table-empty p-5 text-center"');
    expect(script).toContain("identity.className = 'channel-video-identity d-flex align-items-center gap-3'");
    expect(script).toContain("visual.className = 'channel-video-thumbnail d-grid overflow-hidden rounded-3'");
    expect(script).toContain("downloadSummary.className = 'channel-download-summary d-grid'");
    expect(script).toContain("actions.className = 'channel-download-links d-flex gap-3'");
    expect(script).toContain("selectionCell.className = 'channel-select-column text-center'");
    expect(html).toContain('class="table channel-detail-table channel-check-table align-middle mb-0"');
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html).not.toContain('返回频道');
    expect(html).not.toContain('channel-back-link');
    expect(html).toContain('data-channel-id="7"');
    expect(script).toContain("button.classList.toggle('active', active)");
    expect(script).not.toContain("button.classList.toggle('is-active', active)");
    expect(script).toContain("const row = document.createElement('tr')");
    expect(script).toContain("image.referrerPolicy = 'no-referrer'");
    expect(script).toContain('setChannelTab(button.dataset.channelTab)');
    expect(script).toContain("pending: 'status.download.pending'");
    expect(script).toContain("completed: 'status.download.completed'");
    expect(script).toContain("interrupted: 'status.download.interrupted'");
    expect(script).toContain("deleting: 'status.download.deleting'");
    expect(script).toContain("video.downloadStatus === null ? t('channelDetail.notDownloaded') : t(fixedValue(downloadStatusKeys, video.downloadStatus, 'download status'))");
    expect(script).toContain("video.downloadStatus === 'completed'");
    expect(script).toContain(
      "['pending', 'running', 'downloading', 'completed', 'deleting'].includes(video.downloadStatus)",
    );
    expect(script).toContain('formatBytes(video.downloadOutputSizeBytes)');
    expect(script).toContain('formatCompletedAt(video.downloadFinishedAt)');
    expect(script).toContain('`/downloads/preview?id=${video.downloadId}`');
    expect(script).toContain('`/api/downloads/${video.downloadId}/file`');
    expect(script).toContain('video.downloadFailureReason');
    expect(html).toContain('name="proxyId"');
    expect(script).toContain("request('/api/proxies')");
    expect(script).toContain("checkbox.name = 'videoIds'");
    expect(script).toContain(
      "form.querySelectorAll('input[name=\"videoIds\"]:checked')",
    );
    expect(script).toContain(
      "request('/api/downloads/channel', 'POST', { videoIds, proxyId: channelProxyId() })",
    );
    expect(html.replace(/<script id="vidharbor-i18n"[\s\S]*?<\/script>/, '')).not.toMatch(/自动选择|自动下载|删除频道|手动检查/);
  });

  it('renders notifications as a table with channel, video, and read actions', async () => {
    const html = await getPage('/notifications');
    const script = await getPublicScript('notifications.js');

    expect(script).toContain('request(`/api/notifications?page=${requestedPage}`)');
    expect(html).toContain('<table class="table channel-detail-table notification-table align-middle mb-0">');
    expect(html).toContain('<th scope="col">视频</th><th scope="col">频道</th><th scope="col">发布日期</th><th scope="col">创建时间</th><th scope="col">状态</th><th scope="col">操作</th>');
    expect(script).toContain("const row = document.createElement('tr')");
    expect(script).toContain("row.append(videoCell, channelCell, publishedCell, createdCell, stateCell, actionCell)");
    expect(script).toContain('`/channels/${notification.channel.id}`');
    expect(script).toContain('notification.video.url');
    expect(script).toContain("videoLink.className = 'd-block'");
    expect(html).toContain('id="notification-empty-state" class="channel-table-empty p-5 text-center"');
    expect(script).toContain('notification.video.title');
    expect(script).toContain('notification.video.publishedDate');
    expect(script).toContain('formatChinaTimestamp(notification.createdAt)');
    expect(script).toContain('formatChinaTimestamp(notification.readAt)');
    expect(script).toContain("t('notifications.unread')");
    expect(script).toContain("t('notifications.markRead')");
  });

  it('renders direct download form with progressive optional groups', async () => {
    const html = await getPage('/downloads');

    expect(html).toContain('data-bs-target="#direct-download-modal"');
    expect(html).toContain('class="download-page-heading d-flex flex-column flex-sm-row align-items-stretch align-items-sm-end justify-content-between mb-4"');
    expect(html).toContain('class="download-controls d-flex flex-column flex-sm-row align-items-stretch align-items-sm-center justify-content-between gap-3"');
    expect(html).toContain('class="badge rounded-pill d-inline-grid" data-download-count="completed"');
    expect(html).toContain('id="direct-download-modal"');
    expect(html).toContain('class="modal-dialog modal-dialog-centered modal-lg modal-dialog-scrollable"');
    expect(html).toContain('<form id="direct-download-form" class="modal-content form-stack direct-download-form">');
    expect(html).toContain('class="card direct-form-section border rounded-4 bg-white shadow-sm"');
    expect(html).toContain('class="row g-3"');
    expect(html).toContain('class="col-12 col-sm-6"');
    expect(html).not.toContain('class="direct-form-grid"');
    expect(html).toContain('class="card direct-advanced-options border rounded-4 bg-white shadow-sm"');
    expect(html).toContain('class="d-flex align-items-start align-items-sm-center justify-content-between gap-3 py-3"');
    expect(html).toContain('class="modal-body d-grid gap-3"');
    expect(html).toContain('class="direct-advanced-content d-grid border-top"');
    expect(html).toContain('<strong>高级选项</strong>');
    expect(html).toContain('起始时间和结束时间需要同时填写');
    expect(html).toContain('>转码格式</label>');
    expect(html).toContain('<div class="col-12 col-sm-6"><label class="form-label" for="direct-quality">');
    expect(html).toContain('<div class="col-12 col-sm-6"><label class="form-label" for="direct-codec">');
    expect(html).toContain('class="direct-option d-flex align-items-start gap-3"');
    expect(html).toContain('class="form-check-input flex-shrink-0" type="checkbox" name="writeSubtitles"');
    expect(html).toContain('<div class="col-12 col-sm-6"><label class="form-label" for="direct-time-start">');
    expect(html).toContain('<div class="col-12 col-sm-6"><label class="form-label" for="direct-time-end">');
    expect(html).toContain('id="direct-quality" name="quality"><option value="">不限制</option>');
    expect(html).toContain('4320p（8K）');
    expect(html).toContain('id="direct-codec" name="codec"><option value="">不转码</option>');
    expect(html).toContain('<optgroup label="视频">');
    expect(html).toContain('<optgroup label="音频">');
    expect(html).not.toContain('id="direct-quality" name="quality" placeholder=');
    expect(html).not.toContain('id="direct-codec" name="codec" placeholder=');
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
    expect(html).not.toContain('Vimeo');
    expect(html).toContain('name="proxyId"');
    expect(script).toContain("request('/api/proxies')");
    expect(html).not.toContain('name="targetSubdirectory"');
    expect(html).not.toContain('name="writeThumbnail"');
    expect(html).not.toContain('name="filenamePreset"');
    expect(html).toContain('name="mediaType"');
    expect(html).not.toContain('name="format"');
    expect(html).toContain('name="quality"');
    expect(html).not.toContain('name="splitChapters"');
    expect(script).toContain('advancedOptions(form)');
    expect(script).toContain('format: null');
    expect(script).toContain('splitChapters: false');
    expect(script).not.toContain('filenamePreset');
    expect(script).toContain("request('/api/downloads/direct', 'POST', { url: form.elements.url.value, proxyId: nullableNumber(form.elements.proxyId.value), advancedOptions: advancedOptions(form) })");
    expect(script).toContain("let selectedTab = 'completed'");
    expect(script).toContain("facebook: 'Facebook'");
    expect(script).toContain("douyin: '抖音'");
    expect(script).toContain("thumbnail.referrerPolicy = 'no-referrer'");
    expect(html).not.toMatch(/name="(?:autoplay|autoDownload)"/);
    expect(html).not.toContain('proxy.url');
  });

  it('renders proxy create and edit forms in the requested grouped layout', async () => {
    const html = await getPage('/settings');
    const script = await getPublicScript('settings.js');

    expect(html).toContain('class="modal-content proxy-modal-form"');
    expect(html).toContain('class="proxy-field-full"');
    expect(html).not.toContain('class="proxy-field-pair"');
    expect(html).toContain('class="row g-3"');
    expect(html).toContain('class="col-12 col-sm-6"');
    expect(html).toContain('id="proxy-protocol"');
    expect(html).toContain('id="proxy-host"');
    expect(html).toContain('id="proxy-port"');
    expect(html).toContain('id="proxy-modal"');
    expect(html).toContain('id="proxy-form"');
    expect(html).toContain('id="proxy-table"');
    expect(html).toContain('<th>名称</th><th>协议</th><th>主机</th><th>端口</th><th>用户名</th><th>密码</th><th>操作</th>');
    expect(html).toContain('tbody id="proxy-list"');
    expect(script).toContain('proxy.maskedPassword');
    expect(html).not.toContain('id="proxy-create-form"');
  });

  it('displays the fixed download root without submitting it as settings input', async () => {
    const html = await getPage('/settings');
    const script = await getPublicScript('settings.js');

    expect(html).toContain('id="downloadRoot" readonly');
    expect(html).toContain('由部署配置固定，不能在此修改。');
    expect(script).toContain("document.querySelector('#downloadRoot').value = settings.downloadRoot");
    expect(script).not.toContain('downloadRoot: form.elements.downloadRoot.value');
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

    expect(html).toContain('id="download-list" class="download-list d-grid gap-3 mt-3"');
    expect(script).toContain("article.className = 'download-card border rounded-4'");
    expect(script).toContain("header.className = 'download-card-header d-flex flex-column flex-sm-row align-items-start justify-content-between gap-3'");
    expect(script).toContain("metrics.className = 'download-card-metrics d-grid gap-3 mt-3 border-top'");
    expect(script).toContain("failure = detail(t('field.failureReason'), 'failureReason', 'download-card-failure border-top')");
    expect(script).toContain("meta.className = 'download-card-meta d-flex flex-wrap gap-2 mt-2'");
    expect(script).toContain("actions.className = 'download-card-actions d-flex flex-wrap gap-2 flex-shrink-0'");
    expect(script).toContain("const source = fieldElement('span', 'badge download-source'");
    expect(script).toContain("const platform = fieldElement('span', 'badge download-platform'");
    expect(html).not.toContain('<thead>');
    expect(html).not.toContain('<th>标题</th>');
    expect(script).toContain("pending: 'status.download.pending'");
    expect(script).toContain("running: 'status.download.running'");
    expect(script).toContain("downloading: 'status.download.downloading'");
    expect(script).toContain("completed: 'status.download.completed'");
    expect(script).toContain("failed: 'status.download.failed'");
    expect(script).toContain("canceled: 'status.download.canceled'");
    expect(script).toContain("interrupted: 'status.download.interrupted'");
    expect(script).toContain("download.sourceType === 'channel' ? 'downloads.source.channel' : 'downloads.source.direct'");
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
    expect(script).toContain("detail(t('downloads.totalDuration'), 'durationSeconds')");
    expect(script).toContain("detail(t('field.fileSize'), 'outputSizeBytes')");
    expect(script).toContain("detail(t('downloads.elapsed'), 'downloadElapsedSeconds')");
    expect(script).toContain("detail(t('field.finishedAt'), 'finishedAt')");
    expect(script).toContain("detail(t('field.storagePath'), 'outputPath', 'download-card-storage')");
    expect(script).toContain('download.proxyName');
    expect(script).toContain("download.networkMode === 'direct' ? t('common.direct') : download.proxyName");
    expect(script).toContain("download.status === 'pending' || download.status === 'running' || download.status === 'downloading'");
    expect(script).toContain("mutateDownload(`/api/downloads/${download.id}/cancel`, 'POST', {}, cancel)");
    expect(script).toContain("download.status === 'failed' || download.status === 'canceled' || download.status === 'interrupted'");
    expect(script).toContain("mutateDownload(`/api/downloads/${download.id}/retry`, 'POST', {}, retry)");
    expect(script).toContain('if (trigger.disabled) return;');
    expect(script).toContain('trigger.disabled = true;');
    expect(script).toContain('if (trigger.isConnected) trigger.disabled = false;');
    expect(script).toContain("download.status === 'completed' || download.status === 'failed' || download.status === 'canceled' || download.status === 'interrupted'");
    expect(script).toContain("confirm(t('downloads.deleteConfirm', { title: download.title }))");
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
    expect(html.replace(/<script id="vidharbor-i18n"[\s\S]*?<\/script>/, '')).not.toMatch(/自动下载|播放/);

    const requestSource = script.slice(
      script.indexOf('async function request'),
      script.indexOf('function displayValue'),
    );
    const requestWith = (fetchDownload: typeof fetch) => new Function(
      'fetch',
      `${requestSource}; return request;`,
    )(fetchDownload) as (path: string, method?: string, body?: unknown) => Promise<unknown>;
    await expect(requestWith(async () => new Response(null, { status: 202 }))('/retry', 'POST', {}))
      .resolves.toBeNull();
    await expect(requestWith(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }))('/direct', 'POST', {})).resolves.toEqual({ accepted: true });
  });

  it('renders historical Vimeo and unknown download platform values', async () => {
    const script = await getPublicScript('downloads.js');
    const platformField = { textContent: '' };
    const thumbnail = { hidden: false, src: '' };
    const article = {
      querySelector(selector: string) {
        if (selector === '[data-download-field="platform"]') return platformField;
        if (selector === '.download-card-thumbnail') return thumbnail;
        return null;
      },
    };
    const functionSource = script.slice(
      script.indexOf('const labelKeys'),
      script.indexOf('function renderDownloads'),
    );
    const i18n = browserI18n('zh-CN');
    const { updateDownloadCard } = new Function(
      'document',
      'formatChinaTimestamp',
      'formatFileSize',
      'formatNumber',
      'formatApiError',
      't',
      `${functionSource}; return { updateDownloadCard };`,
    )({}, (value: string) => value, i18n.formatFileSize, i18n.formatNumber, () => '', i18n.t) as {
      updateDownloadCard(
        articleNode: typeof article,
        previous: Record<string, unknown>,
        download: Record<string, unknown>,
      ): void;
    };
    const download = {
      title: 'Historical download',
      thumbnailUrl: null,
      sourceType: 'direct',
      progressPercent: null,
      speedText: null,
      etaSeconds: null,
      durationSeconds: null,
      outputSizeBytes: null,
      startedAt: null,
      finishedAt: null,
      networkMode: 'direct',
      proxyName: null,
      outputPath: null,
      failureReason: null,
      status: 'pending',
    };

    updateDownloadCard(article, { status: 'pending' }, { ...download, platform: 'vimeo' });
    expect(platformField.textContent).toBe('Vimeo');

    updateDownloadCard(
      article,
      { status: 'pending' },
      { ...download, platform: 'unknown-platform' },
    );
    expect(platformField.textContent).toBe('unknown-platform');
  });

  it('filters downloads by title and exposes distinct tab and empty-state contracts', async () => {
    const html = await getPage('/downloads');
    const script = await getPublicScript('downloads.js');

    expect(html).toContain('id="download-search" type="search" placeholder="搜索下载标题"');
    expect(html).toContain('role="tablist" aria-label="状态"');
    expect(html).toContain('class="download-tabs nav nav-pills d-flex flex-nowrap gap-1 flex-shrink-0"');
    expect(html).toContain('class="download-search position-relative"');
    expect(html).toContain('class="download-tab nav-link" type="button" role="tab" aria-selected="false" aria-controls="download-list" data-download-tab="active"');
    expect(html).toContain('class="download-tab nav-link active" type="button" role="tab" aria-selected="true" aria-controls="download-list" data-download-tab="completed"');
    expect(html).toContain('class="download-tab nav-link" type="button" role="tab" aria-selected="false" aria-controls="download-list" data-download-tab="failed"');
    expect(script).toContain("let selectedTab = 'completed'");
    expect(script).toContain("button.classList.toggle('active', active)");
    expect(html).toContain('id="download-empty-state" class="download-empty-state position-relative overflow-hidden text-center mt-3"');
    expect(html).toContain('class="download-empty-mark d-inline-grid"');
    expect(html).toContain('data-empty-title');
    expect(html).toContain('data-empty-description');
    expect(html).toContain('data-empty-action');

    const functionSource = script.slice(
      script.indexOf('function emptyStateFor'),
      script.indexOf('function setSelectedTab'),
    );
    const i18n = browserI18n('zh-CN');
    const helpers = new Function(
      't',
      `${functionSource}; return { emptyStateFor };`,
    )(i18n.t) as {
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

    expect(html).toContain('<body class="preview-page overflow-hidden">');
    expect(html).toContain('<main class="download-preview position-relative w-100 h-100">');
    expect(html).toContain('class="download-preview-player d-block w-100 h-100"');
    expect(html).toContain('class="download-preview-error position-absolute m-0 text-center"');
    expect(html).toContain('id="preview-player"');
    expect(html).toContain('id="preview-error"');
    expect(html).toContain('controls preload="metadata" hidden');
    expect(script).toContain('page.title = download.title');
    expect(html).not.toContain('download-preview-toolbar');
    expect(html).not.toContain('preview-download');
    expect(html).not.toContain('preview-original');
    expect(script).toContain("t('preview.playbackFailed')");
    expect(script).toContain("error instanceof Error ? `${t('common.failed')}: ${error.message}`");
    expect(script).toContain("error.code === 'DOWNLOAD_NOT_FOUND' ? t('preview.notFound') : formatApiError(error)");
    expect(html).not.toContain('class="app-shell d-flex"');
    expect(html).not.toContain('class="app-sidebar d-flex');
    expect(html).not.toContain('class="app-topbar d-flex');
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
      't',
      `${functionSource}; return { renderPreview };`,
    )(browserI18n('zh-CN').t) as {
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

  it.each(['zh-CN', 'en'] as const)('executes localized preview states in %s', async (language) => {
    const script = await getPublicScript('download-preview.js');
    const functionSource = script.slice(
      script.indexOf('function parseDownloadId'),
      script.indexOf('async function load'),
    );
    const i18n = browserI18n(language);
    const renderPreview = new Function(
      't',
      `${functionSource}; return renderPreview;`,
    )(i18n.t) as (
      download: Record<string, unknown>,
      rawId: string | null,
      player: Record<string, unknown>,
      page: Record<string, unknown>,
      region: Record<string, unknown>,
    ) => void;

    for (const [rawId, download, message] of [
      ['invalid', { status: 'pending' }, i18n.t('preview.invalidId')],
      ['7', { id: 7, status: 'pending' }, i18n.t('preview.unavailable')],
    ] as const) {
      const region = { textContent: '', hidden: true };
      renderPreview(download, rawId, { src: '', hidden: true }, { title: '' }, region);
      expect(region).toEqual({ textContent: message, hidden: false });
    }
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
      'formatFileSize',
      't',
      `${functionSource}; return { displayValue, formatTimestamp, formatDuration, downloadElapsedSeconds, formatBytes };`,
    )(fakeDocument, timeHelpers.formatChinaTimestamp, browserI18n('zh-CN').formatFileSize, browserI18n('zh-CN').t) as {
      displayValue(value: string | null): string;
      formatTimestamp(value: string | null): string;
      formatDuration(value: number | null): string;
      downloadElapsedSeconds(startedAt: string | null, finishedAt: string | null): number | null;
      formatBytes(value: number | null): string;
    };
    const value = '2026-07-18T09:43:33.709Z';

    expect(helpers.displayValue(null)).toBe('—');
    expect(helpers.displayValue('0s')).toBe('0s');
    expect(helpers.formatTimestamp(value)).toBe('2026/07/18 17:43:33');
    expect(helpers.formatTimestamp(null)).toBe('—');
    expect(helpers.formatTimestamp('invalid')).toBe('invalid');
    expect(helpers.downloadElapsedSeconds(
      '2026-07-18T08:42:32.000Z',
      '2026-07-18T09:43:33.000Z',
    )).toBe(3661);
    expect(helpers.downloadElapsedSeconds(null, value)).toBeNull();
    expect(helpers.formatDuration(3661)).toBe('01:01:01');
    expect(helpers.formatDuration(null)).toBe('—');
    expect(helpers.formatBytes(2048)).toBe('2 KiB');
    expect(helpers.formatBytes(null)).toBe('—');
    expect(script).toContain('formatTimestamp(download.startedAt)');
    expect(script).toContain('formatTimestamp(download.finishedAt)');
    expect(script).toContain("setField(article, 'outputSizeBytes', formatBytes(download.outputSizeBytes))");
    expect(script).toContain("setField(article, 'downloadElapsedSeconds', formatDuration(downloadElapsedSeconds(download.startedAt, download.finishedAt)))");
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

  it.each([
    ['zh-CN', '2026/07/18 17:43:33'],
    ['en', '07/18/2026, 17:43:33'],
  ] as const)('formats a fixed Shanghai instant in %s without changing the input', async (language, expected) => {
    const value = '2026-07-18T09:43:33.709Z';
    const script = (await getPublicScript('time.js'))
      .replace('export function', 'function')
      .replace("globalThis.document?.documentElement.lang ?? 'zh-CN'", JSON.stringify(language));
    const formatChinaTimestamp = new Function(
      `${script}; return formatChinaTimestamp;`,
    )() as (timestamp: string) => string;

    expect(formatChinaTimestamp(value)).toBe(expected);
    expect(formatChinaTimestamp('invalid')).toBe('invalid');
    expect(value).toBe('2026-07-18T09:43:33.709Z');
  });

  it('renders the task snapshot on the dashboard with fixed tables and empty states', async () => {
    const html = await getPage('/');
    const dashboardScript = await getPublicScript('dashboard.js');
    const script = await getPublicScript('yt-dlp-tasks.js');
    const removedPage = await fetch(`${baseUrl}/yt-dlp-tasks`);

    expect(html).toContain('<title>总览 · VidHarbor</title>');
    expect(html).not.toContain('href="/yt-dlp-tasks">任务状态</a>');
    expect(removedPage.status).toBe(404);
    expect(html).not.toContain('id="dashboard-pagination"');
    expect(dashboardScript).toContain("fetch('/api/channels/updates'");
    expect(dashboardScript).not.toContain('renderPagination');
    expect(dashboardScript).not.toContain('requestedPage');
    expect(dashboardScript).not.toContain('当前没有发现更新的频道。');
    expect(dashboardScript).toContain('if (body.items.length === 0) return;');
    expect(html).toContain('<h2 class="task-section-title mb-0" id="active-tasks-title">活动任务</h2>');
    expect(html).toContain('<h2 class="task-section-title mb-0" id="terminal-tasks-title">最近已结束任务</h2>');
    expect(html.match(/<table class="table yt-dlp-tasks-table align-middle mb-0">/g)).toHaveLength(2);
    expect(html.match(/<th scope="col">ID<\/th><th scope="col">类型<\/th><th scope="col">状态<\/th><th scope="col">创建时间<\/th><th scope="col">开始时间<\/th><th scope="col">结束时间<\/th><th scope="col">失败原因<\/th>/g)).toHaveLength(2);
    expect(html).toContain('id="active-task-empty" class="yt-dlp-tasks-empty p-5 px-3 border-top text-body-secondary text-center" role="status" hidden>当前没有排队或运行中的任务。</div>');
    expect(html).toContain('id="terminal-task-empty" class="yt-dlp-tasks-empty p-5 px-3 border-top text-body-secondary text-center" role="status" hidden>当前没有已结束的任务。</div>');
    expect(html).toContain('<script type="module" src="/public/yt-dlp-tasks.js"></script>');

    expect(script.match(/fetch\('\/api\/yt-dlp\/tasks'/g)).toHaveLength(1);
    expect(script).toContain("fetch('/api/yt-dlp/tasks', { credentials: 'same-origin' })");
    expect(script).toContain("if (!Array.isArray(body.tasks)) throw new Error('任务快照格式错误')");
    expect(script).not.toMatch(/setInterval|setTimeout|WebSocket|EventSource/);
    expect(script).not.toContain('/cancel');
    expect(script).not.toContain('/api/downloads');
    expect(script).not.toContain('/api/channels');

    const helpers = taskPageHelpers(
      script,
      async () => new Response(JSON.stringify({ tasks: [] })),
    );
    await helpers.loaded;
    expect(helpers.nodes.get('active-task-empty')).toMatchObject({ hidden: false });
    expect(helpers.nodes.get('terminal-task-empty')).toMatchObject({ hidden: false });
    expect(helpers.nodes.get('active-task-count')?.textContent).toBe('0');
    expect(helpers.nodes.get('terminal-task-count')?.textContent).toBe('0');
  });

  it('renders dashboard task state and third-party failure detail in English', async () => {
    const tasks: YtDlpTaskSnapshot[] = [
      { id: 1, type: 'media_download', status: 'queued', createdAt: '2026-07-19T00:00:00.000Z', startedAt: null, finishedAt: null, failureReason: null },
      { id: 2, type: 'metadata_probe', status: 'failed', createdAt: '2026-07-19T00:00:00.000Z', startedAt: '2026-07-19T00:00:00.000Z', finishedAt: '2026-07-19T00:00:01.000Z', failureReason: 'third-party detail' },
    ];
    const helpers = taskPageHelpers(
      await getPublicScript('yt-dlp-tasks.js'),
      async () => new Response(JSON.stringify({ tasks })),
      'en',
    );

    await helpers.loaded;
    const dom = [...helpers.nodes.values()].map(taskNodeText).join(' ');
    expect(dom).toContain('Media download');
    expect(dom).toContain('Queued');
    expect(dom).toContain('Metadata probe');
    expect(dom).toContain('Failed');
    expect(dom).toContain('third-party detail');
  });

  it('shows only the 30 most recent terminal tasks in newest-first order', async () => {
    const tasks = Array.from({ length: 31 }, (_, index): YtDlpTaskSnapshot => ({
      id: index + 1,
      type: 'metadata_probe',
      status: 'succeeded',
      createdAt: '2026-07-19T00:00:00.000Z',
      startedAt: '2026-07-19T00:00:00.000Z',
      finishedAt: '2026-07-19T00:00:01.000Z',
      failureReason: null,
    }));
    const helpers = taskPageHelpers(
      await getPublicScript('yt-dlp-tasks.js'),
      async () => new Response(JSON.stringify({ tasks })),
    );

    await helpers.loaded;

    const rows = helpers.nodes.get('terminal-task-list')?.children ?? [];
    expect(rows).toHaveLength(30);
    expect(rows.map((row) => row.children[0]?.textContent)).toEqual(
      Array.from({ length: 30 }, (_, index) => String(31 - index)),
    );
    expect(helpers.nodes.get('terminal-task-count')?.textContent).toBe('30');
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

    try {
      await Promise.all([
        succeeded.result,
        failed.result.catch(() => undefined),
        scheduled.result,
      ]);
      await schedulingTurn();

      const helpers = taskPageHelpers(
        await getPublicScript('yt-dlp-tasks.js'),
        (input, init) => fetch(new URL(input, baseUrl), init),
      );
      await helpers.loaded;
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
      expect(helpers.nodes.get('page-error')).toMatchObject({ hidden: true });
      expect(helpers.nodes.get('active-task-count')?.textContent).toBe('2');
      expect(helpers.nodes.get('terminal-task-count')?.textContent).toBe('4');
      expect(helpers.nodes.get('active-task-empty')).toMatchObject({ hidden: true });
      expect(helpers.nodes.get('terminal-task-empty')).toMatchObject({ hidden: true });
    } finally {
      finishRunning();
      finishQueued();
      await Promise.allSettled([running.result, queued.result]);
    }
  });

  it.each([
    ['type', '失败: 未知任务type：unknown'],
    ['status', '失败: 未知任务status：unknown'],
  ] as const)('shows task %s values outside the fixed page contract', async (field, message) => {
    const task: YtDlpTaskSnapshot = {
      id: 1,
      type: 'media_download',
      status: 'queued',
      createdAt: '2026-07-19T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      failureReason: null,
    };
    const invalidTask = { ...task, [field]: 'unknown' };
    const helpers = taskPageHelpers(
      await getPublicScript('yt-dlp-tasks.js'),
      async () => new Response(JSON.stringify({ tasks: [invalidTask] })),
    );

    await helpers.loaded;

    expect(helpers.nodes.get('page-error')).toMatchObject({
      hidden: false,
      textContent: message,
    });
    expect(helpers.nodes.get('active-task-list')?.children).toHaveLength(0);
    expect(helpers.nodes.get('terminal-task-list')?.children).toHaveLength(0);
  });

  it('shows API failures from the task page load path', async () => {
    const helpers = taskPageHelpers(
      await getPublicScript('yt-dlp-tasks.js'),
      async () => new Response(
        JSON.stringify({ error: { code: 'PERSISTENCE_ERROR', message: 'internal server error' } }),
        { status: 500 },
      ),
    );

    await helpers.loaded;
    const pageDom = [...helpers.nodes.values()].map(taskNodeText).join(' ');

    expect(helpers.nodes.get('page-error')?.hidden).toBe(false);
    expect(pageDom).toContain('数据保存失败');
    expect(helpers.nodes.get('active-task-list')?.children).toHaveLength(0);
    expect(helpers.nodes.get('terminal-task-list')?.children).toHaveLength(0);
  });

  it('shows fetch failures from the task page load path', async () => {
    const helpers = taskPageHelpers(
      await getPublicScript('yt-dlp-tasks.js'),
      async () => Promise.reject(new Error('network unavailable')),
    );

    await helpers.loaded;

    expect(helpers.nodes.get('page-error')).toMatchObject({
      hidden: false,
      textContent: '失败: network unavailable',
    });
    expect(helpers.nodes.get('active-task-list')?.children).toHaveLength(0);
    expect(helpers.nodes.get('terminal-task-list')?.children).toHaveLength(0);
  });

  it('keeps the task table reachable on narrow desktops and readable on mobile', async () => {
    const html = await getPage('/');
    const styles = await readFile(
      new URL('../../src/styles/main.scss', import.meta.url),
      'utf8',
    );

    expect(html.match(/class="yt-dlp-tasks-table-shell table-responsive border rounded-4"/g)).toHaveLength(2);
    expect(styles).toMatch(/\.yt-dlp-tasks-table-shell\s*\{[^}]*overflow-y: hidden;/s);
    expect(styles).not.toMatch(/\.yt-dlp-tasks-table-shell\s*\{[^}]*overflow-x:/s);
    expect(styles).toMatch(/\.yt-dlp-tasks-table\s*\{[^}]*min-width: 68rem;/s);
    expect(styles).toMatch(/\.yt-dlp-task-failure\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/s);
    expect(styles).toMatch(/@media \(max-width: 991\.98px\)[\s\S]*\.yt-dlp-tasks-table thead\s*\{[^}]*display: none;/);
    expect(styles).toMatch(/@media \(max-width: 991\.98px\)[\s\S]*\.yt-dlp-tasks-table td\s*\{[^}]*grid-template-columns: 6\.5rem minmax\(0, 1fr\);[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
    expect(styles).toMatch(/@media \(max-width: 991\.98px\)[\s\S]*\.yt-dlp-task-failure\s*\{[^}]*min-width: 0;[^}]*max-width: none;/);
  });

  it('allows only the task manager to import the low-level yt-dlp module', async () => {
    const sourceRoot = join(process.cwd(), 'src');
    const lowLevelImportPattern = /from\s+['"](?:\.\.?\/)*yt-dlp\.js['"]/g;
    const violatingFiles: string[] = [];

    for (const file of await typeScriptFiles(sourceRoot)) {
      const source = await readFile(file, 'utf8');
      const imports = source.match(lowLevelImportPattern) ?? [];
      if (imports.length === 0) continue;

      const projectPath = relative(process.cwd(), file);
      const isLegalManagerImport = projectPath === 'src/yt-dlp-task-manager.ts'
        && imports.length === 1;
      if (!isLegalManagerImport) violatingFiles.push(projectPath);
    }

    expect(violatingFiles.sort()).toEqual([]);
  });

  it('keeps download cards readable across desktop and mobile widths', async () => {
    const html = await getPage('/downloads');
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
    expect(styles).not.toMatch(/\.download-tabs\s*\{[^}]*grid-template-columns:/s);
    expect(styles).toContain('.download-empty-state {');
    expect(styles).toContain('@media (max-width: 575.98px)');
    expect(styles).not.toContain('.download-card-header {');
    expect(html).toContain('download-controls d-flex flex-column flex-sm-row');
    expect(styles).toMatch(/@media \(max-width: 575\.98px\)[\s\S]*\.download-card-metrics\s*\{[^}]*grid-template-columns: 1fr;/);
    expect(styles).not.toMatch(/\.download-detail-value\s*\{[^}]*text-overflow: ellipsis;/s);
    expect(styles).toMatch(/\.preview-page\s*\{[^}]*width: 100dvw;[^}]*height: 100dvh;[^}]*background:/s);
    expect(styles).not.toContain('.download-preview {');
    expect(styles).toMatch(/\.download-preview-player\s*\{[^}]*object-fit: contain;[^}]*background:/s);
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

  it('keeps authorization table and create action usable on mobile widths', async () => {
    const html = await getPage('/authorizations');
    const styles = await readFile(
      new URL('../../src/styles/main.scss', import.meta.url),
      'utf8',
    );

    expect(styles).toMatch(/\.authorization-table\s*\{[^}]*min-width: 42rem;/s);
    expect(html).toContain('authorization-page-heading d-flex flex-column flex-lg-row');
    expect(styles).toMatch(/@media \(max-width: 991\.98px\)[\s\S]*\.authorization-page-heading \.btn\s*\{[^}]*width: 100%;/);
  });

  it('requires confirmation before page delete actions', async () => {
    const settingsScript = await getPublicScript('settings.js');
    const downloadsScript = await getPublicScript('downloads.js');
    const authorizationsScript = await getPublicScript('authorizations.js');

    expect(settingsScript).toContain("confirm(t('settings.proxyDeleteConfirm', { name: proxy.name }))");
    expect(settingsScript).toContain('if (!confirmed) return;');
    expect(settingsScript).toContain("request(`/api/proxies/${proxy.id}`, 'DELETE')");

    expect(downloadsScript).toContain("confirm(t('downloads.deleteConfirm', { title: download.title }))");
    expect(downloadsScript).toContain('if (!confirmed) return;');
    expect(downloadsScript).toContain("mutateDownload(`/api/downloads/${download.id}`, 'DELETE', undefined, remove)");

    expect(authorizationsScript).toContain("confirm(t('authorizations.deleteConfirm', { platform: label }))");
    expect(authorizationsScript).toContain('if (!confirmed) return;');
    expect(authorizationsScript).toContain("`/api/authorizations/cookies/${configuration.platform}`");
    expect(authorizationsScript).toContain("'DELETE'");
  });

  it.each(['/', '/settings', '/channels', '/channels/7', '/notifications', '/authorizations', '/downloads', '/guide', '/downloads/preview?id=1'])('keeps JavaScript and CSS external on %s', async (path) => {
    const html = await getPage(path);

    expect(html).not.toMatch(/<script(?![^>]*(?:\bsrc=|type="application\/json"))[^>]*>/);
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
