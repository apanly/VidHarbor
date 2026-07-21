import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
  type SyntaxKind as TypeScriptSyntaxKind,
} from 'typescript/unstable/ast';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiRouter, createApp } from '../../src/app.js';
import { RuntimeCoordinator } from '../../src/runtime.js';
import { openDatabase, type DatabaseConnection } from '../../src/db/client.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { formatFailureReason } from '../../src/redaction.js';
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

function taskPageHelpers(
  script: string,
  fetchTaskPage: (input: string, init?: RequestInit) => Promise<Response>,
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
  const executableSource = script.slice(script.indexOf('const taskTypeLabels'), loadCallStart);
  const loadCall = script.slice(loadCallStart).trim();
  const loaded = new Function(
    'document',
    'formatChinaTimestamp',
    'fetch',
    `${executableSource}; return ${loadCall}`,
  )(
    fakeDocument,
    (value: string) => value,
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

interface ScannedToken {
  readonly kind: TypeScriptSyntaxKind;
  readonly value: string;
}

interface ConstantExpression {
  readonly kind: 'StringLiteral' | 'TemplateExpression' | 'BinaryExpression' | 'Identifier' | 'ParenthesizedExpression';
  readonly value: string;
  readonly next: number;
}

type ConstantBindings = ReadonlyMap<string, readonly number[]>;

function scanTypeScript(source: string): ScannedToken[] {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: ScannedToken[] = [];
  const templateBraceDepths: number[] = [];

  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (scanner.getTokenEnd() === scanner.getTokenStart()) {
      scanner.resetTokenState(scanner.getTokenStart() + 1);
      continue;
    }
    if (kind === SyntaxKind.TemplateHead) templateBraceDepths.push(0);

    if (kind === SyntaxKind.OpenBraceToken && templateBraceDepths.length > 0) {
      const last = templateBraceDepths.length - 1;
      templateBraceDepths[last] += 1;
    } else if (kind === SyntaxKind.CloseBraceToken && templateBraceDepths.length > 0) {
      const last = templateBraceDepths.length - 1;
      if (templateBraceDepths[last] === 0) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === SyntaxKind.TemplateTail) templateBraceDepths.pop();
      } else {
        templateBraceDepths[last] -= 1;
      }
    }

    tokens.push({ kind, value: scanner.getTokenValue() });
  }

  return tokens;
}

function constantStrings(
  tokens: readonly ScannedToken[],
  start: number,
  bindings: ConstantBindings,
  resolving = new Set<string>(),
): ConstantExpression[] {
  const token = tokens[start];
  if (token === undefined) return [];

  let expressions: ConstantExpression[] = [];
  if (token.kind === SyntaxKind.StringLiteral
    || token.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    expressions = [{ kind: 'StringLiteral', value: token.value, next: start + 1 }];
  } else if (token.kind === SyntaxKind.TemplateHead) {
    let partials = [{ value: token.value, next: start + 1 }];
    while (partials.length > 0) {
      const completed: ConstantExpression[] = [];
      const continued: typeof partials = [];
      for (const partial of partials) {
        for (const interpolation of constantStrings(tokens, partial.next, bindings, resolving)) {
          const templateToken = tokens[interpolation.next];
          if (templateToken?.kind !== SyntaxKind.TemplateMiddle
            && templateToken?.kind !== SyntaxKind.TemplateTail) continue;
          const value = partial.value + interpolation.value + templateToken.value;
          const next = interpolation.next + 1;
          if (templateToken.kind === SyntaxKind.TemplateTail) {
            completed.push({ kind: 'TemplateExpression', value, next });
          } else {
            continued.push({ value, next });
          }
        }
      }
      if (completed.length > 0) {
        expressions = completed;
        break;
      }
      partials = continued;
    }
  } else if (token.kind === SyntaxKind.OpenParenToken) {
    expressions = constantStrings(tokens, start + 1, bindings, resolving)
      .filter((nested) => tokens[nested.next]?.kind === SyntaxKind.CloseParenToken)
      .map((nested) => ({
        kind: 'ParenthesizedExpression',
        value: nested.value,
        next: nested.next + 1,
      }));
  } else if (token.kind === SyntaxKind.Identifier && !resolving.has(token.value)) {
    expressions = (bindings.get(token.value) ?? []).flatMap((initializer) =>
      constantStrings(
        tokens,
        initializer,
        bindings,
        new Set(resolving).add(token.value),
      ).map((resolved) => ({
        kind: 'Identifier' as const,
        value: resolved.value,
        next: start + 1,
      })),
    );
  }

  return expressions.flatMap((expression) => {
    if (tokens[expression.next]?.kind !== SyntaxKind.PlusToken) return [expression];
    return constantStrings(tokens, expression.next + 1, bindings, resolving).map((right) => ({
      kind: 'BinaryExpression' as const,
      value: expression.value + right.value,
      next: right.next,
    }));
  });
}

function lowLevelYtDlpReferences(source: string): string[] {
  const tokens = scanTypeScript(source);
  const mutableBindings = new Map<string, number[]>();
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index]?.kind === SyntaxKind.ConstKeyword
      && tokens[index + 1]?.kind === SyntaxKind.Identifier) {
      const name = tokens[index + 1]!.value;
      for (let cursor = index + 2; cursor < tokens.length; cursor += 1) {
        const kind = tokens[cursor]?.kind;
        if (kind === SyntaxKind.EqualsToken) {
          mutableBindings.set(name, [...(mutableBindings.get(name) ?? []), cursor + 1]);
          break;
        }
        if (kind === SyntaxKind.CommaToken || kind === SyntaxKind.SemicolonToken) break;
      }
    }
  }
  const bindings: ConstantBindings = mutableBindings;
  const references: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const expressions = constantStrings(tokens, index, bindings);
    for (const expression of expressions) {
      if (/^(?:\.\.?\/)*yt-dlp\.js$/.test(expression.value)) {
        references.push(expression.value);
      }
    }
  }

  return [...new Set(references)];
}

describe('server-rendered pages', () => {
  it.each([
    ['/', '<h1 class="mb-4">总览</h1>'],
    ['/settings', '<h1>配置</h1>'],
    ['/channels', '<h1>频道</h1>'],
    ['/channels/7', '频道详情'],
    ['/notifications', '新视频提醒'],
    ['/authorizations', '<h1>授权管理</h1>'],
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
    expect(html).toContain('href="/authorizations">授权管理</a>');
    expect(html).toContain('href="/downloads">下载</a>');
    expect(html).not.toContain('href="/yt-dlp-tasks">任务状态</a>');
    expect(html).toContain('href="/guide">说明</a>');
    expect(html).toMatch(/href="\/">总览<\/a>[\s\S]*href="\/downloads">下载<\/a>[\s\S]*href="\/channels">频道<\/a>[\s\S]*href="\/notifications">提醒<\/a>[\s\S]*href="\/authorizations">授权管理<\/a>[\s\S]*href="\/settings">配置<\/a>[\s\S]*href="\/database">数据库<\/a>[\s\S]*href="\/guide">说明<\/a>/);
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
    expect(html).toContain('YouTube、Bilibili、X');
    expect(html).not.toContain('Vimeo');
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
    expect(dockerfile).toContain("amd64) yt_dlp_asset='yt-dlp_linux'");
    expect(dockerfile).toContain("arm64) yt_dlp_asset='yt-dlp_linux_aarch64'");
    expect(dockerfile).toContain('node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d');
    expect(dockerfile).toContain('ARG TARGETARCH');
    expect(dockerfile).toContain('{ test -z "$TARGETARCH" || test "$architecture" = "$TARGETARCH"; }');
    expect(dockerfile).not.toContain('ARG TARGETARCH=arm64');
  });

  it('renders the fixed authorization page without exposing saved Cookie material', async () => {
    const sensitiveMarker = 'pages-cookie-sensitive-marker';
    const upload = await fetch(`${baseUrl}/api/authorizations/cookies/youtube`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        origin: baseUrl,
      },
      body: `.example.test\tTRUE\t/\tFALSE\t0\tsession\t${sensitiveMarker}\n`,
    });
    expect(upload.status).toBe(200);

    const html = await getPage('/authorizations');
    const platformIds = [...html.matchAll(/data-authorization-platform="([^"]+)"/g)]
      .map((match) => match[1]);

    expect(html).toContain('<title>授权管理 · VidHarbor</title>');
    expect(html).toContain('class="sidebar-link active" href="/authorizations">授权管理</a>');
    expect(platformIds).toEqual([
      'youtube',
      'bilibili',
      'x',
      'facebook',
      'douyin',
    ]);
    expect(html).toMatch(/<h3>YouTube<\/h3>[\s\S]*<h3>Bilibili<\/h3>[\s\S]*<h3>X<\/h3>[\s\S]*<h3>Facebook<\/h3>[\s\S]*<h3>抖音<\/h3>/);
    expect(html.match(/data-authorization-upload/g)).toHaveLength(5);
    expect(html.match(/data-authorization-status/g)).toHaveLength(5);
    expect(html.match(/data-authorization-updated hidden/g)).toHaveLength(5);
    expect(html).toContain('每个平台仅保存一份文件；再次上传会完整替换已有配置。');
    expect(html).toContain('尚未接入业务流程');
    expect(html).toContain('不会用于频道同步、元数据探测或媒体下载');
    expect(html).toContain('安全获取与导出说明');
    expect(html).toContain('Cookie 等同账号登录凭据');
    expect(html).toContain('不会读取浏览器资料目录、代替你登录、转换其他授权格式或验证远端有效性');
    expect(html).toContain('不代表登录态当前有效');
    expect(html).toContain('<script type="module" src="/public/authorizations.js"></script>');
    expect(html).not.toContain('Vimeo');
    expect(html.includes(sensitiveMarker)).toBe(false);
    expect(html).not.toMatch(/data-authorization-(?:domain|cookie-name|cookie-value|file-name|path|preview|download)/);
    expect(html).not.toContain('预览 Cookie');
    expect(html).not.toContain('下载 Cookie');
    expect(html).not.toMatch(/<a[^>]+\bdownload(?:\s|=|>)/);
  });

  it('uses only public authorization metadata and sends the selected File directly', async () => {
    type AuthorizationEventListener = (
      event: { preventDefault(): void },
    ) => void | Promise<void>;
    interface AuthorizationNode {
      className: string;
      type: string;
      textContent: string;
      hidden: boolean;
      disabled: boolean;
      value: string;
      dateTime: string;
      files: File[];
      readonly dataset: Record<string, string>;
      readonly elements: Record<string, AuthorizationNode>;
      readonly children: AuthorizationNode[];
      readonly attributes: Map<string, string>;
      readonly listeners: Map<string, AuthorizationEventListener>;
      querySelector(selector: string): AuthorizationNode;
      addEventListener(type: string, listener: AuthorizationEventListener): void;
      replaceChildren(...children: AuthorizationNode[]): void;
      append(...children: AuthorizationNode[]): void;
      setAttribute(name: string, value: string): void;
      removeAttribute(name: string): void;
    }

    const allNodes: AuthorizationNode[] = [];
    const node = (): AuthorizationNode => {
      const result: AuthorizationNode = {
        className: '',
        type: '',
        textContent: '',
        hidden: false,
        disabled: false,
        value: '',
        dateTime: '',
        files: [],
        dataset: {},
        elements: {},
        children: [],
        attributes: new Map(),
        listeners: new Map(),
        querySelector: () => {
          throw new Error('unexpected selector');
        },
        addEventListener(type, listener) {
          this.listeners.set(type, listener);
        },
        replaceChildren(...children) {
          this.children.splice(0, this.children.length, ...children);
        },
        append(...children) {
          this.children.push(...children);
        },
        setAttribute(name, value) {
          this.attributes.set(name, value);
        },
        removeAttribute(name) {
          this.attributes.delete(name);
          if (name === 'datetime') this.dateTime = '';
        },
      };
      allNodes.push(result);
      return result;
    };
    const makeCard = (platform: string) => {
      const card = node();
      const status = node();
      const updated = node();
      const time = node();
      const submit = node();
      const deleteContainer = node();
      const error = node();
      const form = node();
      const fileControl = node();
      card.dataset.authorizationPlatform = platform;
      form.elements.cookieFile = fileControl;
      const cardSelectors = new Map<string, AuthorizationNode>([
        ['[data-authorization-status]', status],
        ['[data-authorization-updated]', updated],
        ['[data-authorization-time]', time],
        ['[data-authorization-submit]', submit],
        ['[data-authorization-delete]', deleteContainer],
        ['[data-authorization-error]', error],
        ['[data-authorization-upload]', form],
      ]);
      card.querySelector = (selector) => {
        const match = cardSelectors.get(selector);
        if (match === undefined) throw new Error(`unexpected card selector: ${selector}`);
        return match;
      };
      form.querySelector = (selector) => {
        if (selector !== '[data-authorization-submit]') {
          throw new Error(`unexpected form selector: ${selector}`);
        }
        return submit;
      };
      return {
        card,
        status,
        updated,
        time,
        submit,
        deleteContainer,
        fileControl,
        form,
      };
    };

    const cards = new Map([
      ['youtube', makeCard('youtube')],
      ['bilibili', makeCard('bilibili')],
    ]);
    const fakeDocument = {
      createElement: () => node(),
      querySelector: (selector: string) => {
        const match = selector.match(/^\[data-authorization-platform="([^"]+)"\]$/);
        if (match === null) throw new Error(`unexpected document selector: ${selector}`);
        const card = cards.get(match[1]);
        if (card === undefined) throw new Error(`unexpected platform: ${match[1]}`);
        return card.card;
      },
    };
    const sensitiveMarker = 'browser-cookie-sensitive-marker';
    const selectedFile = new File(
      [`.example.test\tTRUE\t/\tFALSE\t0\tsession\t${sensitiveMarker}\n`],
      `${sensitiveMarker}.txt`,
      { type: 'text/plain' },
    );
    const requestSummaries: Array<{
      path: string;
      method: string;
      contentType: string | undefined;
      bodyIsSelectedFile: boolean;
    }> = [];
    const confirmations: string[] = [];
    let youtubeUploads = 0;
    const fakeFetch = async (path: string, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined;
      requestSummaries.push({
        path,
        method: init.method ?? 'GET',
        contentType: headers?.['Content-Type'],
        bodyIsSelectedFile: init.body === selectedFile,
      });
      if (path.endsWith('/youtube')) youtubeUploads += 1;
      if (path.endsWith('/youtube') && youtubeUploads === 2) {
        return new Response(JSON.stringify({
          error: { code: 'VALIDATION_ERROR', message: 'invalid Netscape cookie file' },
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const configuration = path.endsWith('/youtube')
        ? {
            platform: 'youtube',
            configured: true,
            updatedAt: '2026-07-21T09:00:00.000Z',
          }
        : { platform: 'bilibili', configured: false, updatedAt: null };
      return new Response(JSON.stringify({ configuration }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const script = await getPublicScript('authorizations.js');
    const executableSource = script.slice(
      script.indexOf('const platformLabels'),
      script.indexOf('\nload().catch'),
    );
    const helpers = new Function(
      'document',
      'fetch',
      'confirm',
      'formatChinaTimestamp',
      `${executableSource}; return { renderConfiguration, bindUploadForm };`,
    )(
      fakeDocument,
      fakeFetch,
      (message: string) => {
        confirmations.push(message);
        return true;
      },
      (value: string) => `中国标准时间 ${value}`,
    ) as {
      renderConfiguration(configuration: Record<string, unknown>): void;
      bindUploadForm(card: AuthorizationNode): void;
    };
    const sensitiveFields = {
      cookie: sensitiveMarker,
      domain: sensitiveMarker,
      name: sensitiveMarker,
      value: sensitiveMarker,
      fileName: `${sensitiveMarker}.txt`,
      path: `/private/${sensitiveMarker}`,
      previewUrl: `/preview/${sensitiveMarker}`,
      downloadUrl: `/download/${sensitiveMarker}`,
    };

    helpers.renderConfiguration({
      platform: 'youtube',
      configured: false,
      updatedAt: null,
      ...sensitiveFields,
    });
    helpers.renderConfiguration({
      platform: 'bilibili',
      configured: true,
      updatedAt: '2026-07-21T08:30:00.000Z',
      ...sensitiveFields,
    });

    const youtube = cards.get('youtube')!;
    const bilibili = cards.get('bilibili')!;
    expect(youtube.status.textContent).toBe('未配置');
    expect(youtube.submit.textContent).toBe('上传');
    expect(youtube.updated.hidden).toBe(true);
    expect(youtube.time.dateTime).toBe('');
    expect(youtube.deleteContainer.children).toHaveLength(0);
    expect(bilibili.status.textContent).toBe('已配置');
    expect(bilibili.submit.textContent).toBe('替换');
    expect(bilibili.updated.hidden).toBe(false);
    expect(bilibili.time.dateTime).toBe('2026-07-21T08:30:00.000Z');
    expect(bilibili.time.textContent).toBe('中国标准时间 2026-07-21T08:30:00.000Z');
    expect(bilibili.deleteContainer.children).toHaveLength(1);
    expect(Object.keys(bilibili.card.dataset).sort()).toEqual([
      'authorizationPlatform',
      'configured',
    ]);

    helpers.bindUploadForm(youtube.card);
    youtube.fileControl.files = [selectedFile];
    youtube.fileControl.value = `${sensitiveMarker}.txt`;
    await youtube.form.listeners.get('submit')!({ preventDefault: () => undefined });
    expect(requestSummaries[0]).toEqual({
      path: '/api/authorizations/cookies/youtube',
      method: 'PUT',
      contentType: 'application/octet-stream',
      bodyIsSelectedFile: true,
    });
    expect(youtube.fileControl.value).toBe('');
    expect(youtube.status.textContent).toBe('已配置');
    expect(youtube.submit.textContent).toBe('替换');

    youtube.fileControl.files = [selectedFile];
    youtube.fileControl.value = `${sensitiveMarker}.txt`;
    await youtube.form.listeners.get('submit')!({ preventDefault: () => undefined });
    expect(requestSummaries[1]?.bodyIsSelectedFile).toBe(true);
    expect(youtube.fileControl.value).toBe('');
    expect(youtube.status.textContent).toBe('已配置');

    const deleteButton = bilibili.deleteContainer.children[0];
    await deleteButton.listeners.get('click')!({ preventDefault: () => undefined });
    expect(confirmations).toEqual(['确认删除 Bilibili 的 Cookie 配置？']);
    expect(requestSummaries[2]).toEqual({
      path: '/api/authorizations/cookies/bilibili',
      method: 'DELETE',
      contentType: undefined,
      bodyIsSelectedFile: false,
    });
    expect(bilibili.status.textContent).toBe('未配置');
    expect(bilibili.updated.hidden).toBe(true);
    expect(bilibili.deleteContainer.children).toHaveLength(0);

    const publicConfigurationFields = [...new Set(
      [...script.matchAll(/configuration\.([A-Za-z]+)/g)].map((match) => match[1]),
    )].sort();
    expect(publicConfigurationFields).toEqual(['configured', 'platform', 'updatedAt']);
    expect(script).not.toMatch(/File\.text|\.text\(\)|localStorage|sessionStorage/);
    expect(script).not.toMatch(/file\.(?:name|path)|previewUrl|downloadUrl/);
    const visibleState = allNodes.flatMap((current) => [
      current.textContent,
      current.value,
      current.dateTime,
      ...Object.values(current.dataset),
      ...current.attributes.values(),
    ]);
    expect(visibleState.some((value) => value.includes(sensitiveMarker))).toBe(false);
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
    expect(channelsHtml).toContain('id="channel-empty-state" class="channel-empty-state"');
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

  it('renders direct download form with progressive optional groups', async () => {
    const html = await getPage('/downloads');

    expect(html).toContain('data-bs-target="#direct-download-modal"');
    expect(html).toContain('id="direct-download-modal"');
    expect(html).toContain('class="modal-dialog modal-dialog-centered modal-lg modal-dialog-scrollable"');
    expect(html).toContain('<form id="direct-download-form" class="modal-content form-stack direct-download-form">');
    expect(html).toContain('class="direct-form-grid"');
    expect(html).toContain('class="direct-advanced-options"');
    expect(html).toContain('<strong>高级选项</strong>');
    expect(html).toContain('起始时间和结束时间需要同时填写');
    expect(html).toContain('>转码格式</label>');
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
    expect(html).toContain('name="proxyId"');
    expect(script).toContain("request('/api/proxies')");
    expect(html).not.toContain('name="targetSubdirectory"');
    expect(html).not.toContain('name="writeThumbnail"');
    expect(html).toContain('name="mediaType"');
    expect(html).not.toContain('name="format"');
    expect(html).toContain('name="quality"');
    expect(html).not.toContain('name="splitChapters"');
    expect(script).toContain('advancedOptions(form)');
    expect(script).toContain('format: null');
    expect(script).toContain('splitChapters: false');
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
    expect(script).toContain("detail('总下载耗时', 'downloadElapsedSeconds')");
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
      `${functionSource}; return { displayValue, formatTimestamp, formatDuration, downloadElapsedSeconds, formatBytes };`,
    )(fakeDocument, timeHelpers.formatChinaTimestamp) as {
      displayValue(value: string | null): string;
      formatTimestamp(value: string | null): string;
      formatDuration(value: number | null): string;
      downloadElapsedSeconds(startedAt: string | null, finishedAt: string | null): number | null;
      formatBytes(value: number | null): string;
    };
    const value = '2026-07-18T09:43:33.709Z';

    expect(helpers.displayValue(null)).toBe('—');
    expect(helpers.displayValue('0s')).toBe('0s');
    expect(helpers.formatTimestamp(value)).toBe('2026-07-18 17:43:33');
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
    expect(html).toContain('<h2 id="active-tasks-title">活动任务</h2>');
    expect(html).toContain('<h2 id="terminal-tasks-title">最近已结束任务</h2>');
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
    ['type', '未知任务类型：unknown'],
    ['status', '未知任务状态：unknown'],
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
      textContent: `前端错误：${message}`,
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
    expect(pageDom).toContain('PERSISTENCE_ERROR: internal server error');
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
      textContent: '前端错误：network unavailable',
    });
    expect(helpers.nodes.get('active-task-list')?.children).toHaveLength(0);
    expect(helpers.nodes.get('terminal-task-list')?.children).toHaveLength(0);
  });

  it('keeps the task table reachable on narrow desktops and readable on mobile', async () => {
    const styles = await readFile(
      new URL('../../src/styles/main.scss', import.meta.url),
      'utf8',
    );

    expect(styles).toMatch(/\.yt-dlp-tasks-table-shell\s*\{[^}]*overflow-x: auto;[^}]*overflow-y: hidden;/s);
    expect(styles).toMatch(/\.yt-dlp-tasks-table\s*\{[^}]*min-width: 68rem;/s);
    expect(styles).toMatch(/\.yt-dlp-task-failure\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/s);
    expect(styles).toMatch(/@media \(max-width: 991\.98px\)[\s\S]*\.yt-dlp-tasks-table thead\s*\{[^}]*display: none;/);
    expect(styles).toMatch(/@media \(max-width: 991\.98px\)[\s\S]*\.yt-dlp-tasks-table td\s*\{[^}]*grid-template-columns: 6\.5rem minmax\(0, 1fr\);[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
    expect(styles).toMatch(/@media \(max-width: 991\.98px\)[\s\S]*\.yt-dlp-task-failure\s*\{[^}]*min-width: 0;[^}]*max-width: none;/);
  });

  it('allows only the task manager to import the low-level yt-dlp module', async () => {
    const sourceRoot = join(process.cwd(), 'src');
    const legalImportPattern = /from '\.\/yt-dlp\.js'/g;
    const violatingFiles: string[] = [];

    for (const file of await typeScriptFiles(sourceRoot)) {
      const source = await readFile(file, 'utf8');
      const references = lowLevelYtDlpReferences(source);
      if (references.length === 0) continue;

      const projectPath = relative(process.cwd(), file);
      const isLegalManagerImport = projectPath === 'src/yt-dlp-task-manager.ts'
        && references.length === 1
        && [...source.matchAll(legalImportPattern)].length === 1;
      if (!isLegalManagerImport) violatingFiles.push(projectPath);
    }

    expect(violatingFiles.sort()).toEqual([]);
  });

  it.each([
    ['static import', "import { run as renamed } from '../yt-dlp.js';"],
    ['dynamic import', "const module = await import('../yt-dlp.js');"],
    ['require', "const module = require('../yt-dlp.js');"],
    ['renamed concatenated loader', "const load = require; load('../yt-' + 'dlp.js');"],
    ['escaped string literal', String.raw`const module = await import('../yt\x2ddlp.js');`],
    ['template expression', "const module = await import(`../yt-${'dlp'}.js`);"],
    ['variable concatenation', "const suffix = 'dlp.js'; const module = await import('../yt-' + suffix);"],
    ['typed variable concatenation', "const suffix: string = 'dlp.js'; const module = await import('../yt-' + suffix);"],
    ['same-name scoped variable', "{ const suffix = 'safe.js'; } { const suffix = 'dlp.js'; import('../yt-' + suffix); }"],
  ])('rejects a low-level yt-dlp bypass using %s', (_name, source) => {
    expect(lowLevelYtDlpReferences(source)).toEqual(['../yt-dlp.js']);
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

  it('keeps authorization cards and actions usable on mobile widths', async () => {
    const styles = await readFile(
      new URL('../../src/styles/main.scss', import.meta.url),
      'utf8',
    );

    expect(styles).toMatch(/\.authorization-platform-grid\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
    expect(styles).toMatch(/@media \(max-width: 991\.98px\)[\s\S]*\.authorization-platform-grid\s*\{[^}]*grid-template-columns: 1fr;/);
    expect(styles).toMatch(/@media \(max-width: 575\.98px\)[\s\S]*\.authorization-actions\s*\{[^}]*flex-direction: column;/);
    expect(styles).toMatch(/@media \(max-width: 575\.98px\)[\s\S]*\.authorization-actions \.btn\s*\{[^}]*width: 100%;/);
  });

  it('requires confirmation before page delete actions', async () => {
    const settingsScript = await getPublicScript('settings.js');
    const downloadsScript = await getPublicScript('downloads.js');
    const authorizationsScript = await getPublicScript('authorizations.js');

    expect(settingsScript).toContain("confirm(`确认删除代理「${proxy.name}」？`)");
    expect(settingsScript).toContain('if (!confirmed) return;');
    expect(settingsScript).toContain("request(`/api/proxies/${proxy.id}`, 'DELETE')");

    expect(downloadsScript).toContain("confirm(`确认永久删除下载「${download.title}」及其文件？`)");
    expect(downloadsScript).toContain('if (!confirmed) return;');
    expect(downloadsScript).toContain("mutateDownload(`/api/downloads/${download.id}`, 'DELETE', undefined, remove)");

    expect(authorizationsScript).toContain('confirm(`确认删除 ${label} 的 Cookie 配置？`)');
    expect(authorizationsScript).toContain('if (!confirmed) return;');
    expect(authorizationsScript).toContain("`/api/authorizations/cookies/${configuration.platform}`");
    expect(authorizationsScript).toContain("'DELETE'");
  });

  it.each(['/', '/settings', '/channels', '/channels/7', '/notifications', '/authorizations', '/downloads', '/guide', '/downloads/preview?id=1'])('keeps JavaScript and CSS external on %s', async (path) => {
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
