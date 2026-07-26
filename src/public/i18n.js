export const LANGUAGES = Object.freeze(['zh-CN', 'en']);
export const DEFAULT_LANGUAGE = 'zh-CN';
export const LANGUAGE_COOKIE_NAME = 'vidharbor_language';
export const I18N_ELEMENT_ID = 'vidharbor-i18n';

export const API_ERROR_KEYS = Object.freeze({
  VALIDATION_ERROR: 'error.VALIDATION_ERROR',
  PROXY_NOT_FOUND: 'error.PROXY_NOT_FOUND',
  CHANNEL_NOT_FOUND: 'error.CHANNEL_NOT_FOUND',
  VIDEO_NOT_FOUND: 'error.VIDEO_NOT_FOUND',
  NOTIFICATION_NOT_FOUND: 'error.NOTIFICATION_NOT_FOUND',
  DOWNLOAD_NOT_FOUND: 'error.DOWNLOAD_NOT_FOUND',
  DOWNLOAD_FILE_UNAVAILABLE: 'error.DOWNLOAD_FILE_UNAVAILABLE',
  DOWNLOAD_DELETE_FAILED: 'error.DOWNLOAD_DELETE_FAILED',
  DOWNLOAD_DELETE_IN_PROGRESS: 'error.DOWNLOAD_DELETE_IN_PROGRESS',
  DOWNLOAD_RANGE_NOT_SATISFIABLE: 'error.DOWNLOAD_RANGE_NOT_SATISFIABLE',
  PROXY_NAME_EXISTS: 'error.PROXY_NAME_EXISTS',
  PROXY_IN_USE: 'error.PROXY_IN_USE',
  CHANNEL_ALREADY_EXISTS: 'error.CHANNEL_ALREADY_EXISTS',
  CHANNEL_NAME_EXISTS: 'error.CHANNEL_NAME_EXISTS',
  CHANNEL_IN_USE: 'error.CHANNEL_IN_USE',
  AUTHORIZATION_IN_USE: 'error.AUTHORIZATION_IN_USE',
  DOWNLOAD_ALREADY_EXISTS: 'error.DOWNLOAD_ALREADY_EXISTS',
  DOWNLOAD_ROOT_OUTSIDE_MOUNT: 'error.DOWNLOAD_ROOT_OUTSIDE_MOUNT',
  DOWNLOAD_ROOT_UNAVAILABLE: 'error.DOWNLOAD_ROOT_UNAVAILABLE',
  DOWNLOAD_ROOT_NOT_CONFIGURED: 'error.DOWNLOAD_ROOT_NOT_CONFIGURED',
  UNSUPPORTED_PLATFORM: 'error.UNSUPPORTED_PLATFORM',
  NOT_A_CHANNEL_URL: 'error.NOT_A_CHANNEL_URL',
  NOT_A_VIDEO_URL: 'error.NOT_A_VIDEO_URL',
  GLOBAL_INTERVAL_NOT_CONFIGURED: 'error.GLOBAL_INTERVAL_NOT_CONFIGURED',
  CHANNEL_FETCH_FAILED: 'error.CHANNEL_FETCH_FAILED',
  CHANNEL_METADATA_INVALID: 'error.CHANNEL_METADATA_INVALID',
  VIDEO_FETCH_FAILED: 'error.VIDEO_FETCH_FAILED',
  VIDEO_METADATA_INVALID: 'error.VIDEO_METADATA_INVALID',
  PERSISTENCE_ERROR: 'error.PERSISTENCE_ERROR',
});

export function createI18n(language, translations) {
  if (!LANGUAGES.includes(language)) throw new TypeError(`unknown language: ${String(language)}`);
  validateTranslations(translations);
  const numberFormatter = new Intl.NumberFormat(language);
  const sizeFormatter = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
  const translate = (key, params) => {
    if (typeof key !== 'string' || !Object.hasOwn(translations, key)) {
      throw new TypeError(`unknown translation key: ${String(key)}`);
    }
    return interpolate(translations[key], params);
  };
  return Object.freeze({
    language,
    t: translate,
    formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('number must be finite');
      return numberFormatter.format(value);
    },
    formatFileSize(bytes) {
      if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
        throw new TypeError('file size must be a non-negative safe integer');
      }
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
      let size = bytes;
      let unit = 0;
      while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
      return `${sizeFormatter.format(size)} ${units[unit]}`;
    },
    translateValue(keys, value) {
      if (typeof value !== 'string' || !Object.hasOwn(keys, value)) {
        throw new TypeError(`unknown mapped value: ${String(value)}`);
      }
      return translate(keys[value]);
    },
    formatApiError(error) {
      if (typeof error !== 'object' || error === null || Array.isArray(error)
        || typeof error.code !== 'string' || typeof error.message !== 'string') {
        throw new TypeError('invalid API error');
      }
      if (!Object.hasOwn(API_ERROR_KEYS, error.code)) throw new TypeError(`unknown API error code: ${error.code}`);
      return translate(API_ERROR_KEYS[error.code]);
    },
  });
}

export function readI18n(root = document) {
  const language = root.documentElement.lang;
  if (!LANGUAGES.includes(language)) throw new TypeError(`unknown document language: ${String(language)}`);
  const element = root.getElementById(I18N_ELEMENT_ID);
  if (element === null || element.type !== 'application/json') throw new TypeError('i18n application/json element is required');
  const data = JSON.parse(element.textContent);
  if (typeof data !== 'object' || data === null || Array.isArray(data)
    || Object.keys(data).length !== 2 || !Object.hasOwn(data, 'language') || !Object.hasOwn(data, 'translations')) {
    throw new TypeError('invalid i18n data');
  }
  if (data.language !== language) throw new TypeError('document and i18n languages must match');
  return createI18n(data.language, data.translations);
}

let current;
function currentI18n() { return current ??= readI18n(); }

export function getLanguage() { return currentI18n().language; }
export function t(key, params) { return currentI18n().t(key, params); }
export function formatNumber(value) { return currentI18n().formatNumber(value); }
export function formatFileSize(bytes) { return currentI18n().formatFileSize(bytes); }
export function translateValue(keys, value) { return currentI18n().translateValue(keys, value); }
export function formatApiError(error) { return currentI18n().formatApiError(error); }

function validateTranslations(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('translations must be a flat object');
  }
  for (const [key, translation] of Object.entries(value)) {
    if (key === '' || typeof translation !== 'string' || translation.trim() === '') {
      throw new TypeError(`translation ${key || '<empty>'} must be a non-empty string`);
    }
  }
}

function interpolate(template, params) {
  const placeholders = [...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]);
  const expected = new Set(placeholders);
  const supplied = Object.keys(params ?? {});
  if (expected.size !== supplied.length || supplied.some((name) => !expected.has(name))) {
    throw new TypeError(`translation parameters must be exactly: ${[...expected].join(', ')}`);
  }
  return template.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name) => String(params[name]));
}
