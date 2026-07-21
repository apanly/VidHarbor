import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  downloadMedia,
  fetchChannelEntries,
  fetchVideoMetadata,
} from '../../src/yt-dlp.js';
import { CookieAuthorizationService } from '../../src/services/cookie-authorization.js';
import {
  isYtDlpTaskCancellationError,
  YtDlpTaskManager,
} from '../../src/yt-dlp-task-manager.js';

const executablePath = fileURLToPath(
  new URL('../fixtures/fake-yt-dlp.mjs', import.meta.url),
);
const COOKIE_VALUE_MARKER = 'task-09-cookie-value';
const VALID_COOKIE_FILE = Buffer.from(
  `.youtube.com\tTRUE\t/\tTRUE\t0\ttask09\t${COOKIE_VALUE_MARKER}\n`,
);

interface YtDlpInvocation {
  readonly args: string[];
  readonly cookieArgumentReference: boolean;
  readonly cookieValueArgumentReference: boolean;
  readonly cookieStorageArgumentReference: boolean;
  readonly cookieEnvironmentNameReference: boolean;
  readonly cookieEnvironmentReference: boolean;
}

function expectNoCookieArguments(invocation: YtDlpInvocation): void {
  expect(invocation.cookieArgumentReference).toBe(false);
  expect(invocation.cookieValueArgumentReference).toBe(false);
  expect(invocation.cookieStorageArgumentReference).toBe(false);
  expect(invocation.cookieEnvironmentNameReference).toBe(false);
  expect(invocation.cookieEnvironmentReference).toBe(false);
}

beforeAll(async () => {
  await chmod(executablePath, 0o755);
});

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ESRCH'
      ) {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`process ${String(pid)} still exists after cancellation`);
}

async function expectCompleteProcessTreeCancellation(
  start: (signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-process-tree-'));
  const pidPath = join(sandbox, 'child.pid');
  process.env.VIDHARBOR_FAKE_CHILD_PID_PATH = pidPath;
  const controller = new AbortController();
  const operation = start(controller.signal).catch((error: unknown) => error);

  let childPid = 0;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await access(pidPath);
        childPid = Number(await readFile(pidPath, 'utf8'));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    expect(childPid).toBeGreaterThan(0);
    controller.abort();
    const settled = await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    if (!settled) process.kill(childPid, 'SIGKILL');
    expect(settled).toBe(true);
    await expectProcessGone(childPid);
    await expect(operation).resolves.toSatisfy(isYtDlpTaskCancellationError);
  } finally {
    delete process.env.VIDHARBOR_FAKE_CHILD_PID_PATH;
    if (childPid > 0) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // The process group cancellation already removed it.
      }
    }
    await operation;
    await rm(sandbox, { recursive: true, force: true });
  }
}

describe('yt-dlp argument protocol', () => {
  it('passes fetch arguments as an array with one proxy option', async () => {
    const proxyUrl = 'http://alice:s3cret@proxy.example:8080';
    const [result] = await fetchChannelEntries({
      executablePath,
      url: 'fixture://echo',
      proxyUrl,
    });

    expect(result).toEqual({
      args: [
        '--ignore-config',
        '--js-runtimes',
        'node',
        '--socket-timeout',
        '30',
        '--dump-json',
        '--proxy',
        proxyUrl,
        'fixture://echo',
      ],
    });
  });

  it('omits proxy and cookie options for direct fetches after a Cookie is saved', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-yt-dlp-cookie-'));
    const cookieStorageDirectory = join(sandbox, 'cookies');
    const boundaryExecutablePath = join(sandbox, 'fake-yt-dlp.mjs');
    const cookieAuthorizationService = new CookieAuthorizationService(
      cookieStorageDirectory,
    );

    try {
      await writeFile(
        boundaryExecutablePath,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
const cookieArgumentReference = args.some((argument) =>
  argument === '--cookies' ||
  argument.startsWith('--cookies=') ||
  argument === '--cookies-from-browser' ||
  argument.startsWith('--cookies-from-browser=') ||
  /^cookie:/iu.test(argument)
);
const cookieValueArgumentReference = args.some((argument) =>
  argument.includes(${JSON.stringify(COOKIE_VALUE_MARKER)})
);
const cookieStorageArgumentReference = args.some((argument) =>
  argument.includes(${JSON.stringify(cookieStorageDirectory)})
);
const sanitizedArgs = args.filter((argument, index) => {
  const previous = args[index - 1];
  return argument !== '--cookies' &&
    !argument.startsWith('--cookies=') &&
    argument !== '--cookies-from-browser' &&
    !argument.startsWith('--cookies-from-browser=') &&
    previous !== '--cookies' &&
    previous !== '--cookies-from-browser' &&
    !/^cookie:/iu.test(argument) &&
    !argument.includes(${JSON.stringify(COOKIE_VALUE_MARKER)}) &&
    !argument.includes(${JSON.stringify(cookieStorageDirectory)});
});
const cookieEnvironmentNameReference = Object.keys(process.env).some((name) => /cookie/iu.test(name));
const cookieEnvironmentReference = Object.values(process.env).some((value) =>
  value?.includes(${JSON.stringify(COOKIE_VALUE_MARKER)}) ||
  value?.includes(${JSON.stringify(cookieStorageDirectory)})
);
process.stdout.write(JSON.stringify({ args: sanitizedArgs, cookieArgumentReference, cookieValueArgumentReference, cookieStorageArgumentReference, cookieEnvironmentNameReference, cookieEnvironmentReference }) + '\\n');
`,
        'utf8',
      );
      await chmod(boundaryExecutablePath, 0o755);
      await cookieAuthorizationService.initialize();
      await cookieAuthorizationService.saveConfiguration(
        'youtube',
        Readable.from([VALID_COOKIE_FILE]),
      );
      const [result] = await fetchChannelEntries({
        executablePath: boundaryExecutablePath,
        url: 'fixture://echo',
      });
      const invocation = result as unknown as YtDlpInvocation;

      expect(invocation.args).not.toContain('--proxy');
      expectNoCookieArguments(invocation);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('disables playlist expansion for a single-resource probe', async () => {
    const result = await fetchVideoMetadata({
      executablePath,
      url: 'fixture://echo',
    });
    const args = (result as { args: string[] }).args;

    expect(args).toContain('--no-playlist');
  });

  it('passes the manual history boundary and stops after the first rejected entry', async () => {
    const [result] = await fetchChannelEntries({
      executablePath,
      url: 'fixture://echo',
      dateAfter: '20260618',
    });
    const args = (result as { args: string[] }).args;

    expect(args).toContain('--dateafter');
    expect(args).toContain('20260618');
    expect(args).toContain('--break-on-reject');
  });

  it('keeps Bilibili space entries flat for explicit ordinary-video parsing', async () => {
    const [result] = await fetchChannelEntries({
      executablePath,
      url: 'fixture://echo',
      flatPlaylist: true,
    });
    const args = (result as { args: string[] }).args;

    expect(args).toContain('--flat-playlist');
    expect(args).not.toContain('--dateafter');
  });

  it('treats exit 101 as a normal date-boundary stop only for ranged fetches', async () => {
    await expect(fetchChannelEntries({
      executablePath,
      url: 'fixture://date-boundary-reached',
      dateAfter: '20260618',
      allowEmpty: true,
    })).resolves.toEqual([]);

    await expect(fetchChannelEntries({
      executablePath,
      url: 'fixture://date-boundary-reached',
      allowEmpty: true,
    })).rejects.toThrow('yt-dlp exited with exit code 101');
  });

  it('uses the fixed download format, after-move output, and progress protocol', async () => {
    const result = await downloadMedia({
      executablePath,
      url: 'fixture://echo',
      outputTemplate: '/temporary/%(id)s.%(ext)s',
    });

    expect(result).toBe(
      JSON.stringify({
        args: [
          '--ignore-config',
          '--js-runtimes',
          'node',
          '--socket-timeout',
          '30',
          '--no-playlist',
          '--format',
          'bestvideo*+bestaudio/best',
          '--progress',
          '--newline',
          '--progress-template',
          'download:vidharbor-progress:%(progress._percent_str)s|%(progress._speed_str)s|%(progress.eta)s',
          '--output',
          '/temporary/%(id)s.%(ext)s',
          '--print',
          'after_move:filepath',
          'fixture://echo',
        ],
      }),
    );
  });

});

describe('yt-dlp process results', () => {
  it('cancels the complete download process tree', async () => {
    await expectCompleteProcessTreeCancellation((signal) =>
      downloadMedia({
        executablePath,
        url: 'fixture://child-tree-download',
        outputTemplate: '/temporary/%(id)s.%(ext)s',
        signal,
      }),
    );
  });

  it('cancels the complete channel fetch process tree', async () => {
    await expectCompleteProcessTreeCancellation((signal) =>
      fetchChannelEntries({
        executablePath,
        url: 'fixture://child-tree-channel-fetch',
        signal,
      }),
    );
  });

  it('cancels the complete video metadata process tree', async () => {
    await expectCompleteProcessTreeCancellation((signal) =>
      fetchVideoMetadata({
        executablePath,
        url: 'fixture://child-tree-video-metadata',
        signal,
      }),
    );
  });

  it('surfaces a process-group termination failure', async () => {
    const controller = new AbortController();
    const originalKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0) throw new Error('group kill denied');
      return originalKill(pid, signal);
    });
    try {
      const result = downloadMedia({
        executablePath,
        url: 'fixture://slow-download',
        outputTemplate: '/temporary/%(id)s.%(ext)s',
        signal: controller.signal,
      });

      controller.abort();

      await expect(result).rejects.toThrow(
        'yt-dlp process group termination failed: group kill denied',
      );
    } finally {
      kill.mockRestore();
    }
  });

  it('preserves a process-group termination failure through manager stop', async () => {
    const originalKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0) throw new Error('group kill denied');
      return originalKill(pid, signal);
    });
    const manager = new YtDlpTaskManager(executablePath, 1, (message) => message);
    const handle = manager.submit({
      type: 'media_download',
      execute: (operations) =>
        operations.downloadMedia({
          url: 'fixture://slow-download',
          outputTemplate: '/temporary/%(id)s.%(ext)s',
        }),
    });
    const result = handle.result.catch((error: unknown) => error);

    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const stop = manager.stop();
      const failure = await result;

      const stopFailure = await stop.catch((error: unknown) => error);
      expect(stopFailure).toBeInstanceOf(AggregateError);
      expect((stopFailure as AggregateError).errors).toEqual([failure]);
      expect(failure).toEqual(
        new Error('yt-dlp process group termination failed: group kill denied'),
      );
      expect(manager.getSnapshot()[0]).toMatchObject({
        status: 'failed',
        failureReason: 'yt-dlp process group termination failed: group kill denied',
      });
    } finally {
      kill.mockRestore();
    }
  });

  it('converges a canceled real manager operation as canceled', async () => {
    const manager = new YtDlpTaskManager(executablePath, 1, (message) => message);
    const handle = manager.submit({
      type: 'media_download',
      execute: (operations) =>
        operations.downloadMedia({
          url: 'fixture://slow-download',
          outputTemplate: '/temporary/%(id)s.%(ext)s',
        }),
    });
    const result = handle.result.catch((error: unknown) => error);

    for (
      let attempt = 0;
      attempt < 100 && manager.getSnapshot()[0]?.status !== 'running';
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(manager.getSnapshot()[0]?.status).toBe('running');

    await expect(manager.cancel(handle.id)).resolves.toBeUndefined();
    expect(await result).toSatisfy(isYtDlpTaskCancellationError);
    expect(manager.getSnapshot()[0]).toMatchObject({
      status: 'canceled',
      failureReason: null,
    });
  });

  it('preserves a startup failure when the signal is already canceled', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'vidharbor-missing-yt-dlp-'));
    const controller = new AbortController();
    controller.abort();
    try {
      const result = fetchChannelEntries({
        executablePath: join(sandbox, 'missing-yt-dlp'),
        url: 'fixture://echo',
        signal: controller.signal,
      }).catch((error: unknown) => error);

      const failure = await result;
      expect(isYtDlpTaskCancellationError(failure)).toBe(false);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('yt-dlp failed to start');
      expect((failure as Error).message).toContain('ENOENT');
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('returns every JSON line across chunks without counting empty end remainders', async () => {
    await expect(
      fetchChannelEntries({ executablePath, url: 'fixture://channel-success' }),
    ).resolves.toEqual([{ id: 'first' }, { id: 'second' }]);
  });

  it('requires exactly one JSON line for a video probe', async () => {
    await expect(
      fetchVideoMetadata({ executablePath, url: 'fixture://video-success' }),
    ).resolves.toEqual({ id: 'video' });
    await expect(
      fetchVideoMetadata({ executablePath, url: 'fixture://channel-success' }),
    ).rejects.toThrow('produced multiple JSON values for a video probe');
  });

  it('reports download progress before the process exits', async () => {
    const progressEvents: Array<{
      progressPercent: number;
      speedText: string | null;
      etaSeconds: number | null;
    }> = [];
    let settled = false;
    const operation = downloadMedia({
      executablePath,
      url: 'fixture://download-progress-before-exit',
      outputTemplate: '/temporary/%(id)s.%(ext)s',
      onProgress: (progress) => progressEvents.push(progress),
    }).finally(() => {
      settled = true;
    });

    for (let attempt = 0; attempt < 100 && progressEvents.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(settled).toBe(false);
    expect(progressEvents).toEqual([
      { progressPercent: 42.5, speedText: '1.2MiB/s', etaSeconds: 17 },
    ]);
    await expect(operation).resolves.toBe('/temporary/video.mp4');
  });

  it('parses yt-dlp human progress fields', async () => {
    const progressEvents: Array<{
      progressPercent: number;
      speedText: string | null;
      etaSeconds: number | null;
    }> = [];

    await downloadMedia({
      executablePath,
      url: 'fixture://download-human-progress',
      outputTemplate: '/temporary/%(id)s.%(ext)s',
      onProgress: (progress) => progressEvents.push(progress),
    });

    expect(progressEvents).toEqual([
      { progressPercent: 7.8, speedText: '928.19KiB/s', etaSeconds: 93 },
      { progressPercent: 100, speedText: null, etaSeconds: null },
    ]);
  });

  it('rejects a negative fractional ETA', async () => {
    await expect(downloadMedia({
      executablePath,
      url: 'fixture://download-negative-fractional-eta',
      outputTemplate: '/temporary/%(id)s.%(ext)s',
    })).rejects.toThrow('invalid yt-dlp progress line');
  });

  it('returns one after_move filepath without counting its empty end remainder', async () => {
    await expect(
      downloadMedia({
        executablePath,
        url: 'fixture://download-success',
        outputTemplate: '/temporary/%(id)s.%(ext)s',
      }),
    ).resolves.toBe('/temporary/video.mp4');
  });

  it('rejects nonzero close and redacts then limits stderr without retrying direct', async () => {
    const proxyUrl = 'http://alice:s3cret@proxy.example:8080';

    await expect(
      fetchChannelEntries({
        executablePath,
        url: 'fixture://nonzero',
        proxyUrl,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('exit code 3');
      expect(message).toContain('http://***@proxy.example:8080');
      expect(message).not.toContain('alice');
      expect(message).not.toContain('s3cret');
      expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(4096);
      return true;
    });
  });

  it('rejects termination by signal', async () => {
    await expect(
      fetchChannelEntries({ executablePath, url: 'fixture://signal' }),
    ).rejects.toThrow('signal SIGTERM');
  });

  it('kills and rejects a fetch that exceeds the 15 minute process limit', async () => {
    vi.useFakeTimers();
    try {
      const result = fetchChannelEntries({
        executablePath,
        url: 'fixture://hang',
      });
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

      await expect(result).rejects.toThrow('timed out after 900000 ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills and rejects a download with no process output for 15 minutes', async () => {
    vi.useFakeTimers();
    try {
      const result = downloadMedia({
        executablePath,
        url: 'fixture://slow-download',
        outputTemplate: '/temporary/%(id)s.%(ext)s',
      });
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

      await expect(result).rejects.toThrow('no output for 900000 ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills and rejects a cancelled download', async () => {
    const controller = new AbortController();
    const result = downloadMedia({
      executablePath,
      url: 'fixture://slow-download',
      outputTemplate: '/temporary/%(id)s.%(ext)s',
      signal: controller.signal,
    });

    controller.abort();

    await expect(result).rejects.toSatisfy(isYtDlpTaskCancellationError);
  });

  it('rejects malformed JSON even when the process exits zero', async () => {
    await expect(
      fetchChannelEntries({ executablePath, url: 'fixture://malformed' }),
    ).rejects.toThrow('malformed JSON output');
  });

  it.each(['fixture://json-lf-empty-line', 'fixture://json-crlf-empty-line'])(
    'rejects a complete empty JSON line from %s',
    async (url) => {
      await expect(
        fetchChannelEntries({ executablePath, url }),
      ).rejects.toThrow('malformed JSON output');
    },
  );

  it('rejects missing JSON and filepath output', async () => {
    await expect(
      fetchChannelEntries({ executablePath, url: 'fixture://missing' }),
    ).rejects.toThrow('produced no JSON output');
    await expect(
      downloadMedia({
        executablePath,
        url: 'fixture://missing',
        outputTemplate: '/temporary/%(id)s.%(ext)s',
      }),
    ).rejects.toThrow('produced no after_move filepath');
  });

  it('rejects multiple after_move filepaths', async () => {
    await expect(
      downloadMedia({
        executablePath,
        url: 'fixture://multiple-downloads',
        outputTemplate: '/temporary/%(id)s.%(ext)s',
      }),
    ).rejects.toThrow('produced multiple after_move filepaths');
  });

  it.each([
    'fixture://download-lf-empty-line',
    'fixture://download-crlf-empty-line',
  ])('rejects a complete empty after_move line from %s', async (url) => {
    await expect(
      downloadMedia({
        executablePath,
        url,
        outputTemplate: '/temporary/%(id)s.%(ext)s',
      }),
    ).rejects.toThrow('produced multiple after_move filepaths');
  });

  it('rejects a sole complete empty after_move line as missing output', async () => {
    await expect(
      downloadMedia({
        executablePath,
        url: 'fixture://download-only-empty-line',
        outputTemplate: '/temporary/%(id)s.%(ext)s',
      }),
    ).rejects.toThrow('produced no after_move filepath');
  });
});
