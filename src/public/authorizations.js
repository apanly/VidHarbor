import { formatChinaTimestamp } from '/public/time.js';

const platformLabels = Object.freeze({
  youtube: 'YouTube',
  bilibili: 'Bilibili',
  x: 'X',
  facebook: 'Facebook',
  douyin: '抖音',
});

const form = document.querySelector('#authorization-form');
const modalElement = document.querySelector('#authorization-modal');
const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
const modalTitle = document.querySelector('#authorization-modal-title');
const platformControl = form.elements.platform;
const fileControl = form.elements.cookieFile;
const submit = document.querySelector('[data-authorization-submit]');
const createButton = document.querySelector('[data-authorization-create]');
const list = document.querySelector('#authorization-list');
const listError = document.querySelector('#authorization-page-error');

let configurations = new Map();
let mode = { kind: 'create' };

function errorMessage(error) {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : `${error.code}: ${error.message}`;
}

async function request(path, method = 'GET', body, contentType = 'application/octet-stream') {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': contentType },
          body,
        }),
  });
  const result = await response.json();
  if (!response.ok) throw result.error;
  return result;
}

function showFormError(error) {
  const region = form.querySelector('[data-form-error]');
  region.textContent = errorMessage(error);
  region.hidden = false;
}

function clearFormError() {
  const region = form.querySelector('[data-form-error]');
  region.textContent = '';
  region.hidden = true;
}

function showListError(error) {
  listError.textContent = errorMessage(error);
  listError.hidden = false;
}

function clearListError() {
  listError.textContent = '';
  listError.hidden = true;
}

function fillPlatformOptions(platforms) {
  platformControl.replaceChildren();
  for (const platform of platforms) {
    const option = document.createElement('option');
    option.value = platform;
    option.textContent = platformLabels[platform];
    platformControl.append(option);
  }
}

function openCreateModal() {
  mode = { kind: 'create' };
  modalTitle.textContent = '新增授权';
  submit.textContent = '新增授权';
  form.reset();
  platformControl.disabled = false;
  fillPlatformOptions(
    Object.keys(platformLabels).filter((platform) => !configurations.has(platform)),
  );
  clearFormError();
}

function openEditModal(configuration) {
  mode = { kind: 'edit', platform: configuration.platform };
  modalTitle.textContent = `编辑 ${platformLabels[configuration.platform]} 授权`;
  submit.textContent = '保存';
  form.reset();
  fillPlatformOptions([configuration.platform]);
  platformControl.value = configuration.platform;
  platformControl.disabled = true;
  clearFormError();
  modal.show();
}

async function deleteConfiguration(configuration, button) {
  const label = platformLabels[configuration.platform];
  const confirmed = confirm(`确认删除 ${label} 的 Cookie 配置？删除后无法恢复。`);
  if (!confirmed) return;

  button.disabled = true;
  clearListError();
  try {
    await request(
      `/api/authorizations/cookies/${configuration.platform}`,
      'DELETE',
    );
    configurations.delete(configuration.platform);
    renderState();
  } catch (error) {
    showListError(error);
    button.disabled = false;
  }
}

function renderList() {
  list.replaceChildren();
  if (configurations.size === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'authorization-empty-state text-center';
    cell.textContent = '尚未添加授权。';
    row.append(cell);
    list.append(row);
    return;
  }

  for (const configuration of configurations.values()) {
    const row = document.createElement('tr');
    const platform = document.createElement('td');
    platform.className = 'authorization-platform-name';
    platform.textContent = platformLabels[configuration.platform];

    const status = document.createElement('td');
    const statusBadge = document.createElement('span');
    statusBadge.className = 'authorization-status rounded-pill';
    statusBadge.textContent = '已配置';
    status.append(statusBadge);

    const updated = document.createElement('td');
    const time = document.createElement('time');
    time.dateTime = configuration.updatedAt;
    time.textContent = formatChinaTimestamp(configuration.updatedAt);
    updated.append(time);

    const actionsCell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'authorization-actions d-flex align-items-center flex-nowrap flex-sm-wrap';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-sm btn-outline-primary';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => openEditModal(configuration));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-sm btn-outline-danger';
    remove.textContent = '删除';
    remove.addEventListener('click', () => deleteConfiguration(configuration, remove));
    actions.append(edit);
    actions.append(remove);
    actionsCell.append(actions);
    row.append(platform, status, updated, actionsCell);
    list.append(row);
  }
}

function renderState() {
  createButton.disabled = configurations.size === Object.keys(platformLabels).length;
  renderList();
}

async function load() {
  clearListError();
  const result = await request('/api/authorizations/cookies');
  configurations = new Map(
    result.configurations.map((configuration) => [configuration.platform, configuration]),
  );
  renderState();
}

createButton.addEventListener('click', openCreateModal);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = fileControl.files[0];
  if (file === undefined) return;

  submit.disabled = true;
  clearFormError();
  try {
    const platform = mode.kind === 'create' ? platformControl.value : mode.platform;
    const result = await request(
      `/api/authorizations/cookies/${platform}`,
      mode.kind === 'create' ? 'POST' : 'PUT',
      file,
    );
    configurations.set(platform, result.configuration);
    renderState();
    modal.hide();
  } catch (error) {
    showFormError(error);
  } finally {
    fileControl.value = '';
    submit.disabled = false;
  }
});

load().catch(showListError);
