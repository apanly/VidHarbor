import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BusinessError } from '../../src/errors.js';
import {
  getUtcOneYearBoundary,
  isWithinUtcYearWindow,
  normalizeYouTubeChannelUrl,
  parseYouTubeVideoMetadata,
  parseYouTubeVideoUrl,
} from '../../src/youtube.js';

const fixturePath = fileURLToPath(
  new URL('../fixtures/youtube-metadata.json', import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<
  string,
  Record<string, unknown>
>;

function expectBusinessError(
  operation: () => unknown,
  code: BusinessError['code'],
): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

describe('normalizeYouTubeChannelUrl', () => {
  it.each([
    [
      'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw',
      'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw/videos',
    ],
    [
      'https://www.youtube.com/@YouTubeCreators',
      'https://www.youtube.com/@YouTubeCreators/videos',
    ],
  ])('normalizes the supported channel URL %s', (url, expected) => {
    expect(normalizeYouTubeChannelUrl(url)).toBe(expected);
  });

  it.each([
    'http://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw',
    'https://youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw',
    'https://m.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw',
    'https://www.youtube.com/channel/',
    'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw/',
    'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw/videos',
    'https://www.youtube.com/@YouTubeCreators/',
    'https://www.youtube.com/c/YouTubeCreators',
    'https://www.youtube.com/user/YouTube',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/@YouTubeCreators?view=0',
  ])('rejects the non-contract channel URL %s', (url) => {
    expectBusinessError(
      () => normalizeYouTubeChannelUrl(url),
      'NOT_A_CHANNEL_URL',
    );
  });
});

describe('parseYouTubeVideoUrl', () => {
  it.each([
    'https://www.youtube.com/watch?v=aB_12-cD345',
    'https://youtu.be/aB_12-cD345',
  ])('returns the ID and canonical URL for %s', (url) => {
    expect(parseYouTubeVideoUrl(url)).toEqual({
      videoId: 'aB_12-cD345',
      url: 'https://www.youtube.com/watch?v=aB_12-cD345',
    });
  });

  it.each([
    'http://www.youtube.com/watch?v=aB_12-cD345',
    'https://youtube.com/watch?v=aB_12-cD345',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=aB_12-cD345&list=PL123',
    'https://www.youtube.com/watch?list=PL123&v=aB_12-cD345',
    'https://www.youtube.com/watch/v/aB_12-cD345',
    'https://www.youtube.com/shorts/aB_12-cD345',
    'https://www.youtube.com/live/aB_12-cD345',
    'https://youtu.be/aB_12-cD345/',
    'https://youtu.be/aB_12-cD345?t=3',
    'https://example.com/watch?v=aB_12-cD345',
  ])('rejects the non-contract video URL %s', (url) => {
    expectBusinessError(() => parseYouTubeVideoUrl(url), 'NOT_A_VIDEO_URL');
  });
});

describe('parseYouTubeVideoMetadata', () => {
  it('returns the fixed ordinary-video shape', () => {
    expect(
      parseYouTubeVideoMetadata(fixture.video, 'CHANNEL_METADATA_INVALID'),
    ).toEqual({
      platform: 'youtube',
      platformVideoId: 'aB_12-cD345',
      title: 'A complete ordinary video',
      publishedDate: '2025-07-17',
      url: 'https://www.youtube.com/watch?v=aB_12-cD345',
      durationSeconds: null,
      thumbnailUrl: null,
    });
  });

  it.each(['short', 'live', 'replay', 'unknownStatus'])(
    'rejects the %s fixture instead of skipping it',
    (name) => {
      expectBusinessError(
        () =>
          parseYouTubeVideoMetadata(
            fixture[name],
            'CHANNEL_METADATA_INVALID',
          ),
        'CHANNEL_METADATA_INVALID',
      );
    },
  );

  it.each([
    ['extractor_key', undefined],
    ['extractor_key', 'YoutubeTab'],
    ['id', undefined],
    ['id', 'short'],
    ['title', undefined],
    ['title', '   '],
    ['upload_date', undefined],
    ['upload_date', '20250229'],
    ['webpage_url', undefined],
    ['webpage_url', 'https://youtu.be/aB_12-cD345'],
    ['webpage_url', 'https://www.youtube.com/watch?v=dI_34-fF678'],
    ['live_status', undefined],
  ])('rejects invalid or missing %s metadata', (field, value) => {
    const metadata = { ...fixture.video, [field]: value };

    expectBusinessError(
      () => parseYouTubeVideoMetadata(metadata, 'VIDEO_METADATA_INVALID'),
      'VIDEO_METADATA_INVALID',
    );
  });
});

describe('UTC year window', () => {
  it.each([
    ['2026-07-17T23:59:59.999Z', '2025-07-17'],
    ['2024-02-29T12:30:00.000Z', '2023-02-28'],
  ])('calculates the inclusive boundary for %s', (startedAt, expected) => {
    expect(getUtcOneYearBoundary(new Date(startedAt))).toBe(expected);
  });

  it('includes both boundary dates and excludes dates outside them', () => {
    const startedAt = new Date('2026-07-17T08:00:00.000Z');

    expect(isWithinUtcYearWindow('2025-07-17', startedAt)).toBe(true);
    expect(isWithinUtcYearWindow('2026-07-17', startedAt)).toBe(true);
    expect(isWithinUtcYearWindow('2025-07-16', startedAt)).toBe(false);
    expect(isWithinUtcYearWindow('2026-07-18', startedAt)).toBe(false);
  });
});
