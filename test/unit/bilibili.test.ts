import { describe, expect, it } from 'vitest';

import {
  parseBilibiliChannelUrl,
  parseBilibiliFlatVideoUrl,
  parseBilibiliVideoMetadata,
} from '../../src/bilibili.js';

const VIDEO_ID = 'BV13x41117TL';
const VIDEO_URL = `https://www.bilibili.com/video/${VIDEO_ID}`;

describe('Bilibili channel contract', () => {
  it('accepts only the canonical numeric UP space URL', () => {
    expect(parseBilibiliChannelUrl('https://space.bilibili.com/3985676')).toEqual({
      platform: 'bilibili',
      extractor: 'BilibiliSpaceVideo',
      platformChannelId: '3985676',
      fetchUrl: 'https://space.bilibili.com/3985676/video',
    });
  });

  it.each([
    'http://space.bilibili.com/3985676',
    'https://www.bilibili.com/3985676',
    'https://space.bilibili.com/0',
    'https://space.bilibili.com/3985676/',
    'https://space.bilibili.com/3985676/video',
    'https://space.bilibili.com/name',
  ])('rejects the non-contract space URL %s', (url) => {
    expect(() => parseBilibiliChannelUrl(url)).toThrowError(
      expect.objectContaining({ code: 'NOT_A_CHANNEL_URL' }),
    );
  });

  it('accepts ordinary flat entries and excludes collection entries', () => {
    expect(parseBilibiliFlatVideoUrl({
      _type: 'url',
      ie_key: 'BiliBili',
      id: VIDEO_ID,
      url: VIDEO_URL,
    })).toBe(VIDEO_URL);
    expect(parseBilibiliFlatVideoUrl({
      _type: 'url',
      ie_key: 'BilibiliCollectionList',
      id: '3985676_123',
      url: 'https://space.bilibili.com/3985676/lists/123?type=season',
    })).toBeNull();
  });

  it('parses the first part of an ordinary Bilibili submission', () => {
    expect(parseBilibiliVideoMetadata({
      extractor_key: 'BiliBili',
      id: `${VIDEO_ID}_p1`,
      uploader_id: '3985676',
      title: 'First part',
      upload_date: '20260718',
      webpage_url: VIDEO_URL,
      duration: 10.2,
      thumbnail: 'https://i.example/cover.jpg',
    }, '3985676', VIDEO_URL)).toEqual({
      platform: 'bilibili',
      platformVideoId: VIDEO_ID,
      title: 'First part',
      publishedDate: '2026-07-18',
      url: VIDEO_URL,
      durationSeconds: 11,
      thumbnailUrl: 'https://i.example/cover.jpg',
    });
  });

  it.each([
    ['extractor_key', 'Youtube'],
    ['id', 'BV13x41117TX'],
    ['uploader_id', '9'],
    ['title', ''],
    ['upload_date', '20260229'],
    ['webpage_url', 'https://www.bilibili.com/video/BV13x41117TX'],
  ])('rejects invalid %s metadata', (field, value) => {
    const metadata = {
      extractor_key: 'BiliBili',
      id: VIDEO_ID,
      uploader_id: '3985676',
      title: 'Video',
      upload_date: '20260718',
      webpage_url: VIDEO_URL,
      [field]: value,
    };
    expect(() => parseBilibiliVideoMetadata(metadata, '3985676', VIDEO_URL))
      .toThrowError(expect.objectContaining({ code: 'CHANNEL_METADATA_INVALID' }));
  });
});
