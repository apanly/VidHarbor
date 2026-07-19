const MAX_STDERR_BYTES = 4 * 1024;
const MAX_FAILURE_REASON_BYTES = 1024;

export function redactProxyUrl(proxyUrl: string): string {
  const parsed = new URL(proxyUrl);
  if (parsed.username === '' && parsed.password === '') {
    return proxyUrl;
  }

  const separatorIndex = proxyUrl.indexOf('://');
  const userinfoEndIndex = proxyUrl.lastIndexOf('@');

  return `${proxyUrl.slice(0, separatorIndex + 3)}***${proxyUrl.slice(userinfoEndIndex)}`;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) {
    return value;
  }

  let result = '';
  let byteLength = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (byteLength + characterBytes > maximumBytes) {
      break;
    }
    result += character;
    byteLength += characterBytes;
  }

  return result;
}

export function redactStderr(
  stderr: string,
  knownProxyUrls: readonly string[],
): string {
  let redacted = stderr;

  for (const proxyUrl of knownProxyUrls) {
    const redactedProxyUrl = redactProxyUrl(proxyUrl);
    redacted = redacted.replaceAll(proxyUrl, redactedProxyUrl);

    if (redactedProxyUrl !== proxyUrl) {
      const userinfoStartIndex = proxyUrl.indexOf('://') + 3;
      const userinfoEndIndex = proxyUrl.lastIndexOf('@');
      const userinfo = proxyUrl.slice(userinfoStartIndex, userinfoEndIndex);
      redacted = redacted.replaceAll(userinfo, '***');
    }
  }

  return truncateUtf8(redacted, MAX_STDERR_BYTES);
}

function diagnosticKey(segment: string): string {
  return segment.replace(
    /^(ERROR|WARNING):\s+\[[^\]]+\]\s+\S+:\s+/,
    '$1: ',
  );
}

export function formatFailureReason(
  message: string,
  knownProxyUrls: readonly string[],
): string {
  const redacted = redactStderr(message, knownProxyUrls);
  const segments = redacted
    .split(/\s+(?=(?:ERROR|WARNING):)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  const seen = new Set<string>();
  const unique = segments.filter((segment) => {
    const key = diagnosticKey(segment);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const summary = unique.join(' ');
  if (Buffer.byteLength(summary, 'utf8') <= MAX_FAILURE_REASON_BYTES) {
    return summary;
  }
  return `${truncateUtf8(summary, MAX_FAILURE_REASON_BYTES - 3)}...`;
}
