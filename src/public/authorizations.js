import { formatChinaTimestamp } from '/public/time.js';

const platformLabels = Object.freeze({
  youtube: 'YouTube',
  bilibili: 'Bilibili',
  x: 'X',
  facebook: 'Facebook',
  douyin: '抖音',
});

function errorMessage(error) {
  return error?.code === undefined
    ? 'NETWORK_ERROR: 无法连接服务端'
    : `${error.code}: ${error.message}`;
}

async function request(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/octet-stream' },
          body,
        }),
  });
  const result = await response.json();
  if (!response.ok) throw result.error;
  return result;
}

function showCardError(card, error) {
  const region = card.querySelector('[data-authorization-error]');
  region.textContent = errorMessage(error);
  region.hidden = false;
}

function clearCardError(card) {
  const region = card.querySelector('[data-authorization-error]');
  region.textContent = '';
  region.hidden = true;
}

function createDeleteButton(configuration, card) {
  const button = document.createElement('button');
  button.className = 'btn btn-outline-danger';
  button.type = 'button';
  button.textContent = '删除';
  button.addEventListener('click', async () => {
    const label = platformLabels[configuration.platform];
    const confirmed = confirm(`确认删除 ${label} 的 Cookie 配置？`);
    if (!confirmed) return;

    button.disabled = true;
    clearCardError(card);
    try {
      const result = await request(
        `/api/authorizations/cookies/${configuration.platform}`,
        'DELETE',
      );
      renderConfiguration(result.configuration);
    } catch (error) {
      showCardError(card, error);
      button.disabled = false;
    }
  });
  return button;
}

function renderConfiguration(configuration) {
  const card = document.querySelector(
    `[data-authorization-platform="${configuration.platform}"]`,
  );
  const status = card.querySelector('[data-authorization-status]');
  const updated = card.querySelector('[data-authorization-updated]');
  const time = card.querySelector('[data-authorization-time]');
  const submit = card.querySelector('[data-authorization-submit]');
  const deleteContainer = card.querySelector('[data-authorization-delete]');

  card.dataset.configured = String(configuration.configured);
  status.textContent = configuration.configured ? '已配置' : '未配置';
  status.hidden = false;
  submit.textContent = configuration.configured ? '替换' : '上传';
  deleteContainer.replaceChildren();

  if (configuration.configured) {
    time.dateTime = configuration.updatedAt;
    time.textContent = formatChinaTimestamp(configuration.updatedAt);
    updated.hidden = false;
    deleteContainer.append(createDeleteButton(configuration, card));
  } else {
    time.removeAttribute('datetime');
    time.textContent = '';
    updated.hidden = true;
  }
}

function bindUploadForm(card) {
  const form = card.querySelector('[data-authorization-upload]');
  const fileControl = form.elements.cookieFile;
  const submit = form.querySelector('[data-authorization-submit]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileControl.files[0];
    if (file === undefined) return;

    submit.disabled = true;
    clearCardError(card);
    try {
      const result = await request(
        `/api/authorizations/cookies/${card.dataset.authorizationPlatform}`,
        'PUT',
        file,
      );
      renderConfiguration(result.configuration);
    } catch (error) {
      showCardError(card, error);
    } finally {
      fileControl.value = '';
      submit.disabled = false;
    }
  });
}

async function load() {
  const cards = document.querySelectorAll('[data-authorization-platform]');
  cards.forEach(bindUploadForm);

  const result = await request('/api/authorizations/cookies');
  result.configurations.forEach(renderConfiguration);
}

load().catch((error) => {
  const region = document.querySelector('#authorization-page-error');
  region.textContent = errorMessage(error);
  region.hidden = false;
});
