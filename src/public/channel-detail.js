import { renderPagination } from '/public/pagination.js';
import { formatChinaTimestamp } from '/public/time.js';
import { formatApiError, formatFileSize, formatNumber, t } from '/public/i18n.js';

const channelId = Number(document.querySelector('.channel-detail-hero').dataset.channelId);
const pageError = document.querySelector('#page-error');
const form = document.querySelector('#download-form');
const submit = form.querySelector('[type="submit"]');
const selectedCount = document.querySelector('#selected-video-count');
let videoQuery = '';
let videoTotal = 0;
let checkTotal = 0;
let filterTimer = null;
const downloadStatusKeys = { pending: 'status.download.pending', running: 'status.download.running', downloading: 'status.download.downloading', completed: 'status.download.completed', failed: 'status.download.failed', canceled: 'status.download.canceled', interrupted: 'status.download.interrupted', deleting: 'status.download.deleting' };
const checkTypeKeys = { initial: 'check.type.initial', scheduled: 'check.type.scheduled' };
const checkResultKeys = { success: 'status.check.success', no_updates: 'status.check.no_updates', failed: 'status.check.failed' };

function showError(region, error) {
  region.textContent = error instanceof Error
    ? `${t('common.failed')}: ${error.message}`
    : formatApiError(error);
  region.hidden = false;
}
function fixedValue(values, value, name) { if (!Object.hasOwn(values, value)) throw new TypeError(`unknown ${name}: ${String(value)}`); return values[value]; }
function channelProxyId() {
  const value = form.elements.proxyId.value;
  return value === 'channel' ? 'channel' : value === '' ? null : Number(value);
}
async function request(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw result.error;
  return result;
}
function addProxyOptions(select, proxies) {
  for (const proxy of proxies) select.append(new Option(proxy.name, String(proxy.id)));
}
function formatDuration(seconds) {
  if (seconds === null) return t('channelDetail.durationUnknown');
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
function formatTimestamp(value) {
  if (value === null) return t('common.inProgress');
  return formatChinaTimestamp(value);
}
function formatCompletedAt(value) {
  return value === null ? t('common.none') : formatTimestamp(value);
}
function formatBytes(value) {
  return value === null ? t('common.none') : formatFileSize(value);
}
function updateSelection() {
  const count = form.querySelectorAll('input[name="videoIds"]:checked').length;
  selectedCount.textContent = t('channelDetail.selected', { count: formatNumber(count) });
  submit.disabled = count === 0;
}
function setChannelTab(tab) {
  for (const button of document.querySelectorAll('[data-channel-tab]')) {
    const active = button.dataset.channelTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  for (const panel of document.querySelectorAll('[data-channel-panel]')) {
    panel.hidden = panel.dataset.channelPanel !== tab;
  }
}
function renderVideo(video) {
  const row = document.createElement('tr');
  const selectionCell = document.createElement('td');
  selectionCell.className = 'channel-select-column text-center';
  selectionCell.dataset.label = t('channelDetail.select');
  const checkbox = document.createElement('input');
  checkbox.className = 'form-check-input';
  checkbox.type = 'checkbox';
  checkbox.name = 'videoIds';
  checkbox.value = String(video.id);
  checkbox.ariaLabel = t('channelDetail.selectVideo', { title: video.title });
  checkbox.disabled = ['pending', 'running', 'downloading', 'completed', 'deleting'].includes(video.downloadStatus);
  checkbox.addEventListener('change', updateSelection);
  selectionCell.append(checkbox);

  const videoCell = document.createElement('td');
  videoCell.dataset.label = t('field.video');
  const identity = document.createElement('div');
  identity.className = 'channel-video-identity d-flex align-items-center gap-3';
  const visual = document.createElement('div');
  visual.className = 'channel-video-thumbnail d-grid overflow-hidden rounded-3';
  if (video.thumbnailUrl !== null) {
    const image = document.createElement('img');
    image.src = video.thumbnailUrl;
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    visual.append(image);
  } else {
    const placeholder = document.createElement('span');
    placeholder.textContent = 'VH';
    visual.append(placeholder);
  }
  const title = document.createElement('strong');
  title.className = 'channel-video-title';
  title.textContent = video.title;
  identity.append(visual, title);
  videoCell.append(identity);

  const publishedCell = document.createElement('td');
  publishedCell.dataset.label = t('field.publishedDate');
  publishedCell.textContent = video.publishedDate;
  const durationCell = document.createElement('td');
  durationCell.dataset.label = t('field.duration');
  durationCell.textContent = formatDuration(video.durationSeconds);
  const stateCell = document.createElement('td');
  stateCell.dataset.label = t('field.status');
  const downloadSummary = document.createElement('div');
  downloadSummary.className = 'channel-download-summary d-grid';
  const state = document.createElement('span');
  state.className = 'badge text-bg-light border';
  state.textContent = video.downloadStatus === null ? t('channelDetail.notDownloaded') : t(fixedValue(downloadStatusKeys, video.downloadStatus, 'download status'));
  downloadSummary.append(state);
  if (video.downloadStatus === 'completed') {
    const metadata = document.createElement('small');
    metadata.textContent = `${formatBytes(video.downloadOutputSizeBytes)} · ${formatCompletedAt(video.downloadFinishedAt)}`;
    const actions = document.createElement('div');
    actions.className = 'channel-download-links d-flex gap-3';
    const preview = document.createElement('a');
    preview.href = `/downloads/preview?id=${video.downloadId}`;
    preview.target = '_blank';
    preview.rel = 'noopener noreferrer';
    preview.textContent = t('common.preview');
    const file = document.createElement('a');
    file.href = `/api/downloads/${video.downloadId}/file`;
    file.textContent = t('downloads.downloadFile');
    actions.append(preview, file);
    downloadSummary.append(metadata, actions);
  } else if (video.downloadStatus === 'failed' || video.downloadStatus === 'canceled' || video.downloadStatus === 'interrupted') {
    const reason = document.createElement('small');
    reason.className = 'text-danger';
    reason.textContent = video.downloadFailureReason;
    downloadSummary.append(reason);
  }
  stateCell.append(downloadSummary);
  const sourceCell = document.createElement('td');
  sourceCell.dataset.label = t('common.originalUrl');
  const original = document.createElement('a');
  original.href = video.url;
  original.target = '_blank';
  original.rel = 'noreferrer';
  original.textContent = t('channelDetail.openVideo');
  sourceCell.append(original);
  row.append(selectionCell, videoCell, publishedCell, durationCell, stateCell, sourceCell);
  return row;
}
function renderCheck(check) {
  const row = document.createElement('tr');
  const typeCell = document.createElement('td');
  typeCell.dataset.label = t('field.type');
  typeCell.textContent = t(fixedValue(checkTypeKeys, check.kind, 'check type'));
  const startedCell = document.createElement('td');
  startedCell.dataset.label = t('field.startedAt');
  startedCell.textContent = formatTimestamp(check.startedAt);
  const finishedCell = document.createElement('td');
  finishedCell.dataset.label = t('field.finishedAt');
  finishedCell.textContent = formatTimestamp(check.finishedAt);
  const resultCell = document.createElement('td');
  resultCell.dataset.label = t('field.result');
  const result = document.createElement('span');
  result.className = `badge ${check.result === 'failed' ? 'text-bg-danger' : check.result === null ? 'text-bg-primary' : 'text-bg-success'}`;
  result.textContent = check.result === null ? t('status.check.running') : t(fixedValue(checkResultKeys, check.result, 'check result'));
  resultCell.append(result);
  const countCell = document.createElement('td');
  countCell.dataset.label = t('field.video');
  countCell.textContent = formatNumber(check.newVideoCount);
  const failureCell = document.createElement('td');
  failureCell.dataset.label = t('field.failureReason');
  failureCell.className = check.failureReason === null ? 'text-body-secondary' : 'text-danger';
  failureCell.textContent = check.failureReason ?? t('common.none');
  row.append(typeCell, startedCell, finishedCell, resultCell, countCell, failureCell);
  return row;
}
function updateChannelSummary() { document.querySelector('#channel-summary').textContent = t('channelDetail.summary', { videos: formatNumber(videoTotal), checks: formatNumber(checkTotal) }); }
async function loadVideos(page) {
  const parameters = new URLSearchParams({ page: String(page) });
  if (videoQuery !== '') parameters.set('q', videoQuery);
  const videos = await request(`/api/channels/${channelId}/videos?${parameters}`);
  if (videos.items.length === 0 && page > 1 && videos.pagination.totalPages < page) return loadVideos(Math.max(1, videos.pagination.totalPages));
  videoTotal = videos.pagination.totalItems;
  updateChannelSummary();
  const videoList = document.querySelector('#video-list');
  const emptyState = document.querySelector('#video-empty-state');
  videoList.replaceChildren();
  emptyState.hidden = videos.items.length !== 0;
  emptyState.textContent = videoQuery === '' ? t('channelDetail.noVideos') : t('channelDetail.noSearchResults', { query: videoQuery });
  for (const video of videos.items) videoList.append(renderVideo(video));
  updateSelection();
  renderPagination(document.querySelector('#video-pagination'), videos.pagination, (nextPage) => void loadVideos(nextPage));
}
async function loadChecks(page) {
  const checks = await request(`/api/channels/${channelId}/checks?page=${page}`);
  if (checks.items.length === 0 && page > 1 && checks.pagination.totalPages < page) return loadChecks(Math.max(1, checks.pagination.totalPages));
  checkTotal = checks.pagination.totalItems;
  updateChannelSummary();
  const checkList = document.querySelector('#check-list');
  const emptyState = document.querySelector('#check-empty-state');
  checkList.replaceChildren();
  emptyState.hidden = checks.items.length !== 0;
  for (const check of checks.items) checkList.append(renderCheck(check));
  renderPagination(document.querySelector('#check-pagination'), checks.pagination, (nextPage) => void loadChecks(nextPage));
}
async function load() {
  const [channelResponse, proxies] = await Promise.all([
    request(`/api/channels/${channelId}`),
    request('/api/proxies'),
  ]);
  addProxyOptions(form.elements.proxyId, proxies.items);
  const channel = channelResponse.channel;
  document.querySelector('#channel-name').textContent = channel.customName;
  document.title = `${channel.customName} · VidHarbor`;
  await Promise.all([loadVideos(1), loadChecks(1)]);
}
form.elements.filter.addEventListener('input', () => {
  videoQuery = form.elements.filter.value.trim();
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => void loadVideos(1), 250);
});
for (const button of document.querySelectorAll('[data-channel-tab]')) {
  button.addEventListener('click', () => setChannelTab(button.dataset.channelTab));
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const videoIds = [...form.querySelectorAll('input[name="videoIds"]:checked')].map((input) => Number(input.value));
  if (videoIds.length === 0) {
    const errorRegion = form.querySelector('[data-form-error]');
    errorRegion.textContent = t('channelDetail.selectAtLeastOne');
    errorRegion.hidden = false;
    return;
  }
  try {
    await request('/api/downloads/channel', 'POST', { videoIds, proxyId: channelProxyId() });
    location.reload();
  } catch (error) {
    showError(form.querySelector('[data-form-error]'), error);
  }
});
load().catch((error) => showError(pageError, error));
