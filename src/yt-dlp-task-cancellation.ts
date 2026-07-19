export class YtDlpTaskCancellationError extends Error {
  constructor() {
    super('yt-dlp task canceled');
  }
}

export function isYtDlpTaskCancellationError(
  error: unknown,
): error is YtDlpTaskCancellationError {
  return error instanceof YtDlpTaskCancellationError;
}
