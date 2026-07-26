import { formatApiError, t } from '/public/i18n.js';

const player = document.querySelector('#preview-player');
const errorRegion = document.querySelector('#preview-error');

async function request(path) { const response = await fetch(path, { credentials: 'same-origin' }); const result = await response.json(); if (!response.ok) throw result.error; return result; }
function parseDownloadId(value) { if (!/^[1-9]\d*$/.test(value ?? '')) return null; const id = Number(value); return Number.isSafeInteger(id) ? id : null; }
function showPreviewError(region, message) { region.textContent = message; region.hidden = false; }
function renderPreview(download, rawId, media, page, region) {
  const id = parseDownloadId(rawId);
  if (id === null) { showPreviewError(region, t('preview.invalidId')); return; }
  if (download.status !== 'completed') { showPreviewError(region, t('preview.unavailable')); return; }
  page.title = download.title;
  media.src = `/api/downloads/${id}/media`;
  media.hidden = false;
}
async function load() { const rawId = new URLSearchParams(location.search).get('id'); const id = parseDownloadId(rawId); if (id === null) { showPreviewError(errorRegion, t('preview.invalidId')); return; } const response = await request(`/api/downloads/${id}`); renderPreview(response.download, rawId, player, document, errorRegion); }

player.addEventListener('error', () => showPreviewError(errorRegion, t('preview.playbackFailed')));
load().catch((error) => showPreviewError(errorRegion, error instanceof Error ? `${t('common.failed')}: ${error.message}` : error.code === 'DOWNLOAD_NOT_FOUND' ? t('preview.notFound') : formatApiError(error)));
