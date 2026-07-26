import { formatApiError, t } from '/public/i18n.js';

const proxyForm = document.querySelector('#proxy-form');
const proxyModalElement = document.querySelector('#proxy-modal');
const proxyModal = bootstrap.Modal.getOrCreateInstance(proxyModalElement);
const proxyModalTitle = document.querySelector('#proxy-modal-title');
const proxySubmit = document.querySelector('[data-proxy-submit]');
let proxyMode = { kind: 'create' };
function errorMessage(error) { return error instanceof Error ? `${t('common.failed')}: ${error.message}` : formatApiError(error); }
function showError(form, error) { const region = form.querySelector('[data-form-error]'); region.textContent = errorMessage(error); region.hidden = false; }
function clearError(form) { const region = form.querySelector('[data-form-error]'); region.textContent = ''; region.hidden = true; }
function optionalText(value) { return value === '' ? null : value; }
function proxyPayload(form) { return { name: form.elements.name.value, protocol: form.elements.protocol.value, host: form.elements.host.value, port: Number(form.elements.port.value), username: optionalText(form.elements.username.value), password: optionalText(form.elements.password.value) }; }
async function request(path, method, body) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw result.error;
  return result;
}
function openProxyCreateModal() {
  proxyMode = { kind: 'create' };
  proxyModalTitle.textContent = t('settings.proxyCreate');
  proxySubmit.textContent = t('settings.proxyCreate');
  proxyForm.reset();
  clearError(proxyForm);
}
function openProxyEditModal(proxy) {
  proxyMode = { kind: 'edit', id: proxy.id };
  proxyModalTitle.textContent = t('settings.proxyEdit');
  proxySubmit.textContent = t('common.save');
  proxyForm.reset();
  proxyForm.elements.name.value = proxy.name;
  proxyForm.elements.protocol.value = proxy.protocol;
  proxyForm.elements.host.value = proxy.host;
  proxyForm.elements.port.value = String(proxy.port);
  proxyForm.elements.username.value = proxy.username ?? '';
  clearError(proxyForm);
  proxyModal.show();
}
async function load() {
  const [settings, proxies] = await Promise.all([request('/api/settings', 'GET'), request('/api/proxies', 'GET')]);
  document.querySelector('#downloadRoot').value = settings.downloadRoot ?? '';
  document.querySelector('#globalCheckIntervalMinutes').value = settings.globalCheckIntervalMinutes ?? '';
  document.querySelector('#downloadConcurrency').value = settings.downloadConcurrency;
  document.querySelector('[data-proxy-create]').addEventListener('click', () => openProxyCreateModal());
  const list = document.querySelector('#proxy-list'); list.replaceChildren();
  const listError = document.querySelector('#proxy-list-error');
  if (proxies.items.length === 0) { const row = document.createElement('tr'); const empty = document.createElement('td'); empty.colSpan = 7; empty.textContent = t('settings.proxyEmpty'); row.append(empty); list.append(row); return; }
  for (const proxy of proxies.items) {
    const row = document.createElement('tr');
    const name = document.createElement('td'); name.textContent = proxy.name; row.append(name);
    const protocol = document.createElement('td'); protocol.textContent = proxy.protocol; row.append(protocol);
    const host = document.createElement('td'); host.textContent = proxy.host; row.append(host);
    const port = document.createElement('td'); port.textContent = String(proxy.port); row.append(port);
    const username = document.createElement('td'); username.textContent = proxy.username ?? '—'; row.append(username);
    const password = document.createElement('td'); password.textContent = proxy.maskedPassword ?? '—'; row.append(password);
    const actionsCell = document.createElement('td');
    const actions = document.createElement('div'); actions.className = 'd-flex flex-wrap gap-2';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'btn btn-sm btn-outline-primary'; edit.dataset.bsToggle = 'modal'; edit.dataset.bsTarget = '#proxy-modal'; edit.textContent = t('common.edit'); edit.addEventListener('click', () => openProxyEditModal(proxy));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-sm btn-outline-danger'; remove.textContent = t('settings.proxyDelete'); remove.addEventListener('click', async () => { const confirmed = confirm(t('settings.proxyDeleteConfirm', { name: proxy.name })); if (!confirmed) return; try { await request(`/api/proxies/${proxy.id}`, 'DELETE'); location.reload(); } catch (error) { listError.textContent = errorMessage(error); listError.hidden = false; } });
    actions.append(edit, remove); actionsCell.append(actions); row.append(actionsCell); list.append(row);
  }
}
document.querySelector('#settings-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; try { await request('/api/settings', 'PUT', { globalCheckIntervalMinutes: Number(form.elements.globalCheckIntervalMinutes.value), downloadConcurrency: Number(form.elements.downloadConcurrency.value) }); location.reload(); } catch (error) { showError(form, error); } });
proxyForm.addEventListener('submit', async (event) => { event.preventDefault(); try { if (proxyMode.kind === 'create') { await request('/api/proxies', 'POST', proxyPayload(proxyForm)); } else { await request(`/api/proxies/${proxyMode.id}`, 'PATCH', proxyPayload(proxyForm)); } location.reload(); } catch (error) { showError(proxyForm, error); } });
load().catch((error) => showError(document.querySelector('#settings-form'), error));
