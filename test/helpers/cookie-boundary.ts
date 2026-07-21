import { expect } from 'vitest';

export const COOKIE_VALUE_MARKER = 'task-09-cookie-value';
export const VALID_COOKIE_FILE = Buffer.from(
  `.youtube.com\tTRUE\t/\tTRUE\t0\ttask09\t${COOKIE_VALUE_MARKER}\n`,
);

export interface CookieBoundaryObservation {
  readonly cookieArgumentReference: boolean;
  readonly cookieValueArgumentReference: boolean;
  readonly cookieStorageArgumentReference: boolean;
  readonly cookieEnvironmentNameReference: boolean;
  readonly cookieEnvironmentReference: boolean;
  readonly genericCookieEnvironmentFixtureDetected: boolean;
}

export function createCookieBoundaryProbeSource(
  cookieStorageDirectory: string,
): string {
  return `
const cookieArgumentReference = args.some((argument) =>
  argument === '--cookies' || argument.startsWith('--cookies=') ||
  argument === '--cookies-from-browser' || argument.startsWith('--cookies-from-browser=') ||
  /^cookie:/iu.test(argument)
);
const cookieValueArgumentReference = args.some((argument) =>
  argument.includes(${JSON.stringify(COOKIE_VALUE_MARKER)})
);
const cookieStorageArgumentReference = args.some((argument) =>
  argument.includes(${JSON.stringify(cookieStorageDirectory)})
);
const cookieEnvironmentNameReference = Object.keys(process.env).some((name) =>
  /cookie/iu.test(name)
);
const hasCookieEnvironmentReference = (environment) => Object.values(environment).some((value) =>
  typeof value === 'string' && (
    /cookie/iu.test(value) ||
    value.includes(${JSON.stringify(COOKIE_VALUE_MARKER)}) ||
    value.includes(${JSON.stringify(cookieStorageDirectory)})
  )
);
const cookieEnvironmentReference = hasCookieEnvironmentReference(process.env);
const genericCookieEnvironmentFixtureDetected = hasCookieEnvironmentReference({
  VIDHARBOR_TEST_REFERENCE: '--CoOkIeS-from-browser=chromium',
});
const cookieBoundary = {
  cookieArgumentReference,
  cookieValueArgumentReference,
  cookieStorageArgumentReference,
  cookieEnvironmentNameReference,
  cookieEnvironmentReference,
  genericCookieEnvironmentFixtureDetected,
};
`;
}

export function expectNoCookieReferences(
  observation: CookieBoundaryObservation & object,
): void {
  expect(
    Object.values(observation).every((value) => typeof value === 'boolean'),
  ).toBe(true);
  expect(observation.cookieArgumentReference).toBe(false);
  expect(observation.cookieValueArgumentReference).toBe(false);
  expect(observation.cookieStorageArgumentReference).toBe(false);
  expect(observation.cookieEnvironmentNameReference).toBe(false);
  expect(observation.cookieEnvironmentReference).toBe(false);
  expect(observation.genericCookieEnvironmentFixtureDetected).toBe(true);
}
