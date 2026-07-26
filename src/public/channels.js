import { renderPagination } from '/public/pagination.js';
import { formatChinaTimestamp } from '/public/time.js';
import { formatApiError, formatNumber, t } from '/public/i18n.js';

const channelForm = document.querySelector('#channel-form');
const channelModalElement = document.querySelector('#channel-modal');
const channelModal = bootstrap.Modal.getOrCreateInstance(channelModalElement);
const channelModalTitle = document.querySelector('#channel-modal-title');
const channelSubmit = document.querySelector('[data-channel-submit]');
const initialSyncForm = document.querySelector('#initial-sync-form');
const initialSyncModal = bootstrap.Modal.getOrCreateInstance(document.querySelector('#initial-sync-modal'));
const pageError = document.querySelector('#channel-page-error');
let initialSyncChannelId = null;
let channelMode = { kind: 'create' };
let proxyItems = [];
let authorizationItems = [];
const requestedPage = Number(new URLSearchParams(location.search).get('page') ?? '1');
const checkResultKeys = { success: 'status.check.success', no_updates: 'status.check.no_updates', failed: 'status.check.failed' };
const initialSyncStatusKeys = { pending: 'status.sync.pending', syncing: 'status.sync.syncing', failed: 'status.sync.failed', succeeded: 'status.sync.succeeded' };
const platformLabels = { youtube: 'YouTube', bilibili: 'Bilibili' };
function nullableNumber(value) { return value === '' ? null : Number(value); }
function fixedValue(values, value, name) { if (!Object.hasOwn(values, value)) throw new TypeError(`unknown ${name}: ${String(value)}`); return values[value]; }
function showError(region, error) { region.textContent = error instanceof Error ? `${t('common.failed')}: ${error.message}` : formatApiError(error); region.hidden = false; }
function clearError(form) { const region = form.querySelector('[data-form-error]'); region.textContent = ''; region.hidden = true; }
async function request(path, method = 'GET', body) { const response = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (response.status === 204) return null; const result = await response.json(); if (!response.ok) throw result.error; return result; }
function setProxyOptions(select, proxies, selectedId) { select.replaceChildren(new Option(t('common.direct'), '')); for (const proxy of proxies) { const option = new Option(proxy.name, String(proxy.id)); option.selected = proxy.id === selectedId; select.append(option); } }
function channelPlatform(url) { if (url.startsWith('https://space.bilibili.com/')) return 'bilibili'; if (url.startsWith('https://www.youtube.com/')) return 'youtube'; return null; }
function setAuthorizationOptions(select, platform, selectedPlatform) { select.replaceChildren(new Option(t('channels.noAuthorization'), '')); for (const authorization of authorizationItems) { if (authorization.platform !== platform) continue; const label = fixedValue(platformLabels, authorization.platform, 'authorization platform'); const option = new Option(t('channels.useAuthorization', { platform: label }), authorization.platform); option.selected = authorization.platform === selectedPlatform; select.append(option); } }
function channelDetail(label, value) { const item = document.createElement('p'); item.className = 'mb-2 small'; const name = document.createElement('span'); name.className = 'text-body-secondary'; name.textContent = `${label}: `; item.append(name, value); return item; }
function openChannelCreateModal() {
  channelMode = { kind: 'create' };
  channelModalTitle.textContent = t('channels.create');
  channelSubmit.textContent = t('channels.create');
  channelForm.reset();
  channelForm.elements.url.disabled = false;
  channelForm.elements.url.required = true;
  setProxyOptions(channelForm.elements.proxyId, proxyItems, null);
  setAuthorizationOptions(channelForm.elements.authorizationPlatform, channelPlatform(channelForm.elements.url.value), null);
  clearError(channelForm);
}
function openChannelEditModal(channel) {
  channelMode = { kind: 'edit', id: channel.id };
  channelModalTitle.textContent = t('channels.edit');
  channelSubmit.textContent = t('channels.save');
  channelForm.reset();
  channelForm.elements.url.value = channel.url;
  channelForm.elements.url.disabled = true;
  channelForm.elements.url.required = false;
  channelForm.elements.customName.value = channel.customName;
  setProxyOptions(channelForm.elements.proxyId, proxyItems, channel.proxyId);
  setAuthorizationOptions(channelForm.elements.authorizationPlatform, channel.platform, channel.authorizationPlatform);
  channelForm.elements.checkIntervalMinutes.value = channel.checkIntervalMinutes ?? '';
  clearError(channelForm);
  channelModal.show();
}
async function load() {
  const [channels, proxies, authorizations] = await Promise.all([request(`/api/channels?page=${requestedPage}`), request('/api/proxies'), request('/api/authorizations/cookies')]);
  proxyItems = proxies.items;
  authorizationItems = authorizations.configurations;
  setProxyOptions(channelForm.elements.proxyId, proxyItems, null);
  document.querySelector('[data-channel-create]').addEventListener('click', () => openChannelCreateModal());
  document.querySelector('[data-channel-empty-create]').addEventListener('click', () => { openChannelCreateModal(); channelModal.show(); });
  const list = document.querySelector('#channel-list');
  const emptyState = document.querySelector('#channel-empty-state');
  list.replaceChildren();
  if (channels.items.length === 0) {
    if (requestedPage > 1 && channels.pagination.totalPages < requestedPage) { location.search = `?page=${Math.max(1, channels.pagination.totalPages)}`; return; }
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;
  for (const channel of channels.items) {
    const syncStatusKey = fixedValue(initialSyncStatusKeys, channel.initialSync.status, 'initial sync status');
    const checkResultKey = channel.lastCheck.result === null ? null : fixedValue(checkResultKeys, channel.lastCheck.result, 'check result');
    const platformLabel = fixedValue(platformLabels, channel.platform, 'channel platform');
    const column = document.createElement('div'); column.className = 'col'; const card = document.createElement('article'); card.className = 'card h-100 channel-card'; card.tabIndex = 0; card.setAttribute('role', 'link'); card.setAttribute('aria-label', t('channels.open', { name: channel.customName })); const openDetail = () => window.open(`/channels/${channel.id}`, '_blank', 'noopener'); card.addEventListener('click', (event) => { if (event.target instanceof Element && event.target.closest('a, button, input, select, textarea, label') !== null) return; openDetail(); }); card.addEventListener('keydown', (event) => { if (event.target === card && event.key === 'Enter') openDetail(); }); const body = document.createElement('div'); body.className = 'card-body d-flex flex-column';
    const link = document.createElement('a'); link.className = 'h5 mb-1 text-decoration-none'; link.href = `/channels/${channel.id}`; link.target = '_blank'; link.rel = 'noopener'; link.textContent = channel.customName; const platform = document.createElement('span'); platform.className = 'badge text-bg-light border align-self-start mb-2'; platform.textContent = platformLabel; const source = document.createElement('a'); source.className = 'small text-body-secondary text-break'; source.href = channel.url; source.target = '_blank'; source.rel = 'noreferrer'; source.textContent = channel.url; body.append(link, platform, source);
    const status = document.createElement('span'); status.className = 'badge text-bg-light border align-self-start mt-3'; status.textContent = t(channel.initialSync.status === 'succeeded' ? (channel.pausedAt === null ? 'status.channel.running' : 'status.channel.paused') : syncStatusKey); body.append(status); if (channel.initialSync.error !== null) { const syncError = document.createElement('small'); syncError.className = 'text-danger mt-2'; syncError.textContent = channel.initialSync.error; body.append(syncError); }
    const authorizationLabel = channel.authorizationPlatform === null ? t('channels.noAuthorization') : fixedValue(platformLabels, channel.authorizationPlatform, 'authorization platform');
    const intervalValue = channel.checkIntervalMinutes === null
      ? t('channels.globalInterval', { minutes: formatNumber(channel.effectiveCheckIntervalMinutes) })
      : t('channels.overrideInterval', { minutes: formatNumber(channel.effectiveCheckIntervalMinutes) });
    const details = document.createElement('div'); details.className = 'mt-3'; details.append(channelDetail(t('channels.authorizationField'), authorizationLabel), channelDetail(t('channels.checkInterval'), intervalValue), channelDetail(t('channels.unreadNotifications'), formatNumber(channel.unreadNotificationCount)), channelDetail(t('channels.lastCheck'), checkResultKey === null ? t('dashboard.noScheduledCheck') : t(checkResultKey)), channelDetail(t('channels.nextCheck'), channel.lastCheck.nextAt === null ? t('channels.notPlanned') : formatChinaTimestamp(channel.lastCheck.nextAt))); if (channel.lastCheck.result === 'failed' && channel.lastCheck.error !== null) { const reason = document.createElement('small'); reason.className = 'd-block text-danger'; reason.textContent = channel.lastCheck.error; details.append(reason); } body.append(details);
    const error = document.createElement('div'); error.className = 'alert alert-danger mt-2 mb-0'; error.dataset.formError = ''; error.hidden = true;
    const actions = document.createElement('div'); actions.className = 'd-flex flex-wrap gap-2 mt-auto pt-3';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'btn btn-outline-primary'; edit.dataset.bsToggle = 'modal'; edit.dataset.bsTarget = '#channel-modal'; edit.textContent = t('common.edit'); edit.addEventListener('click', () => openChannelEditModal(channel));
    const pause = document.createElement('button'); pause.type = 'button'; pause.className = 'btn btn-outline-warning'; pause.textContent = t(channel.pausedAt === null ? 'channels.pause' : 'channels.resume'); pause.addEventListener('click', async () => { try { await request(`/api/channels/${channel.id}/${channel.pausedAt === null ? 'pause' : 'resume'}`, 'POST', {}); location.reload(); } catch (caught) { showError(error, caught); } });
    const check = document.createElement('button'); check.type = 'button'; check.className = 'btn btn-outline-secondary'; if (channel.initialSync.status === 'succeeded') { check.textContent = t('channels.checkNow'); check.addEventListener('click', async () => { try { await request(`/api/channels/${channel.id}/check`, 'POST', {}); location.reload(); } catch (caught) { showError(error, caught); } }); } else { check.textContent = t(channel.initialSync.status === 'failed' ? 'channels.resync' : channel.initialSync.status === 'syncing' ? 'channels.syncing' : 'channels.initialSync'); check.disabled = channel.initialSync.status === 'syncing'; check.addEventListener('click', () => { initialSyncChannelId = channel.id; initialSyncForm.reset(); clearError(initialSyncForm); initialSyncModal.show(); }); }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-outline-danger'; remove.textContent = t('common.delete'); remove.addEventListener('click', async () => { if (!confirm(t('channels.deleteConfirm', { name: channel.customName }))) return; try { await request(`/api/channels/${channel.id}`, 'DELETE'); location.reload(); } catch (caught) { showError(error, caught); } });
    actions.append(edit, pause, check, remove); body.append(actions, error); card.append(body); column.append(card); list.append(column);
  }
  renderPagination(document.querySelector('#channel-pagination'), channels.pagination, (page) => { location.search = `?page=${page}`; });
}
channelForm.elements.url.addEventListener('input', () => { if (channelMode.kind === 'create') setAuthorizationOptions(channelForm.elements.authorizationPlatform, channelPlatform(channelForm.elements.url.value), null); });
channelForm.addEventListener('submit', async (event) => { event.preventDefault(); try { const authorizationPlatform = channelForm.elements.authorizationPlatform.value || null; if (channelMode.kind === 'create') { await request('/api/channels', 'POST', { url: channelForm.elements.url.value, customName: channelForm.elements.customName.value, proxyId: nullableNumber(channelForm.elements.proxyId.value), authorizationPlatform, checkIntervalMinutes: nullableNumber(channelForm.elements.checkIntervalMinutes.value) }); } else { await request(`/api/channels/${channelMode.id}`, 'PATCH', { customName: channelForm.elements.customName.value, proxyId: nullableNumber(channelForm.elements.proxyId.value), authorizationPlatform, checkIntervalMinutes: nullableNumber(channelForm.elements.checkIntervalMinutes.value) }); } location.reload(); } catch (error) { showError(channelForm.querySelector('[data-form-error]'), error); } });
initialSyncForm.addEventListener('submit', async (event) => { event.preventDefault(); const submit = initialSyncForm.querySelector('[type="submit"]'); submit.disabled = true; submit.textContent = t('channels.syncing'); try { await request(`/api/channels/${initialSyncChannelId}/initial-sync`, 'POST', { historyMonths: Number(initialSyncForm.elements.historyMonths.value) }); location.reload(); } catch (error) { showError(initialSyncForm.querySelector('[data-form-error]'), error); submit.disabled = false; submit.textContent = t('channels.startSync'); } });
load().catch((error) => showError(pageError, error));
