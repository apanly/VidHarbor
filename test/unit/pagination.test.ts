import { describe, expect, it } from 'vitest';

import {
  PAGE_SIZE,
  pageOffset,
  pagination,
  parsePage,
  parseQuery,
} from '../../src/http/pagination.js';

describe('pagination contract', () => {
  it('uses a fixed page size and calculates offsets and totals', () => {
    expect(PAGE_SIZE).toBe(20);
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage('2')).toBe(2);
    expect(pageOffset(3)).toBe(40);
    expect(pagination(2, 41)).toEqual({
      page: 2,
      pageSize: 20,
      totalItems: 41,
      totalPages: 3,
    });
    expect(pagination(1, 0).totalPages).toBe(0);
  });

  it.each([
    null,
    '',
    '0',
    '01',
    '-1',
    '1.5',
    'x',
    ['1'],
    '9007199254740991',
  ])('rejects invalid page %j', (value) => {
    expect(() => parsePage(value)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  it('accepts an exact query string and rejects arrays or surrounding whitespace', () => {
    expect(parseQuery(undefined)).toBe('');
    expect(parseQuery('视频')).toBe('视频');
    expect(() => parseQuery(' 视频 ')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(() => parseQuery(['视频'])).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });
});
