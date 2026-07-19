const MAX_STDERR_BYTES = 4 * 1024;

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
