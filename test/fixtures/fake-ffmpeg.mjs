#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

const [mode, outputPath] = process.argv.slice(2);

if (mode === 'failure') {
  process.stderr.write('fake FFmpeg failed\n');
  process.exit(12);
}

if (mode !== 'success' || outputPath === undefined) {
  process.stderr.write('invalid fake FFmpeg invocation\n');
  process.exit(2);
}

await writeFile(outputPath, 'fake media');
