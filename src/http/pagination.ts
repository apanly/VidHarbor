import { BusinessError } from '../errors.js';

export const PAGE_SIZE = 20;

export interface Pagination {
  readonly page: number;
  readonly pageSize: typeof PAGE_SIZE;
  readonly totalItems: number;
  readonly totalPages: number;
}

export interface Paginated<T> {
  readonly items: readonly T[];
  readonly pagination: Pagination;
}

export function parsePage(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid page');
  }
  const page = Number(value);
  if (
    !Number.isSafeInteger(page) ||
    !Number.isSafeInteger((page - 1) * PAGE_SIZE)
  ) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid page');
  }
  return page;
}

export function pageOffset(page: number): number {
  return (page - 1) * PAGE_SIZE;
}

export function pagination(page: number, totalItems: number): Pagination {
  return {
    page,
    pageSize: PAGE_SIZE,
    totalItems,
    totalPages: Math.ceil(totalItems / PAGE_SIZE),
  };
}

export function parseQuery(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new BusinessError('VALIDATION_ERROR', 'invalid query');
  }
  return value;
}
