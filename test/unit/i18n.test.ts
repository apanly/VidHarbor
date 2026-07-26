import { readFileSync } from 'node:fs';

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

  it('serializes only the selected server catalog', () => {
    expect(JSON.parse(serializeI18n('en'))).toEqual({ language: 'en', translations: TRANSLATIONS.en });
  });
});

describe('browser i18n', () => {
  it('reads the selected catalog only when it matches html lang', () => {
    const data = serializeI18n('en');
    const root = {
      documentElement: { lang: 'en' },
      getElementById: () => ({ type: 'application/json', textContent: data }),
    };
    expect(readI18n(root).t('common.save')).toBe('Save');
  });

  it('rejects a catalog language that differs from html lang', () => {
    const root = {
      documentElement: { lang: 'zh-CN' },
      getElementById: () => ({ type: 'application/json', textContent: serializeI18n('en') }),
    };
    expect(() => readI18n(root)).toThrow('must match');
  });

  it('rejects an unknown mapped status', () => {
    const i18n = createI18n('en', TRANSLATIONS.en);
    expect(() => i18n.translateValue({ running: 'status.task.running' }, 'waiting')).toThrow('unknown mapped value: waiting');
  });

  it('maps every current API error code and rejects an unknown code', () => {
    expect(Object.keys(API_ERROR_KEYS).sort()).toEqual(Object.keys(ERROR_HTTP_STATUS).sort());
    const i18n = createI18n('en', TRANSLATIONS.en);
    for (const code of Object.keys(ERROR_HTTP_STATUS)) {
      expect(i18n.formatApiError({ code, message: 'unchanged API detail' })).toBe(TRANSLATIONS.en[`error.${code}` as TranslationKey]);
    }
    expect(() => i18n.formatApiError({ code: 'UNKNOWN', message: 'detail' })).toThrow('unknown API error code: UNKNOWN');
  });

  it('formats numbers with the selected exact language', () => {
    expect(createI18n('zh-CN', TRANSLATIONS['zh-CN']).formatNumber(12345.6)).toBe(new Intl.NumberFormat('zh-CN').format(12345.6));
    expect(createI18n('en', TRANSLATIONS.en).formatNumber(12345.6)).toBe(new Intl.NumberFormat('en').format(12345.6));
  });

  it('formats file sizes by 1024 with at most two fractional digits', () => {
    expect(createI18n('en', TRANSLATIONS.en).formatFileSize(1024)).toBe('1 KiB');
    expect(createI18n('en', TRANSLATIONS.en).formatFileSize(1536)).toBe('1.5 KiB');
    expect(() => createI18n('en', TRANSLATIONS.en).formatFileSize(-1)).toThrow('non-negative safe integer');
  });

  it('contains no HTML-producing browser API', () => {
    const source = readFileSync(new URL('../../src/public/i18n.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|createContextualFragment/);
  });
});
