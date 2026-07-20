import { renderPagination } from '/public/pagination.js';
import { formatChinaTimestamp } from '/public/time.js';

const channelForm = document.querySelector('#channel-form');
const channelModalElement = document.querySelector('#channel-modal');
const channelModal = bootstrap.Modal.getOrCreateInstance(channelModalElement);
const channelModalTitle = document.querySelector('#channel-modal-title');
const channelSubmit = document.querySelector('[data-channel-submit]');
const initialSyncForm = document.querySelector('#initial-sync-form');
const initialSyncModal = bootstrap.Modal.getOrCreateInstance(document.querySelector('#initial-sync-modal'));
let initialSyncChannelId = null;
let channelMode = { kind: 'create' };
let proxyItems = [];
const requestedPage = Number(new URLSearchParams(location.search).get('page') ?? '1');
const checkResultLabels = { success: '有更新', no_updates: '无更新', failed: '失败' };
const platformLabels = { youtube: 'YouTube', bilibili: 'Bilibili' };
function nullableNumber(value) { return value === '' ? null : Number(value); }
function showError(form, error) { const region = form.querySelector('[data-form-error]'); region.textContent = `${error.code}: ${error.message}`; region.hidden = false; }
function clearError(form) { const region = form.querySelector('[data-form-error]'); region.textContent = ''; region.hidden = true; }
async function request(path, method = 'GET', body) { const response = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (response.status === 204) return null; const result = await response.json(); if (!response.ok) throw result.error; return result; }
function setProxyOptions(select, proxies, selectedId) { select.replaceChildren(new Option('直连', '')); for (const proxy of proxies) { const option = new Option(proxy.name, String(proxy.id)); option.selected = proxy.id === selectedId; select.append(option); } }
function channelDetail(label, value) { const item = document.createElement('p'); item.className = 'mb-2 small'; const name = document.createElement('span'); name.className = 'text-body-secondary'; name.textContent = `${label}：`; item.append(name, value); return item; }
function renderEmptyState(list) { const empty = document.createElement('p'); empty.className = 'col-12 text-center text-body-secondary py-5'; empty.textContent = '尚未添加频道。'; list.append(empty); }
function openChannelCreateModal() {
  channelMode = { kind: 'create' };
  channelModalTitle.textContent = '新增频道';
  channelSubmit.textContent = '新增频道';
  channelForm.reset();
  channelForm.elements.url.disabled = false;
  channelForm.elements.url.required = true;
  setProxyOptions(channelForm.elements.proxyId, proxyItems, null);
  clearError(channelForm);
}
function openChannelEditModal(channel) {
  channelMode = { kind: 'edit', id: channel.id };
  channelModalTitle.textContent = '编辑频道';
  channelSubmit.textContent = '保存频道配置';
  channelForm.reset();
  channelForm.elements.url.value = channel.url;
  channelForm.elements.url.disabled = true;
  channelForm.elements.url.required = false;
  channelForm.elements.customName.value = channel.customName;
  setProxyOptions(channelForm.elements.proxyId, proxyItems, channel.proxyId);
  channelForm.elements.checkIntervalMinutes.value = channel.checkIntervalMinutes ?? '';
  clearError(channelForm);
  channelModal.show();
}
async function load() {
  const [channels, proxies] = await Promise.all([request(`/api/channels?page=${requestedPage}`), request('/api/proxies')]);
  proxyItems = proxies.items;
  setProxyOptions(channelForm.elements.proxyId, proxyItems, null);
  document.querySelector('[data-channel-create]').addEventListener('click', () => openChannelCreateModal());
  const list = document.querySelector('#channel-list');
  list.replaceChildren();
  if (channels.items.length === 0) {
    if (requestedPage > 1 && channels.pagination.totalPages < requestedPage) { location.search = `?page=${Math.max(1, channels.pagination.totalPages)}`; return; }
    renderEmptyState(list);
    return;
  }
  for (const channel of channels.items) {
    const column = document.createElement('div'); column.className = 'col'; const card = document.createElement('article'); card.className = 'card h-100 channel-card'; card.tabIndex = 0; card.setAttribute('role', 'link'); card.setAttribute('aria-label', `打开频道 ${channel.customName}`); const openDetail = () => window.open(`/channels/${channel.id}`, '_blank', 'noopener'); card.addEventListener('click', (event) => { if (event.target instanceof Element && event.target.closest('a, button, input, select, textarea, label') !== null) return; openDetail(); }); card.addEventListener('keydown', (event) => { if (event.target === card && event.key === 'Enter') openDetail(); }); const body = document.createElement('div'); body.className = 'card-body d-flex flex-column';
    const link = document.createElement('a'); link.className = 'h5 mb-1 text-decoration-none'; link.href = `/channels/${channel.id}`; link.target = '_blank'; link.rel = 'noopener'; link.textContent = channel.customName; const platform = document.createElement('span'); platform.className = 'badge text-bg-light border align-self-start mb-2'; platform.textContent = platformLabels[channel.platform]; const source = document.createElement('a'); source.className = 'small text-body-secondary text-break'; source.href = channel.url; source.target = '_blank'; source.rel = 'noreferrer'; source.textContent = channel.url; body.append(link, platform, source);
    const statusLabels = { pending: '待首次同步', syncing: '首次同步中', failed: '首次同步失败', succeeded: channel.pausedAt === null ? '运行中' : '已暂停' }; const status = document.createElement('span'); status.className = 'badge text-bg-light border align-self-start mt-3'; status.textContent = statusLabels[channel.initialSync.status]; body.append(status); if (channel.initialSync.error !== null) { const syncError = document.createElement('small'); syncError.className = 'text-danger mt-2'; syncError.textContent = channel.initialSync.error; body.append(syncError); }
    const details = document.createElement('div'); details.className = 'mt-3'; details.append(channelDetail('检查间隔', `${channel.effectiveCheckIntervalMinutes} 分钟（${channel.checkIntervalMinutes === null ? '全局' : '频道覆盖'}）`), channelDetail('未读提醒', String(channel.unreadNotificationCount)), channelDetail('最近检查', channel.lastCheck.result === null ? '尚无定时检查' : checkResultLabels[channel.lastCheck.result]), channelDetail('下次检查', channel.lastCheck.nextAt === null ? '未计划' : formatChinaTimestamp(channel.lastCheck.nextAt))); if (channel.lastCheck.result === 'failed' && channel.lastCheck.error !== null) { const reason = document.createElement('small'); reason.className = 'd-block text-danger'; reason.textContent = channel.lastCheck.error; details.append(reason); } body.append(details);
    const actions = document.createElement('div'); actions.className = 'd-flex flex-wrap gap-2 mt-auto pt-3';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'btn btn-outline-primary'; edit.dataset.bsToggle = 'modal'; edit.dataset.bsTarget = '#channel-modal'; edit.textContent = '编辑'; edit.addEventListener('click', () => openChannelEditModal(channel));
    const pause = document.createElement('button'); pause.type = 'button'; pause.className = 'btn btn-outline-warning'; pause.textContent = channel.pausedAt === null ? '暂停' : '恢复'; pause.addEventListener('click', async () => { try { await request(`/api/channels/${channel.id}/${channel.pausedAt === null ? 'pause' : 'resume'}`, 'POST', {}); location.reload(); } catch (error) { showError(card, error); } });
    const check = document.createElement('button'); check.type = 'button'; check.className = 'btn btn-outline-secondary'; if (channel.initialSync.status === 'succeeded') { check.textContent = '立即检查'; check.addEventListener('click', async () => { try { await request(`/api/channels/${channel.id}/check`, 'POST', {}); location.reload(); } catch (error) { showError(card, error); } }); } else { check.textContent = channel.initialSync.status === 'failed' ? '重新同步' : channel.initialSync.status === 'syncing' ? '同步中' : '首次同步'; check.disabled = channel.initialSync.status === 'syncing'; check.addEventListener('click', () => { initialSyncChannelId = channel.id; initialSyncForm.reset(); clearError(initialSyncForm); initialSyncModal.show(); }); }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-outline-danger'; remove.textContent = '删除'; remove.addEventListener('click', async () => { if (!confirm(`确认删除频道「${channel.customName}」？`)) return; try { await request(`/api/channels/${channel.id}`, 'DELETE'); location.reload(); } catch (error) { showError(card, error); } });
    const error = document.createElement('div'); error.className = 'alert alert-danger mt-2 mb-0'; error.dataset.formError = ''; error.hidden = true;
    actions.append(edit, pause, check, remove); body.append(actions, error); card.append(body); column.append(card); list.append(column);
  }
  renderPagination(document.querySelector('#channel-pagination'), channels.pagination, (page) => { location.search = `?page=${page}`; });
}
channelForm.addEventListener('submit', async (event) => { event.preventDefault(); try { if (channelMode.kind === 'create') { await request('/api/channels', 'POST', { url: channelForm.elements.url.value, customName: channelForm.elements.customName.value, proxyId: nullableNumber(channelForm.elements.proxyId.value), checkIntervalMinutes: nullableNumber(channelForm.elements.checkIntervalMinutes.value) }); } else { await request(`/api/channels/${channelMode.id}`, 'PATCH', { customName: channelForm.elements.customName.value, proxyId: nullableNumber(channelForm.elements.proxyId.value), checkIntervalMinutes: nullableNumber(channelForm.elements.checkIntervalMinutes.value) }); } location.reload(); } catch (error) { showError(channelForm, error); } });
initialSyncForm.addEventListener('submit', async (event) => { event.preventDefault(); const submit = initialSyncForm.querySelector('[type="submit"]'); submit.disabled = true; submit.textContent = '同步中'; try { await request(`/api/channels/${initialSyncChannelId}/initial-sync`, 'POST', { historyMonths: Number(initialSyncForm.elements.historyMonths.value) }); location.reload(); } catch (error) { showError(initialSyncForm, error); submit.disabled = false; submit.textContent = '开始同步'; } });
load().catch((error) => showError(channelForm, error.code ? error : { code: 'NETWORK_ERROR', message: '无法连接服务端' }));
