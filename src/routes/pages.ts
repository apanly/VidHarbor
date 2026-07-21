import express, { Router } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { marked } from 'marked';

interface PageRoute {
  readonly path: string;
  readonly view: string;
  readonly title: string;
  readonly activePath?: string;
}

const PAGE_ROUTES: readonly PageRoute[] = [
  { path: '/', view: 'dashboard', title: '总览' },
  { path: '/settings', view: 'settings', title: '配置' },
  { path: '/authorizations', view: 'authorizations', title: '授权管理' },
  { path: '/channels', view: 'channels', title: '频道' },
  { path: '/notifications', view: 'notifications', title: '提醒' },
  { path: '/downloads', view: 'downloads', title: '下载' },
  { path: '/database', view: 'database', title: '数据库' },
  {
    path: '/downloads/preview',
    view: 'download-preview',
    title: '下载预览',
    activePath: '/downloads',
  },
];

export function createPagesRouter(): Router {
  const router = Router();
  const readme = readFileSync(
    fileURLToPath(new URL('../../README.md', import.meta.url)),
    'utf8',
  );
  const excludedStart = '<!-- APP_GUIDE_EXCLUDE_START -->';
  const excludedEnd = '<!-- APP_GUIDE_EXCLUDE_END -->';
  const excludedStartIndex = readme.indexOf(excludedStart);
  const excludedEndIndex = readme.indexOf(excludedEnd);
  if (
    excludedStartIndex === -1 ||
    excludedEndIndex === -1 ||
    excludedEndIndex < excludedStartIndex
  ) {
    throw new Error('README guide exclusion markers are invalid');
  }
  const guideMarkdown =
    readme.slice(0, excludedStartIndex) +
    readme.slice(excludedEndIndex + excludedEnd.length);
  const guideHtml = marked.parse(
    guideMarkdown,
    { async: false },
  );

  router.use(
    '/public',
    express.static(fileURLToPath(new URL('../public', import.meta.url))),
  );

  for (const page of PAGE_ROUTES) {
    router.get(page.path, (request, response) => {
      response.render(page.view, {
        currentPath: page.activePath ?? request.path,
        pageTitle: page.title,
      });
    });
  }

  router.get('/guide', (_request, response) => {
    response.render('guide', {
      currentPath: '/guide',
      pageTitle: '项目说明',
      guideHtml,
    });
  });

  router.get('/channels/:id', (request, response) => {
    response.render('channel-detail', {
      channelId: Number(request.params.id),
      currentPath: '/channels',
      pageTitle: '频道详情',
    });
  });

  return router;
}
