#!/usr/bin/env node

import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const url = args.at(-1);

if (url?.startsWith('fixture://worker-')) {
  const controlDirectory = process.env.VIDHARBOR_FAKE_YT_DLP_DIR;
  if (controlDirectory === undefined) {
    throw new Error('VIDHARBOR_FAKE_YT_DLP_DIR is required for worker fixtures');
  }

  const outputIndex = args.indexOf('--output');
  if (outputIndex === -1 || args[outputIndex + 1] === undefined) {
    throw new Error('--output is required for worker fixtures');
  }
  const output = args[outputIndex + 1];
  const id = url.includes('second') ? 'eF_67-gH890' : 'aB_12-cD345';
  if (args.includes('--skip-download')) {
    if (!args.includes('--write-thumbnail') || !args.includes('--no-playlist')) {
      throw new Error('thumbnail arguments are required');
    }
    if (url.includes('thumbnail-failure')) {
      process.stderr.write('thumbnail unavailable\n');
      process.exit(7);
    }
    const thumbnailPath = output.replace('%(id)s', id).replace('%(ext)s', 'jpg');
    await mkdir(dirname(thumbnailPath), { recursive: true });
    await writeFile(thumbnailPath, 'thumbnail');
    process.exit(0);
  }
  const filepath = output.replace('%(id)s', id).replace('%(ext)s', 'mp4');
  await appendFile(join(controlDirectory, 'argv.log'), `${JSON.stringify(args)}\n`);
  await appendFile(join(controlDirectory, 'execution.log'), `start:${url}\n`);

  if (url === 'fixture://worker-block-first') {
    const runningPath = join(controlDirectory, 'first.running');
    const releasePath = join(controlDirectory, 'first.release');
    await writeFile(runningPath, 'running');
    for (;;) {
      try {
        await access(releasePath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }
  if (url === 'fixture://worker-progress-block') {
    await writeFile(join(controlDirectory, 'progress.running'), 'running');
    process.stderr.write('vidharbor-progress:42.5|1.2MiB/s|17\n');
    const releasePath = join(controlDirectory, 'progress.release');
    for (;;) {
      try {
        await access(releasePath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }
  if (url.includes('exit-failure')) {
    process.stderr.write(
      'FFmpeg failed via http://alice:secret@proxy.example:8080',
    );
    process.exit(7);
  }

  await mkdir(dirname(filepath), { recursive: true });
  if (!url.includes('no-file')) {
    await writeFile(filepath, url.includes('zero') ? '' : 'media');
  }
  if (url.includes('multiple')) {
    await writeFile(join(dirname(filepath), 'extra.webm'), 'extra');
  }
  if (url.includes('outside')) {
    const outside = join(controlDirectory, 'outside.mp4');
    await writeFile(outside, 'outside');
    await appendFile(join(controlDirectory, 'execution.log'), `end:${url}\n`);
    process.stdout.write(`${outside}\n`);
    process.exit(0);
  }

  await appendFile(join(controlDirectory, 'execution.log'), `end:${url}\n`);
  if (url.includes('progress')) {
    process.stderr.write('vidharbor-progress:42.5|1.2MiB/s|17\n');
  }
  process.stdout.write(`${filepath}\n`);
  process.exit(0);
}

switch (url) {
  case 'fixture://echo':
    process.stdout.write(`${JSON.stringify({ args })}\n`);
    break;
  case 'fixture://channel-success':
    process.stdout.write(`${JSON.stringify({ id: 'first' })}\n`);
    setTimeout(() => {
      process.stdout.write(`${JSON.stringify({ id: 'second' })}\n`);
    }, 20);
    break;
  case 'fixture://json-lf-empty-line':
    process.stdout.write(JSON.stringify({ id: 'video' }));
    setTimeout(() => {
      process.stdout.write('\n\n');
    }, 20);
    break;
  case 'fixture://json-crlf-empty-line':
    process.stdout.write(`${JSON.stringify({ id: 'video' })}\r\n\r\n`);
    break;
  case 'fixture://video-success':
    process.stdout.write(`${JSON.stringify({ id: 'video' })}\n`);
    break;
  case 'fixture://date-boundary-reached':
    process.exit(101);
    break;
  case 'fixture://download-success':
    process.stdout.write('/temporary/video.mp4\n');
    break;
  case 'fixture://download-progress-before-exit':
    process.stdout.write('vidharbor-progress:42.5|1.2MiB/s|17\n');
    setTimeout(() => {
      process.stdout.write('/temporary/video.mp4\n');
    }, 100);
    break;
  case 'fixture://download-human-progress':
    process.stdout.write('vidharbor-progress:  7.8%| 928.19KiB/s|92.1\n');
    process.stdout.write('vidharbor-progress:100.0%|   N/A|NA\n');
    process.stdout.write('/temporary/video.mp4\n');
    break;
  case 'fixture://download-negative-fractional-eta':
    process.stdout.write('vidharbor-progress:42.5%|1.2MiB/s|-0.1\n');
    process.stdout.write('/temporary/video.mp4\n');
    break;
  case 'fixture://download-lf-empty-line':
    process.stdout.write('/temporary/video.mp4');
    setTimeout(() => {
      process.stdout.write('\n\n');
    }, 20);
    break;
  case 'fixture://download-crlf-empty-line':
    process.stdout.write('/temporary/video.mp4\r\n\r\n');
    break;
  case 'fixture://download-only-empty-line':
    process.stdout.write('\n');
    break;
  case 'fixture://slow-download':
    setTimeout(() => {
      process.stdout.write('/temporary/slow-video.mp4\n');
    }, 50);
    break;
  case 'fixture://nonzero': {
    const proxyIndex = args.indexOf('--proxy');
    const proxy = proxyIndex === -1 ? 'no proxy' : args[proxyIndex + 1];
    process.stderr.write(`request failed via ${proxy}\n${'x'.repeat(5000)}`);
    process.exitCode = 3;
    break;
  }
  case 'fixture://signal':
    process.kill(process.pid, 'SIGTERM');
    break;
  case 'fixture://hang':
    setInterval(() => {}, 1000);
    break;
  case 'fixture://child-tree-download':
  case 'fixture://child-tree-channel-fetch':
  case 'fixture://child-tree-video-metadata': {
    const pidPath = process.env.VIDHARBOR_FAKE_CHILD_PID_PATH;
    if (pidPath === undefined) throw new Error('child PID path is required');
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'inherit' },
    );
    await writeFile(pidPath, String(child.pid));
    setInterval(() => {}, 1000);
    break;
  }
  case 'fixture://malformed':
    process.stdout.write('{not json}\n');
    break;
  case 'fixture://missing':
    break;
  case 'fixture://multiple-downloads':
    process.stdout.write('/temporary/first.mp4\n/temporary/second.mp4\n');
    break;
  default:
    process.stderr.write(`unknown fixture URL: ${url}\n`);
    process.exitCode = 2;
}
