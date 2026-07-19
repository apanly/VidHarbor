import { spawn } from 'node:child_process';

import { redactStderr } from './redaction.js';

const SOCKET_TIMEOUT_SECONDS = '30';
const JAVASCRIPT_RUNTIME = 'node';
const FETCH_PROCESS_TIMEOUT_MILLISECONDS = 15 * 60 * 1000;
const DOWNLOAD_INACTIVITY_TIMEOUT_MILLISECONDS = 15 * 60 * 1000;
const DOWNLOAD_FORMAT = 'bestvideo*+bestaudio/best';
const MAX_CAPTURED_STDERR_BYTES = 8 * 1024;

interface CommonOptions {
  readonly executablePath: string;
  readonly url: string;
  readonly proxyUrl?: string;
}

export interface FetchOptions extends CommonOptions {
  readonly dateAfter?: string;
  readonly allowEmpty?: boolean;
}

export interface DownloadOptions extends CommonOptions {
  readonly outputTemplate: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DownloadProgress) => void;
  readonly advancedOptions?: {
    readonly mediaType: 'video' | 'audio';
    readonly format: string | null;
    readonly quality: string | null;
    readonly codec: string | null;
    readonly writeSubtitles: boolean;
    readonly writeThumbnail: boolean;
    readonly splitChapters: boolean;
    readonly timeRangeStart: string | null;
    readonly timeRangeEnd: string | null;
    readonly filenamePreset: string | null;
  };
}

export interface DownloadProgress {
  readonly progressPercent: number;
  readonly speedText: string | null;
  readonly etaSeconds: number | null;
}

interface ProcessResult {
  readonly stdoutLines: readonly string[];
}

function appendProxyArgument(args: string[], proxyUrl: string | undefined): void {
  if (proxyUrl !== undefined) {
    args.push('--proxy', proxyUrl);
  }
}

function processError(message: string, proxyUrl: string | undefined): Error {
  return new Error(redactStderr(message, proxyUrl === undefined ? [] : [proxyUrl]));
}

function processExitError(
  message: string,
  proxyUrl: string | undefined,
  exitCode: number,
): Error {
  const error = processError(message, proxyUrl);
  (error as Error & { exitCode: number }).exitCode = exitCode;
  return error;
}

function removeCredentialBoundary(
  stderr: string,
  proxyUrl: string | undefined,
): string {
  if (proxyUrl === undefined) {
    return stderr;
  }
  return stderr.slice(0, Math.max(0, stderr.length - proxyUrl.length));
}

function runProcess(
  options: CommonOptions,
  args: readonly string[],
  processTimeoutMilliseconds: number | undefined,
  inactivityTimeoutMilliseconds: number | undefined,
  abortSignal: AbortSignal | undefined,
  onStdoutLine?: (line: string) => void,
  acceptedExitCodes: readonly number[] = [],
  onStderrLine?: (line: string) => boolean,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executablePath, args, {
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutLines: string[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let stderrTruncated = false;
    let stdoutRemainder = '';
    let stderrRemainder = '';
    let spawnError: Error | undefined;
    let timedOut = false;
    let inactive = false;
    let cancelled = false;
    let terminationError: Error | undefined;
    let outputLineError: Error | undefined;

    const terminateProcessGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        terminationError =
          error instanceof Error ? error : new Error('process group termination failed');
        child.kill('SIGKILL');
      }
    };

    const timeout =
      processTimeoutMilliseconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminateProcessGroup();
          }, processTimeoutMilliseconds);
    let inactivityTimeout: ReturnType<typeof setTimeout> | undefined;
    const resetInactivityTimeout = () => {
      if (inactivityTimeoutMilliseconds === undefined) return;
      if (inactivityTimeout !== undefined) clearTimeout(inactivityTimeout);
      inactivityTimeout = setTimeout(() => {
        inactive = true;
        terminateProcessGroup();
      }, inactivityTimeoutMilliseconds);
    };
    const cancel = () => {
      cancelled = true;
      terminateProcessGroup();
    };
    resetInactivityTimeout();
    if (abortSignal?.aborted === true) cancel();
    else abortSignal?.addEventListener('abort', cancel, { once: true });

    const appendStdoutLine = (line: string) => {
      const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
      stdoutLines.push(normalizedLine);
      if (onStdoutLine === undefined || outputLineError !== undefined) return;
      try {
        onStdoutLine(normalizedLine);
      } catch (error) {
        outputLineError =
          error instanceof Error ? error : new Error('stdout line handling failed');
        terminateProcessGroup();
      }
    };

    const captureStderr = (value: string) => {
      const chunk = Buffer.from(value);
      const remainingBytes = MAX_CAPTURED_STDERR_BYTES - stderrBytes;
      if (remainingBytes <= 0) {
        stderrTruncated = true;
        return;
      }
      const captured = chunk.subarray(0, remainingBytes);
      stderrChunks.push(captured);
      stderrBytes += captured.length;
      if (captured.length !== chunk.length) stderrTruncated = true;
    };

    const appendStderrLine = (line: string, newline: boolean) => {
      const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (outputLineError !== undefined) return;
      try {
        if (onStderrLine?.(normalizedLine) === true) return;
      } catch (error) {
        outputLineError =
          error instanceof Error ? error : new Error('stderr line handling failed');
        terminateProcessGroup();
        return;
      }
      captureStderr(`${normalizedLine}${newline ? '\n' : ''}`);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      resetInactivityTimeout();
      const pieces = `${stdoutRemainder}${chunk}`.split('\n');
      stdoutRemainder = pieces.pop() ?? '';
      for (const line of pieces) appendStdoutLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      resetInactivityTimeout();
      const pieces = `${stderrRemainder}${chunk}`.split('\n');
      stderrRemainder = pieces.pop() ?? '';
      for (const line of pieces) appendStderrLine(line, true);
      if (Buffer.byteLength(stderrRemainder) > MAX_CAPTURED_STDERR_BYTES) {
        captureStderr(stderrRemainder);
        stderrRemainder = '';
        stderrTruncated = true;
      }
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, terminationSignal) => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (inactivityTimeout !== undefined) clearTimeout(inactivityTimeout);
      abortSignal?.removeEventListener('abort', cancel);
      if (stdoutRemainder !== '') appendStdoutLine(stdoutRemainder);
      if (stderrRemainder !== '') appendStderrLine(stderrRemainder, false);

      const capturedStderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const stderr = stderrTruncated
        ? removeCredentialBoundary(capturedStderr, options.proxyUrl)
        : capturedStderr;
      if (outputLineError !== undefined) {
        reject(outputLineError);
        return;
      }
      if (terminationError !== undefined) {
        reject(
          processError(
            `yt-dlp process group termination failed: ${terminationError.message}`,
            options.proxyUrl,
          ),
        );
        return;
      }
      if (cancelled) {
        reject(processError('yt-dlp download cancelled', options.proxyUrl));
        return;
      }
      if (inactive) {
        reject(
          processError(
            `yt-dlp produced no output for ${String(inactivityTimeoutMilliseconds)} ms`,
            options.proxyUrl,
          ),
        );
        return;
      }
      if (timedOut) {
        reject(
          processError(
            `yt-dlp timed out after ${String(processTimeoutMilliseconds)} ms${stderr === '' ? '' : `: ${stderr}`}`,
            options.proxyUrl,
          ),
        );
        return;
      }
      if (spawnError !== undefined) {
        reject(
          processError(`yt-dlp failed to start: ${spawnError.message}`, options.proxyUrl),
        );
        return;
      }
      if (terminationSignal !== null) {
        reject(
          processError(
            `yt-dlp terminated by signal ${terminationSignal}${stderr === '' ? '' : `: ${stderr}`}`,
            options.proxyUrl,
          ),
        );
        return;
      }
      if (code === null || (code !== 0 && !acceptedExitCodes.includes(code))) {
        const exitCode = code ?? -1;
        reject(
          processExitError(
            `yt-dlp exited with exit code ${String(exitCode)}${stderr === '' ? '' : `: ${stderr}`}`,
            options.proxyUrl,
            exitCode,
          ),
        );
        return;
      }

      resolve({ stdoutLines });
    });
  });
}

function fetchArgs(options: FetchOptions, singleVideo: boolean): string[] {
  const args = [
    '--ignore-config',
    '--js-runtimes',
    JAVASCRIPT_RUNTIME,
    '--socket-timeout',
    SOCKET_TIMEOUT_SECONDS,
    '--dump-json',
  ];
  if (singleVideo) {
    args.push('--no-playlist');
  }
  if (options.dateAfter !== undefined) {
    args.push('--dateafter', options.dateAfter, '--break-on-reject');
  }
  appendProxyArgument(args, options.proxyUrl);
  args.push(options.url);
  return args;
}

async function fetchJsonLines(
  options: FetchOptions,
  singleVideo: boolean,
): Promise<readonly unknown[]> {
  const result = await runProcess(
    options,
    fetchArgs(options, singleVideo),
    FETCH_PROCESS_TIMEOUT_MILLISECONDS,
    undefined,
    undefined,
    undefined,
    options.dateAfter === undefined ? [] : [101],
  );
  if (result.stdoutLines.length === 0 && options.allowEmpty !== true) {
    throw processError('yt-dlp produced no JSON output', options.proxyUrl);
  }

  try {
    return result.stdoutLines.map((line) => JSON.parse(line) as unknown);
  } catch {
    throw processError('yt-dlp produced malformed JSON output', options.proxyUrl);
  }
}

export function fetchChannelEntries(
  options: FetchOptions,
): Promise<readonly unknown[]> {
  return fetchJsonLines(options, false);
}

export async function fetchVideoMetadata(options: FetchOptions): Promise<unknown> {
  const values = await fetchJsonLines(options, true);
  if (values.length !== 1) {
    throw processError(
      'yt-dlp produced multiple JSON values for a video probe',
      options.proxyUrl,
    );
  }
  return values[0];
}

export async function downloadMedia(options: DownloadOptions): Promise<string> {
  const format =
    options.advancedOptions?.format ??
    (options.advancedOptions?.mediaType === 'audio'
      ? 'bestaudio/best'
      : DOWNLOAD_FORMAT);
  const args = [
    '--ignore-config',
    '--js-runtimes',
    JAVASCRIPT_RUNTIME,
    '--socket-timeout',
    SOCKET_TIMEOUT_SECONDS,
    '--format',
    format,
    '--progress',
    '--newline',
    '--progress-template',
    'download:vidharbor-progress:%(progress._percent_str)s|%(progress._speed_str)s|%(progress.eta)s',
    '--output',
    options.outputTemplate,
    '--print',
    'after_move:filepath',
  ];
  if (options.advancedOptions?.writeSubtitles === true) {
    args.push('--write-subs');
  }
  if (options.advancedOptions?.writeThumbnail === true) {
    args.push('--write-thumbnail');
  }
  if (options.advancedOptions?.splitChapters === true) {
    args.push('--split-chapters');
  }
  if (options.advancedOptions?.quality !== null && options.advancedOptions?.quality !== undefined) {
    args.push('--format-sort', `res:${options.advancedOptions.quality}`);
  }
  if (options.advancedOptions?.codec !== null && options.advancedOptions?.codec !== undefined) {
    args.push('--recode-video', options.advancedOptions.codec);
  }
  if (
    options.advancedOptions?.timeRangeStart !== null &&
    options.advancedOptions?.timeRangeStart !== undefined &&
    options.advancedOptions.timeRangeEnd !== null
  ) {
    args.push(
      '--download-sections',
      `*${options.advancedOptions.timeRangeStart}-${options.advancedOptions.timeRangeEnd}`,
    );
  }
  appendProxyArgument(args, options.proxyUrl);
  args.push(options.url);

  const handleProgressLine = (line: string): boolean => {
    const progress = parseDownloadProgress(line);
    if (progress === null) return false;
    options.onProgress?.(progress);
    return true;
  };
  const result = await runProcess(
    options,
    args,
    undefined,
    DOWNLOAD_INACTIVITY_TIMEOUT_MILLISECONDS,
    options.signal,
    handleProgressLine,
    [],
    handleProgressLine,
  );
  const filePathLines: string[] = [];
  for (const line of result.stdoutLines) {
    if (parseDownloadProgress(line) === null) filePathLines.push(line);
  }
  if (filePathLines.length === 0 || filePathLines[0] === '') {
    throw processError('yt-dlp produced no after_move filepath', options.proxyUrl);
  }
  if (filePathLines.length > 1) {
    throw processError(
      'yt-dlp produced multiple after_move filepaths',
      options.proxyUrl,
    );
  }
  return filePathLines[0] as string;
}

function parseDownloadProgress(line: string): DownloadProgress | null {
  const prefix = 'vidharbor-progress:';
  if (!line.startsWith(prefix)) return null;
  const parts = line.slice(prefix.length).split('|');
  if (parts.length !== 3) {
    throw new Error('invalid yt-dlp progress line');
  }
  const percentText = (parts[0] as string).trim().replace(/%$/u, '');
  const speedText = (parts[1] as string).trim();
  const etaText = (parts[2] as string).trim();
  const progressPercent = Number(percentText);
  const etaSeconds =
    etaText === '' || etaText === 'NA' || etaText === 'N/A'
      ? null
      : Number(etaText);
  if (
    !Number.isFinite(progressPercent) ||
    progressPercent < 0 ||
    progressPercent > 100 ||
    !(etaSeconds === null || (Number.isSafeInteger(etaSeconds) && etaSeconds >= 0))
  ) {
    throw new Error('invalid yt-dlp progress line');
  }
  return {
    progressPercent,
    speedText:
      speedText === '' || speedText === 'NA' || speedText === 'N/A'
        ? null
        : speedText,
    etaSeconds,
  };
}
