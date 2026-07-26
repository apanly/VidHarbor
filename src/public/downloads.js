import { renderPagination } from '/public/pagination.js';
import { formatChinaTimestamp } from '/public/time.js';
import { formatApiError, formatFileSize, formatNumber, t } from '/public/i18n.js';

const form = document.querySelector('#direct-download-form');
const list = document.querySelector('#download-list');
const pageError = document.querySelector('#page-error');
const searchInput = document.querySelector('#download-search');
const emptyState = document.querySelector('#download-empty-state');
const emptyTitle = emptyState.querySelector('[data-empty-title]');
const emptyDescription = emptyState.querySelector('[data-empty-description]');
const emptyAction = emptyState.querySelector('[data-empty-action]');
const paginationContainer = document.querySelector('#download-pagination');
const directDownloadModal = bootstrap.Modal.getOrCreateInstance(document.querySelector('#direct-download-modal'));
const cards = new Map();
const downloadState = new Map();
let selectedTab = 'completed';
let searchQuery = '';
let currentPage = 1;
let currentPagination = { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 };
let downloadEvents = null;
let searchTimer = null;
const labelKeys = { pending: 'status.download.pending', downloading: 'status.download.downloading', running: 'status.download.running', completed: 'status.download.completed', failed: 'status.download.failed', canceled: 'status.download.canceled', interrupted: 'status.download.interrupted', deleting: 'status.download.deleting' };
const styles = { pending: 'text-bg-secondary', downloading: 'text-bg-primary', running: 'text-bg-primary', completed: 'text-bg-success', failed: 'text-bg-danger', canceled: 'text-bg-warning', interrupted: 'text-bg-warning', deleting: 'text-bg-secondary' };
const platformLabels = { youtube: 'YouTube', bilibili: 'Bilibili', vimeo: 'Vimeo', twitter: 'X', facebook: 'Facebook', douyin: '抖音' };

function nullableNumber(value) { return value === '' ? null : Number(value); }
function nullableText(value) { return value === '' ? null : value; }
function advancedOptions(form) { return { mediaType: form.elements.mediaType.value, format: null, quality: nullableText(form.elements.quality.value), codec: nullableText(form.elements.codec.value), writeSubtitles: form.elements.writeSubtitles.checked, splitChapters: false, timeRangeStart: nullableText(form.elements.timeRangeStart.value), timeRangeEnd: nullableText(form.elements.timeRangeEnd.value) }; }
function fixedValue(values, value) { if (!Object.hasOwn(values, value)) throw new TypeError(`unknown download status: ${String(value)}`); return values[value]; }
function showError(region, error) { region.textContent = error instanceof Error ? `${t('common.failed')}: ${error.message}` : formatApiError(error); region.hidden = false; }
async function request(path, method = 'GET', body) { const response = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (response.status === 204) return null; const text = await response.text(); if (response.status === 202 && text === '') return null; const result = JSON.parse(text); if (!response.ok) throw result.error; return result; }
function displayValue(value) { return value ?? t('common.none'); }
function textElement(tag, className, value) { const node = document.createElement(tag); node.className = className; node.textContent = displayValue(value); return node; }
function fieldElement(tag, className, fieldName) { const node = textElement(tag, className, null); node.dataset.downloadField = fieldName; return node; }
function detail(label, fieldName, className = '') { const node = document.createElement('div'); node.className = `download-detail d-grid ${className}`.trim(); node.append(textElement('span', 'download-detail-label', label), fieldElement('span', 'download-detail-value', fieldName)); return node; }
function formatTimestamp(value) { return value === null ? t('common.none') : formatChinaTimestamp(value); }
function formatDuration(value) { if (value === null) return t('common.none'); const hours = Math.floor(value / 3600); const minutes = Math.floor((value % 3600) / 60); const seconds = value % 60; return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':'); }
function downloadElapsedSeconds(startedAt, finishedAt) { if (startedAt === null || finishedAt === null) return null; return Math.floor((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000); }
function formatBytes(value) { return value === null ? t('common.none') : formatFileSize(value); }
function emptyStateFor(tab, query, total) {
  if (total === 0) return { title: t('downloads.noTasks'), description: t('downloads.noTasksHelp'), action: 'create', actionLabel: t('downloads.create') };
  if (query !== '') return { title: t('downloads.noSearchResults', { query }), description: t('downloads.noSearchResultsHelp'), action: 'clear', actionLabel: t('downloads.clearSearch') };
  if (tab === 'completed') return { title: t('downloads.noCompleted'), description: t('downloads.noCompletedHelp'), action: 'active', actionLabel: t('downloads.viewActive') };
  if (tab === 'failed') return { title: t('downloads.noFailed'), description: t('downloads.noFailedHelp'), action: 'active', actionLabel: t('downloads.viewActive') };
  return { title: t('downloads.noActive'), description: t('downloads.noActiveHelp'), action: 'create', actionLabel: t('downloads.create') };
}

function setSelectedTab(tab) {
  selectedTab = tab;
  for (const button of document.querySelectorAll('[data-download-tab]')) {
    const active = button.dataset.downloadTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  void refreshDownloads(1);
}

function updateDownloadView(statusCounts) {
  const activeCount = statusCounts.pending + statusCounts.downloading + statusCounts.running + statusCounts.deleting;
  const failedCount = statusCounts.failed + statusCounts.canceled + statusCounts.interrupted;
  const totalCount = activeCount + statusCounts.completed + failedCount;
  document.querySelector('[data-download-count="active"]').textContent = formatNumber(activeCount);
  document.querySelector('[data-download-count="completed"]').textContent = formatNumber(statusCounts.completed);
  document.querySelector('[data-download-count="failed"]').textContent = formatNumber(failedCount);
  const empty = downloadState.size === 0;
  list.hidden = empty;
  emptyState.hidden = !empty;
  paginationContainer.hidden = empty;
  if (!empty) return;
  const content = emptyStateFor(selectedTab, searchQuery, totalCount);
  emptyTitle.textContent = content.title;
  emptyDescription.textContent = content.description;
  emptyAction.textContent = content.actionLabel;
  emptyAction.dataset.action = content.action;
}

async function mutateDownload(path, method, body, trigger) {
  if (trigger.disabled) return;
  trigger.disabled = true;
  pageError.hidden = true;
  try {
    await request(path, method, body);
    await refreshDownloads();
  } catch (error) {
    showError(pageError, error);
  } finally {
    if (trigger.isConnected) trigger.disabled = false;
  }
}

function renderActions(article, download) {
  const actions = article.querySelector('[data-download-actions]');
  actions.textContent = '';
  if (download.status === 'pending' || download.status === 'running' || download.status === 'downloading') {
    const cancel = document.createElement('button'); cancel.className = 'btn btn-sm btn-outline-warning'; cancel.type = 'button'; cancel.textContent = t('downloads.cancel'); cancel.addEventListener('click', () => void mutateDownload(`/api/downloads/${download.id}/cancel`, 'POST', {}, cancel)); actions.append(cancel);
  }
  if (download.status === 'failed' || download.status === 'canceled' || download.status === 'interrupted') {
    const retry = document.createElement('button'); retry.className = 'btn btn-sm btn-outline-primary'; retry.type = 'button'; retry.textContent = t('common.retry'); retry.addEventListener('click', () => void mutateDownload(`/api/downloads/${download.id}/retry`, 'POST', {}, retry)); actions.append(retry);
  }
  if (download.status === 'completed') {
    const preview = document.createElement('a'); preview.className = 'btn btn-sm btn-outline-primary'; preview.href = `/downloads/preview?id=${download.id}`; preview.target = '_blank'; preview.rel = 'noopener noreferrer'; preview.textContent = t('common.preview');
    const file = document.createElement('a'); file.className = 'btn btn-sm btn-outline-secondary'; file.href = `/api/downloads/${download.id}/file`; file.textContent = t('downloads.downloadFile'); actions.append(preview, file);
  }
  const original = document.createElement('a'); original.className = 'btn btn-sm btn-outline-secondary'; original.href = download.sourceUrl; original.target = '_blank'; original.rel = 'noopener noreferrer'; original.textContent = t('common.originalUrl'); actions.append(original);
  if (download.status === 'completed' || download.status === 'failed' || download.status === 'canceled' || download.status === 'interrupted') {
    const remove = document.createElement('button'); remove.className = 'btn btn-sm btn-outline-danger'; remove.type = 'button'; remove.textContent = t('common.delete'); remove.addEventListener('click', () => { const confirmed = confirm(t('downloads.deleteConfirm', { title: download.title })); if (!confirmed) return; void mutateDownload(`/api/downloads/${download.id}`, 'DELETE', undefined, remove); }); actions.append(remove);
  }
}

function createDownloadCard(download) {
  fixedValue(labelKeys, download.status);
  const article = document.createElement('article'); article.className = 'download-card border rounded-4'; article.dataset.downloadId = String(download.id);
  const header = document.createElement('header'); header.className = 'download-card-header d-flex flex-column flex-sm-row align-items-start justify-content-between gap-3';
  const identity = document.createElement('div'); identity.className = 'download-card-identity';
  const thumbnail = document.createElement('img'); thumbnail.className = 'download-card-thumbnail object-fit-cover'; thumbnail.alt = ''; thumbnail.referrerPolicy = 'no-referrer'; thumbnail.hidden = true;
  const title = fieldElement('h3', 'download-card-title h6 mb-0', 'title');
  const meta = document.createElement('div'); meta.className = 'download-card-meta d-flex flex-wrap gap-2 mt-2';
  const source = fieldElement('span', 'badge download-source', 'sourceType');
  const platform = fieldElement('span', 'badge download-platform', 'platform');
  const badge = document.createElement('span'); badge.className = 'badge'; badge.dataset.downloadStatus = '';
  meta.append(source, platform, badge); identity.append(thumbnail, title, meta);
  const actions = document.createElement('div'); actions.className = 'download-card-actions d-flex flex-wrap gap-2 flex-shrink-0'; actions.dataset.downloadActions = '';
  header.append(identity, actions);

  const metrics = document.createElement('section'); metrics.className = 'download-card-metrics d-grid gap-3 mt-3 border-top';
  if (download.status === 'completed') {
    metrics.append(detail(t('downloads.totalDuration'), 'durationSeconds'), detail(t('field.fileSize'), 'outputSizeBytes'), detail(t('downloads.elapsed'), 'downloadElapsedSeconds'), detail(t('field.finishedAt'), 'finishedAt'));
    article.append(header, metrics, detail(t('field.storagePath'), 'outputPath', 'download-card-storage'));
    return article;
  } else if (download.status === 'pending' || download.status === 'running' || download.status === 'downloading') {
    metrics.append(detail(t('field.progress'), 'progressPercent'), detail(t('field.speed'), 'speedText'), detail('ETA', 'etaSeconds'), detail(t('field.network'), 'networkMode'), detail(t('field.startedAt'), 'startedAt'));
  } else {
    metrics.append(detail(t('field.network'), 'networkMode'), detail(t('field.finishedAt'), 'finishedAt'));
    const failure = detail(t('field.failureReason'), 'failureReason', 'download-card-failure border-top');
    article.append(header, metrics, failure);
    return article;
  }
  article.append(header, metrics);
  return article;
}

function setField(article, fieldName, value) {
  const field = article.querySelector(`[data-download-field="${fieldName}"]`);
  if (field === null) return;
  const nextValue = displayValue(value);
  if (field.textContent !== nextValue) field.textContent = nextValue;
}

function updateDownloadCard(article, previous, download) {
  const statusKey = fixedValue(labelKeys, download.status);
  setField(article, 'title', download.title);
  const thumbnail = article.querySelector('.download-card-thumbnail'); thumbnail.hidden = download.thumbnailUrl === null; if (download.thumbnailUrl !== null && thumbnail.src !== download.thumbnailUrl) thumbnail.src = download.thumbnailUrl;
  setField(article, 'sourceType', t(download.sourceType === 'channel' ? 'downloads.source.channel' : 'downloads.source.direct'));
  setField(article, 'platform', platformLabels[download.platform] ?? download.platform);
  setField(article, 'progressPercent', download.progressPercent === null ? null : `${download.progressPercent}%`);
  setField(article, 'speedText', download.speedText);
  setField(article, 'etaSeconds', download.etaSeconds === null ? null : `${download.etaSeconds}s`);
  setField(article, 'durationSeconds', formatDuration(download.durationSeconds));
  setField(article, 'outputSizeBytes', formatBytes(download.outputSizeBytes));
  setField(article, 'downloadElapsedSeconds', formatDuration(downloadElapsedSeconds(download.startedAt, download.finishedAt)));
  setField(article, 'networkMode', download.networkMode === 'direct' ? t('common.direct') : download.proxyName);
  setField(article, 'outputPath', download.outputPath);
  setField(article, 'failureReason', download.failureReason);
  setField(article, 'startedAt', formatTimestamp(download.startedAt));
  setField(article, 'finishedAt', formatTimestamp(download.finishedAt));
  if (previous === undefined || previous.status !== download.status) {
    const badge = article.querySelector('[data-download-status]');
    badge.className = `badge ${fixedValue(styles, download.status)}`;
    badge.textContent = t(statusKey);
    renderActions(article, download);
  }
}

function renderDownloads(downloads) {
  currentPage = downloads.pagination.page;
  currentPagination = downloads.pagination;
  const nextIds = new Set(downloads.items.map((download) => download.id));
  for (const [id, card] of cards) {
    if (nextIds.has(id)) continue;
    card.remove(); cards.delete(id); downloadState.delete(id);
  }
  for (const download of downloads.items) {
    let article = cards.get(download.id);
    if (article === undefined) { article = createDownloadCard(download); cards.set(download.id, article); }
    const previous = downloadState.get(download.id);
    if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(download)) updateDownloadCard(article, previous, download);
    downloadState.set(download.id, download);
  }
  for (let index = 0; index < downloads.items.length; index += 1) {
    const card = cards.get(downloads.items[index].id);
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] ?? null);
  }
  updateDownloadView(downloads.statusCounts);
  renderPagination(paginationContainer, downloads.pagination, (page) => void refreshDownloads(page));
}

function downloadUrl(path, page = currentPage) {
  const parameters = new URLSearchParams({ page: String(page), tab: selectedTab });
  if (searchQuery !== '') parameters.set('q', searchQuery);
  return `${path}?${parameters}`;
}

function connectDownloadEvents() {
  downloadEvents?.close();
  downloadEvents = new EventSource(downloadUrl('/api/downloads/events'));
  downloadEvents.addEventListener('downloads', (event) => renderDownloads(JSON.parse(event.data)));
  downloadEvents.onerror = () => downloadEvents.close();
}

async function refreshDownloads(page = currentPage) {
  const downloads = await request(downloadUrl('/api/downloads', page));
  if (downloads.items.length === 0 && page > 1 && downloads.pagination.totalPages < page) return refreshDownloads(Math.max(1, downloads.pagination.totalPages));
  renderDownloads(downloads);
  connectDownloadEvents();
}

async function load() {
  const proxies = await request('/api/proxies');
  const proxySelect = form.elements.proxyId;
  for (const proxy of proxies.items) { const option = document.createElement('option'); option.value = String(proxy.id); option.textContent = proxy.name; proxySelect.append(option); }
  await refreshDownloads(1);
}

for (const button of document.querySelectorAll('[data-download-tab]')) button.addEventListener('click', () => setSelectedTab(button.dataset.downloadTab));
searchInput.addEventListener('input', () => { searchQuery = searchInput.value.trim(); clearTimeout(searchTimer); searchTimer = setTimeout(() => void refreshDownloads(1), 250); });
emptyAction.addEventListener('click', () => {
  if (emptyAction.dataset.action === 'clear') { searchInput.value = ''; searchQuery = ''; void refreshDownloads(1); return; }
  if (emptyAction.dataset.action === 'active') { setSelectedTab('active'); return; }
  directDownloadModal.show();
});
form.addEventListener('submit', async (event) => { event.preventDefault(); const errorRegion = form.querySelector('[data-form-error]'); errorRegion.hidden = true; try { await request('/api/downloads/direct', 'POST', { url: form.elements.url.value, proxyId: nullableNumber(form.elements.proxyId.value), advancedOptions: advancedOptions(form) }); directDownloadModal.hide(); form.reset(); await refreshDownloads(); } catch (error) { showError(errorRegion, error); } });
load().catch((error) => showError(pageError, error));
