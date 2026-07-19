import express, { Router } from 'express';
import { fileURLToPath } from 'node:url';

interface PageRoute {
  readonly path: string;
  readonly view: string;
  readonly title: string;
  readonly activePath?: string;
}

const PAGE_ROUTES: readonly PageRoute[] = [
  { path: '/', view: 'dashboard', title: '总览' },
  { path: '/settings', view: 'settings', title: '配置' },
  { path: '/channels', view: 'channels', title: '频道' },
  { path: '/notifications', view: 'notifications', title: '提醒' },
  { path: '/downloads', view: 'downloads', title: '下载' },
  {
    path: '/downloads/preview',
    view: 'download-preview',
    title: '下载预览',
    activePath: '/downloads',
  },
];

export function createPagesRouter(): Router {
  const router = Router();

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

  router.get('/channels/:id', (request, response) => {
    response.render('channel-detail', {
      channelId: Number(request.params.id),
      currentPath: '/channels',
      pageTitle: '频道详情',
    });
  });

  return router;
}
