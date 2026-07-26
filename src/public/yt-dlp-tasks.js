import { formatChinaTimestamp } from '/public/time.js';
import { formatApiError, formatNumber, t } from '/public/i18n.js';

const taskTypeKeys = Object.freeze({
  media_download: 'task.type.media_download',
  metadata_probe: 'task.type.metadata_probe',
  channel_initial_sync: 'task.type.channel_initial_sync',
  channel_manual_check: 'task.type.channel_manual_check',
  channel_scheduled_check: 'task.type.channel_scheduled_check',
});

const taskStatusKeys = Object.freeze({
  queued: 'status.task.queued',
  running: 'status.task.running',
  succeeded: 'status.task.succeeded',
  failed: 'status.task.failed',
  canceled: 'status.task.canceled',
});

const taskStatusClasses = Object.freeze({
  queued: 'text-bg-warning',
  running: 'text-bg-primary',
  succeeded: 'text-bg-success',
  failed: 'text-bg-danger',
  canceled: 'text-bg-secondary',
});

const activeStatuses = new Set(['queued', 'running']);
const terminalStatuses = new Set(['succeeded', 'failed', 'canceled']);
const terminalTaskLimit = 30;
const errorRegion = document.querySelector('#page-error');

function fixedLabel(labels, value, field) {
  if (!Object.hasOwn(labels, value)) {
    throw new Error(`未知任务${field}：${String(value)}`);
  }
  return labels[value];
}

function appendTextCell(row, value, label, className) {
  const cell = document.createElement('td');
  if (className !== undefined) cell.className = className;
  cell.dataset.label = label;
  cell.textContent = value;
  row.append(cell);
}

function taskRow(task) {
  const row = document.createElement('tr');
  appendTextCell(row, String(task.id), 'ID', 'yt-dlp-task-id');
  appendTextCell(row, t(fixedLabel(taskTypeKeys, task.type, 'type')), t('field.type'));

  const statusCell = document.createElement('td');
  statusCell.dataset.label = t('field.status');
  const status = document.createElement('span');
  status.className = `badge ${fixedLabel(taskStatusClasses, task.status, 'status')}`;
  status.textContent = t(fixedLabel(taskStatusKeys, task.status, 'status'));
  statusCell.append(status);
  row.append(statusCell);

  appendTextCell(row, formatChinaTimestamp(task.createdAt), t('field.createdAt'), 'yt-dlp-task-time');
  appendTextCell(row, task.startedAt === null ? t('common.none') : formatChinaTimestamp(task.startedAt), t('field.startedAt'), 'yt-dlp-task-time');
  appendTextCell(row, task.finishedAt === null ? t('common.none') : formatChinaTimestamp(task.finishedAt), t('field.finishedAt'), 'yt-dlp-task-time');
  appendTextCell(row, task.status === 'failed' ? task.failureReason : t('common.none'), t('field.failureReason'), 'yt-dlp-task-failure');
  return row;
}

function renderGroup(tasks, listId, emptyId, countId) {
  const list = document.querySelector(`#${listId}`);
  const empty = document.querySelector(`#${emptyId}`);
  document.querySelector(`#${countId}`).textContent = formatNumber(tasks.length);
  empty.hidden = tasks.length !== 0;
  for (const task of tasks) list.append(taskRow(task));
}

function showError(error) {
  errorRegion.textContent = error instanceof Error
    ? `${t('common.failed')}: ${error.message}`
    : formatApiError(error);
  errorRegion.hidden = false;
}

async function load() {
  const response = await fetch('/api/yt-dlp/tasks', { credentials: 'same-origin' });
  const body = await response.json();
  if (!response.ok) throw body.error;
  if (!Array.isArray(body.tasks)) throw new Error('任务快照格式错误');

  const activeTasks = [];
  const terminalTasks = [];
  for (const task of body.tasks) {
    fixedLabel(taskTypeKeys, task.type, 'type');
    fixedLabel(taskStatusKeys, task.status, 'status');
    if (activeStatuses.has(task.status)) activeTasks.push(task);
    else if (terminalStatuses.has(task.status)) terminalTasks.push(task);
  }

  renderGroup(activeTasks, 'active-task-list', 'active-task-empty', 'active-task-count');
  terminalTasks.sort((left, right) => right.id - left.id);
  renderGroup(terminalTasks.slice(0, terminalTaskLimit), 'terminal-task-list', 'terminal-task-empty', 'terminal-task-count');
}

load().catch(showError);
