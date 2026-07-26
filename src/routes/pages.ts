import express, { Router } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { marked } from 'marked';

import {
  createTranslator,
  selectLanguage,
  serializeI18n,
  type Language,
  type TranslationKey,
} from '../i18n.js';

interface PageRoute {
  readonly path: string;
  readonly view: string;
  readonly title: TranslationKey;
  readonly activePath?: string;
}

const PAGE_ROUTES: readonly PageRoute[] = [
  { path: '/', view: 'dashboard', title: 'page.dashboard.title' },
  { path: '/settings', view: 'settings', title: 'page.settings.title' },
  {
    path: '/authorizations',
    view: 'authorizations',
    title: 'page.authorizations.title',
  },
  { path: '/channels', view: 'channels', title: 'page.channels.title' },
  {
    path: '/notifications',
    view: 'notifications',
    title: 'page.notifications.title',
  },
  { path: '/downloads', view: 'downloads', title: 'page.downloads.title' },
  { path: '/database', view: 'database', title: 'page.database.title' },
  {
    path: '/downloads/preview',
    view: 'download-preview',
    title: 'page.preview.title',
    activePath: '/downloads',
  },
];

const excludedStart = '<!-- APP_GUIDE_EXCLUDE_START -->';
const excludedEnd = '<!-- APP_GUIDE_EXCLUDE_END -->';

function renderGuide(readmeUrl: URL, name: string): string {
  const readme = readFileSync(fileURLToPath(readmeUrl), 'utf8');
  const startIndex = readme.indexOf(excludedStart);
  const endIndex = readme.indexOf(excludedEnd);
  if (
    startIndex === -1 ||
    endIndex === -1 ||
    startIndex !== readme.lastIndexOf(excludedStart) ||
    endIndex !== readme.lastIndexOf(excludedEnd) ||
    endIndex < startIndex
  ) {
    throw new Error(`${name} guide exclusion markers are invalid`);
  }
  return marked.parse(
    readme.slice(0, startIndex) +
      readme.slice(endIndex + excludedEnd.length),
    { async: false },
  );
}

function pageLocals(
  cookieHeader: string | undefined,
  title: TranslationKey,
): {
  readonly language: Language;
  readonly t: ReturnType<typeof createTranslator>;
  readonly i18nJson: string;
  readonly pageTitle: string;
} {
  const language = selectLanguage(cookieHeader);
  const t = createTranslator(language);
  return {
    language,
    t,
    i18nJson: serializeI18n(language),
    pageTitle: t(title),
  };
}

export function createPagesRouter(): Router {
  const router = Router();
  const guideHtml: Readonly<Record<Language, string>> = {
    'zh-CN': renderGuide(
      new URL('../../README.md', import.meta.url),
      'README.md',
    ),
    en: renderGuide(
      new URL('../../README.en.md', import.meta.url),
      'README.en.md',
    ),
  };

  router.use(
    '/public',
    express.static(fileURLToPath(new URL('../public', import.meta.url))),
  );

  for (const page of PAGE_ROUTES) {
    router.get(page.path, (request, response) => {
      response.render(page.view, {
        ...pageLocals(request.headers.cookie, page.title),
        currentPath: page.activePath ?? request.path,
      });
    });
  }

  router.get('/guide', (request, response) => {
    const locals = pageLocals(
      request.headers.cookie,
      'page.guide.title',
    );
    response.render('guide', {
      ...locals,
      currentPath: '/guide',
      guideHtml: guideHtml[locals.language],
    });
  });

  router.get('/channels/:id', (request, response) => {
    response.render('channel-detail', {
      ...pageLocals(request.headers.cookie, 'page.channelDetail.title'),
      channelId: Number(request.params.id),
      currentPath: '/channels',
    });
  });

  return router;
}
