const chinaTimeFormatter = Object.fromEntries(['zh-CN', 'en'].map((language) => [
  language,
  new Intl.DateTimeFormat(language, {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }),
]));

export function formatChinaTimestamp(value) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  const language = globalThis.document?.documentElement.lang ?? 'zh-CN';
  return chinaTimeFormatter[language].format(timestamp);
}
