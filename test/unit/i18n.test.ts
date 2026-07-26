import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ERROR_HTTP_STATUS } from '../../src/errors.js';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE_NAME,
  LANGUAGES,
  TRANSLATIONS,
  createTranslator,
  safeJson,
  selectLanguage,
  serializeI18n,
  t,
  validateCatalogs,
  type Language,
  type TranslationKey,
} from '../../src/i18n.js';
import {
  API_ERROR_KEYS,
  createI18n,
  readI18n,
} from '../../src/public/i18n.js';
import { renderPagination } from '../../src/public/pagination.js';
import { formatChinaTimestamp } from '../../src/public/time.js';

const projectRoot = new URL('../../', import.meta.url);
const pageScripts = [
  'authorizations.js',
  'channel-detail.js',
  'channels.js',
  'dashboard.js',
  'database.js',
  'download-preview.js',
  'downloads.js',
  'guide.js',
  'notifications.js',
  'settings.js',
] as const;

const stateMapContracts = {
  'dashboard.js': {
    labelKeys: { success: 'status.check.success', no_updates: 'status.check.no_updates', failed: 'status.check.failed' },
  },
  'downloads.js': {
    labelKeys: { pending: 'status.download.pending', downloading: 'status.download.downloading', running: 'status.download.running', completed: 'status.download.completed', failed: 'status.download.failed', canceled: 'status.download.canceled', interrupted: 'status.download.interrupted', deleting: 'status.download.deleting' },
  },
  'channels.js': {
    checkResultKeys: { success: 'status.check.success', no_updates: 'status.check.no_updates', failed: 'status.check.failed' },
    initialSyncStatusKeys: { pending: 'status.sync.pending', syncing: 'status.sync.syncing', failed: 'status.sync.failed', succeeded: 'status.sync.succeeded' },
  },
  'channel-detail.js': {
    downloadStatusKeys: { pending: 'status.download.pending', running: 'status.download.running', downloading: 'status.download.downloading', completed: 'status.download.completed', failed: 'status.download.failed', canceled: 'status.download.canceled', interrupted: 'status.download.interrupted', deleting: 'status.download.deleting' },
    checkTypeKeys: { initial: 'check.type.initial', scheduled: 'check.type.scheduled' },
    checkResultKeys: { success: 'status.check.success', no_updates: 'status.check.no_updates', failed: 'status.check.failed' },
  },
  'yt-dlp-tasks.js': {
    taskTypeKeys: { media_download: 'task.type.media_download', metadata_probe: 'task.type.metadata_probe', channel_initial_sync: 'task.type.channel_initial_sync', channel_manual_check: 'task.type.channel_manual_check', channel_scheduled_check: 'task.type.channel_scheduled_check' },
    taskStatusKeys: { queued: 'status.task.queued', running: 'status.task.running', succeeded: 'status.task.succeeded', failed: 'status.task.failed', canceled: 'status.task.canceled' },
  },
} as const;

function readSource(path: string): string {
  return readFileSync(new URL(path, projectRoot), 'utf8');
}

function sourceFiles(directory: string, extension: string): string[] {
  const root = new URL(directory, projectRoot);
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((path) => path.endsWith(extension))
    .map((path) => `${directory}${path}`);
}

function splitArguments(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (quote !== '') {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
    if ('({['.includes(character)) depth += 1;
    else if (')}]'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) { parts.push(value.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function translationCalls(path: string, source: string): string[][] {
  const calls: string[][] = [];
  const starts = source.matchAll(/(?<![\w.])t\s*\(/g);
  for (const match of starts) {
    const before = source.slice(0, match.index);
    if (/function\s*$/.test(before)) continue;
    const opening = (match.index ?? 0) + match[0].lastIndexOf('(');
    let depth = 1;
    let quote = '';
    let closing = -1;
    for (let index = opening + 1; index < source.length; index += 1) {
      const character = source[index] as string;
      if (quote !== '') {
        if (character === '\\') index += 1;
        else if (character === quote) quote = '';
        continue;
      }
      if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      if (depth === 0) { closing = index; break; }
    }
    if (closing === -1) throw new Error(`${path}: unclosed translation call`);
    calls.push(splitArguments(source.slice(opening + 1, closing)));
  }
  return calls;
}

function analyzeScript(path: string, source = readSource(path)) {
  function stringMap(name: string): Record<string, string> {
    const escapedName = name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`const\\s+${escapedName}\\s*=\\s*(?:Object\\.freeze\\s*\\()?\\{([\\s\\S]*?)\\}\\)?\\s*;`));
    if (match === null) throw new Error(`${path}: ${name} must be a fixed object`);
    const body = match[1] as string;
    const entries = [...body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(['"])(.*?)\2/g)];
    const residue = body.replaceAll(/([A-Za-z_$][\w$]*)\s*:\s*(['"])(.*?)\2/g, '').replaceAll(/[\s,]/g, '');
    if (entries.length === 0 || residue !== '') throw new Error(`${path}: ${name} must contain only literal string entries`);
    return Object.fromEntries(entries.map((entry) => [entry[1] as string, entry[3] as string]));
  }

  function translationKeys(expression: string, seen = new Set<string>()): string[] {
    const value = expression.trim();
    const literal = value.match(/^(['"])(.*?)\1$/s);
    if (literal !== null) return [literal[2] as string];
    if (value.includes('`') || /(['"])[^'"]*\1\s*\+/.test(value)) {
      throw new Error(`${path}: dynamic or unrecognized translation call: ${value}`);
    }
    if (/^[A-Za-z_$][\w$]*$/.test(value)) {
      if (seen.has(value)) throw new Error(`${path}: circular translation key ${value}`);
      const initializer = source.match(new RegExp(`const\\s+${value}\\s*=\\s*([^;]+);`))?.[1];
      if (initializer === undefined) throw new Error(`${path}: dynamic translation key ${value}`);
      return translationKeys(initializer, new Set([...seen, value]));
    }
    const keys: string[] = [];
    for (const mapCall of value.matchAll(/fixed(?:Value|Label)\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
      keys.push(...Object.values(stringMap(mapCall[1] as string)));
    }
    for (const key of value.matchAll(/(['"])([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)\1/g)) keys.push(key[2] as string);
    if (keys.length === 0) throw new Error(`${path}: dynamic or unrecognized translation call: ${value}`);
    return [...new Set(keys)];
  }

  const keys: string[] = [];
  for (const args of translationCalls(path, source)) {
    if (args.length < 1 || args.length > 2) throw new Error(`${path}: t() has an invalid argument count`);
    if (args[1] !== undefined && !(args[1].startsWith('{') && args[1].endsWith('}'))) {
      throw new Error(`${path}: t() does not accept a default value`);
    }
    keys.push(...translationKeys(args[0] as string));
  }
  return { keys, stringMap };
}

function ejsTranslationKeys(path: string, source = readSource(path)): string[] {
  return analyzeScript(path, source).keys;
}

class FakeElement {
  type = '';
  className = '';
  textContent = '';
  ariaLabel = '';
  disabled = false;
  hidden = false;
  children: FakeElement[] = [];
  listeners = new Map<string, () => void>();

  replaceChildren(...children: FakeElement[]) { this.children = children; }
  append(...children: FakeElement[]) { this.children.push(...children); }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); }
  click() { this.listeners.get('click')?.(); }
}

function useFakeDocument(language: Language) {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: { lang: language },
      getElementById: () => ({ type: 'application/json', textContent: serializeI18n(language) }),
      createElement: () => new FakeElement(),
    },
  });
}

describe('fixed language contract', () => {
  it('exports only zh-CN and en with zh-CN as the default', () => {
    expect(LANGUAGES).toEqual(['zh-CN', 'en']);
    expect(DEFAULT_LANGUAGE).toBe('zh-CN');
    expect(LANGUAGE_COOKIE_NAME).toBe('vidharbor_language');
  });

  it.each([
    [undefined, 'zh-CN'],
    ['', 'zh-CN'],
    ['other=value', 'zh-CN'],
    ['vidharbor_language=', 'zh-CN'],
    ['vidharbor_language=EN', 'zh-CN'],
    ['vidharbor_language=zh-cn', 'zh-CN'],
    ['vidharbor_language=en-US', 'zh-CN'],
    ['vidharbor_language=%65n', 'zh-CN'],
    ['timezone=en; Accept-Language=en', 'zh-CN'],
    ['other=zh-CN; vidharbor_language=en', 'en'],
    ['vidharbor_language=zh-CN', 'zh-CN'],
  ])('selects the language from the exact Cookie contract in %j', (header, expected) => {
    expect(selectLanguage(header)).toBe(expected);
  });

  it('uses the first repeated language Cookie deterministically', () => {
    expect(selectLanguage('vidharbor_language=en; vidharbor_language=zh-CN')).toBe('en');
    expect(selectLanguage('vidharbor_language=invalid; vidharbor_language=en')).toBe('zh-CN');
  });
});

describe('translation catalogs', () => {
  it('have identical key sets and non-empty flat string values', () => {
    expect(() => validateCatalogs(TRANSLATIONS)).not.toThrow();
    expect(Object.keys(TRANSLATIONS['zh-CN']).sort()).toEqual(Object.keys(TRANSLATIONS.en).sort());
    for (const catalog of Object.values(TRANSLATIONS)) {
      expect(Object.values(catalog).every((value) => typeof value === 'string' && value.trim() !== '')).toBe(true);
    }
  });

  it('rejects mismatched catalog keys', () => {
    expect(() => validateCatalogs({ 'zh-CN': { key: '值' }, en: { other: 'value' } })).toThrow('keys must match');
  });

  it('rejects empty and nested catalog values', () => {
    expect(() => validateCatalogs({ 'zh-CN': { key: '' }, en: { key: 'value' } })).toThrow('non-empty string');
    expect(() => validateCatalogs({ 'zh-CN': { key: { nested: '值' } }, en: { key: 'value' } })).toThrow('non-empty string');
  });

  it('rejects an unconfirmed language', () => {
    expect(() => createTranslator('en-US' as Language)).toThrow('unknown language: en-US');
  });

  it('rejects an unknown translation key', () => {
    expect(() => t('en', 'missing.key' as TranslationKey)).toThrow('unknown translation key: missing.key');
  });

  it('interpolates the exact declared parameters', () => {
    expect(t('en', 'channelDetail.summary', { videos: 12, checks: 3 })).toBe('12 videos · 3 checks');
  });

  it('rejects missing and extra interpolation parameters', () => {
    expect(() => t('en', 'channelDetail.summary', { videos: 12 })).toThrow('videos, checks');
    expect(() => t('en', 'common.save', { unused: 'value' })).toThrow('must be exactly');
  });
});

describe('source translation coverage', () => {
  it('includes the ten page scripts in the browser source scan', () => {
    const browserScripts = sourceFiles('src/public/', '.js');
    expect(pageScripts.every((file) => browserScripts.includes(`src/public/${file}`))).toBe(true);
    expect(pageScripts).toHaveLength(10);
  });

  it('resolves every EJS translation call against both catalogs', () => {
    const keys = sourceFiles('src/views/', '.ejs').flatMap((path) => ejsTranslationKeys(path));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(TRANSLATIONS['zh-CN'][key as TranslationKey]?.trim()).not.toBe('');
      expect(TRANSLATIONS.en[key as TranslationKey]?.trim()).not.toBe('');
    }
  });

  it('resolves every browser translation call against both catalogs', () => {
    const keys = sourceFiles('src/public/', '.js').flatMap((path) => analyzeScript(path).keys);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(TRANSLATIONS['zh-CN'][key as TranslationKey]?.trim()).not.toBe('');
      expect(TRANSLATIONS.en[key as TranslationKey]?.trim()).not.toBe('');
    }
  });

  it('rejects a dynamic translation key in source', () => {
    expect(() => analyzeScript('fixture.js', 't(`status.${value}`)')).toThrow('dynamic or unrecognized translation call');
    expect(() => ejsTranslationKeys('fixture.ejs', "<%= t('status.' + value) %>")).toThrow('dynamic or unrecognized translation call');
  });

  it('rejects a translation default value in source', () => {
    expect(() => analyzeScript('fixture.js', "t('common.save', 'Save')")).toThrow('does not accept a default value');
    expect(() => ejsTranslationKeys('fixture.ejs', "<%= t('common.save', 'Save') %>")).toThrow('does not accept a default value');
  });
});

describe('fixed browser states', () => {
  it('matches every declared state map to its fixed contract', () => {
    for (const [file, maps] of Object.entries(stateMapContracts)) {
      const source = analyzeScript(`src/public/${file}`);
      for (const [name, expected] of Object.entries(maps)) {
        expect(source.stringMap(name)).toEqual(expected);
      }
    }
  });

  it('translates every declared state in both languages', () => {
    for (const maps of Object.values(stateMapContracts)) {
      for (const mapping of Object.values(maps)) {
        for (const language of LANGUAGES) {
          const i18n = createI18n(language, TRANSLATIONS[language]);
          for (const value of Object.keys(mapping)) {
            expect(i18n.translateValue(mapping, value)).toBe(TRANSLATIONS[language][mapping[value as keyof typeof mapping] as TranslationKey]);
          }
        }
      }
    }
  });
});

describe('safe embedded JSON', () => {
  it('escapes script-breaking characters and preserves the parsed value', () => {
    const value = { text: '</script>\u2028line\u2029end' };
    const json = safeJson(value);
    expect(json).not.toContain('<');
    expect(json).not.toContain('\u2028');
    expect(json).not.toContain('\u2029');
    expect(JSON.parse(json)).toEqual(value);
  });

  it('rejects a value that JSON cannot serialize', () => {
    expect(() => safeJson(undefined)).toThrow('not JSON serializable');
  });

  it.each(LANGUAGES)('serializes only the selected %s server catalog', (language) => {
    expect(JSON.parse(serializeI18n(language))).toEqual({ language, translations: TRANSLATIONS[language] });
  });
});

describe('browser i18n', () => {
  it.each(LANGUAGES)('reads the selected %s catalog only when it matches html lang', (language) => {
    const data = serializeI18n(language);
    const root = {
      documentElement: { lang: language },
      getElementById: () => ({ type: 'application/json', textContent: data }),
    };
    expect(readI18n(root).t('common.save')).toBe(TRANSLATIONS[language]['common.save']);
  });

  it('rejects a catalog language that differs from html lang', () => {
    const root = {
      documentElement: { lang: 'zh-CN' },
      getElementById: () => ({ type: 'application/json', textContent: serializeI18n('en') }),
    };
    expect(() => readI18n(root)).toThrow('must match');
  });

  it('rejects an unconfirmed document language', () => {
    const root = {
      documentElement: { lang: 'en-US' },
      getElementById: () => ({ type: 'application/json', textContent: serializeI18n('en') }),
    };
    expect(() => readI18n(root)).toThrow('unknown document language: en-US');
  });

  it('rejects alias fields in embedded data', () => {
    const root = {
      documentElement: { lang: 'en' },
      getElementById: () => ({
        type: 'application/json',
        textContent: JSON.stringify({ language: 'en', translations: TRANSLATIONS.en, locale: 'en' }),
      }),
    };
    expect(() => readI18n(root)).toThrow('invalid i18n data');
  });

  it('rejects a nested browser catalog', () => {
    expect(() => createI18n('en', { common: { save: 'Save' } })).toThrow('non-empty string');
  });

  it('rejects an unknown mapped status', () => {
    const i18n = createI18n('en', TRANSLATIONS.en);
    expect(() => i18n.translateValue({ running: 'status.task.running' }, 'waiting')).toThrow('unknown mapped value: waiting');
  });

  it('maps every current API error code', () => {
    expect(Object.keys(API_ERROR_KEYS).sort()).toEqual(Object.keys(ERROR_HTTP_STATUS).sort());
    for (const language of LANGUAGES) {
      const i18n = createI18n(language, TRANSLATIONS[language]);
      for (const code of Object.keys(ERROR_HTTP_STATUS)) {
        expect(i18n.formatApiError({ code, message: 'unchanged API detail' })).toBe(TRANSLATIONS[language][`error.${code}` as TranslationKey]);
      }
    }
  });

  it('rejects an unknown API error code', () => {
    const i18n = createI18n('en', TRANSLATIONS.en);
    expect(() => i18n.formatApiError({ code: 'UNKNOWN', message: 'detail' })).toThrow('unknown API error code: UNKNOWN');
  });

  it.each(LANGUAGES)('formats a fixed number with the exact %s language', (language) => {
    expect(createI18n(language, TRANSLATIONS[language]).formatNumber(12345.6)).toBe('12,345.6');
  });

  it('rejects a non-finite number', () => {
    expect(() => createI18n('en', TRANSLATIONS.en).formatNumber(Number.NaN)).toThrow('number must be finite');
  });

  it('advances file-size units at the 1024 boundary', () => {
    expect(createI18n('en', TRANSLATIONS.en).formatFileSize(1024)).toBe('1 KiB');
  });

  it('limits file sizes to two fractional digits', () => {
    expect(createI18n('en', TRANSLATIONS.en).formatFileSize(1281)).toBe('1.25 KiB');
  });

  it('rejects invalid file sizes', () => {
    expect(() => createI18n('en', TRANSLATIONS.en).formatFileSize(-1)).toThrow('non-negative safe integer');
  });

  it('contains no HTML-producing browser API', () => {
    const source = readFileSync(new URL('../../src/public/i18n.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|createContextualFragment/);
  });
});

describe('localized browser display', () => {
  it.each([
    ['zh-CN', '2026/07/18 17:43:33'],
    ['en', '07/18/2026, 17:43:33'],
  ] as const)('formats a fixed Asia/Shanghai timestamp in %s', (language, expected) => {
    expect(readSource('src/public/time.js')).toContain("timeZone: 'Asia/Shanghai'");
    useFakeDocument(language);
    expect(formatChinaTimestamp('2026-07-18T09:43:33.709Z')).toBe(expected);
  });

  it('returns an invalid date unchanged', () => {
    useFakeDocument('en');
    expect(formatChinaTimestamp('not-a-date')).toBe('not-a-date');
  });

  it('localizes pagination display without changing callback numbers', () => {
    useFakeDocument('en');
    const container = new FakeElement();
    const selected: number[] = [];
    renderPagination(container, {
      page: 12345,
      totalPages: 12346,
      totalItems: 98765,
    }, (page: number) => selected.push(page));

    const [previous, pages, next, summary] = container.children;
    expect(previous?.textContent).toBe('Previous');
    expect(next?.textContent).toBe('Next');
    expect(summary?.textContent).toBe('Page 12,345 / 12,346 · 98,765 items');
    const pageButton = pages?.children.find((node) => node.textContent === '12,344');
    expect(pageButton?.ariaLabel).toBe('Page 12,344');
    pageButton?.click();
    expect(selected).toEqual([12344]);
  });

  it('hides empty pagination', () => {
    useFakeDocument('en');
    const container = new FakeElement();
    renderPagination(container, { page: 1, totalPages: 0, totalItems: 0 }, () => undefined);
    expect(container.hidden).toBe(true);
    expect(container.children).toEqual([]);
  });

  it('disables pagination controls at both page boundaries', () => {
    useFakeDocument('en');
    const container = new FakeElement();
    renderPagination(container, { page: 1, totalPages: 1, totalItems: 1 }, () => undefined);
    expect(container.children[0]?.disabled).toBe(true);
    expect(container.children[2]?.disabled).toBe(true);
  });
});
