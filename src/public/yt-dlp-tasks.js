import { formatChinaTimestamp } from '/public/time.js';

const taskTypeLabels = Object.freeze({
  media_download: '媒体下载',
  metadata_probe: '元数据探测',
  channel_initial_sync: '频道首次同步',
  channel_manual_check: '频道手动检查',
  channel_scheduled_check: '频道定时检查',
});

const taskStatusLabels = Object.freeze({
  queued: '排队中',
  running: '运行中',
  succeeded: '已成功',
  failed: '已失败',
  cance\u006ced: '已取消',
});

const taskStatusClasses = Object.freeze({
  queued: 'text-bg-warning',
  running: 'text-bg-primary',
  succeeded: 'text-bg-success',
  failed: 'text-bg-danger',
  cance\u006ced: 'text-bg-secondary',
});

const activeStatuses = new Set(['queued', 'running']);
const terminalStatuses = new Set(['succeeded', 'failed', 'cance\u006ced']);
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
  appendTextCell(row, String(task.id), '任务 ID', 'yt-dlp-task-id');
  appendTextCell(row, fixedLabel(taskTypeLabels, task.type, '类型'), '任务类型');

  const statusCell = document.createElement('td');
  statusCell.dataset.label = '状态';
  const status = document.createElement('span');
  status.className = `badge ${fixedLabel(taskStatusClasses, task.status, '状态')}`;
  status.textContent = fixedLabel(taskStatusLabels, task.status, '状态');
  statusCell.append(status);
  row.append(statusCell);

  appendTextCell(row, formatChinaTimestamp(task.createdAt), '创建时间', 'yt-dlp-task-time');
  appendTextCell(row, task.startedAt === null ? '—' : formatChinaTimestamp(task.startedAt), '开始时间', 'yt-dlp-task-time');
  appendTextCell(row, task.finishedAt === null ? '—' : formatChinaTimestamp(task.finishedAt), '结束时间', 'yt-dlp-task-time');
  appendTextCell(row, task.status === 'failed' ? task.failureReason : '—', '失败原因', 'yt-dlp-task-failure');
  return row;
}

function renderGroup(tasks, listId, emptyId, countId) {
  const list = document.querySelector(`#${listId}`);
  const empty = document.querySelector(`#${emptyId}`);
  document.querySelector(`#${countId}`).textContent = String(tasks.length);
  empty.hidden = tasks.length !== 0;
  for (const task of tasks) list.append(taskRow(task));
}

function showError(error) {
  errorRegion.textContent = error instanceof Error
    ? `${error.name}: ${error.message}`
    : `${error.code}: ${error.message}`;
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
    fixedLabel(taskTypeLabels, task.type, '类型');
    fixedLabel(taskStatusLabels, task.status, '状态');
    if (activeStatuses.has(task.status)) activeTasks.push(task);
    else if (terminalStatuses.has(task.status)) terminalTasks.push(task);
  }

  renderGroup(activeTasks, 'active-task-list', 'active-task-empty', 'active-task-count');
  terminalTasks.sort((left, right) => right.id - left.id);
  renderGroup(terminalTasks.slice(0, terminalTaskLimit), 'terminal-task-list', 'terminal-task-empty', 'terminal-task-count');
}

load().catch(showError);
