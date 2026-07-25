import { renderPagination } from '/public/pagination.js';
import { formatChinaTimestamp } from '/public/time.js';

const errorRegion = document.querySelector('#page-error');
const list = document.querySelector('#notification-list');
const emptyState = document.querySelector('#notification-empty-state');
const requestedPage = Number(new URLSearchParams(location.search).get('page') ?? '1');

function showError(error) { errorRegion.textContent = error instanceof Error ? `${error.name}: ${error.message}` : `${error.code}: ${error.message}`; errorRegion.hidden = false; }
async function request(path, method = 'GET', body) { const response = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); if (!response.ok) throw result.error; return result; }

async function load() {
  const notifications = await request(`/api/notifications?page=${requestedPage}`);
  if (notifications.items.length === 0) {
    if (requestedPage > 1 && notifications.pagination.totalPages < requestedPage) { location.search = `?page=${Math.max(1, notifications.pagination.totalPages)}`; return; }
    emptyState.hidden = false;
    return;
  }
  const markAll = document.querySelector('#mark-all-read'); markAll.hidden = notifications.unreadCount === 0; markAll.addEventListener('click', async () => { try { await request('/api/notifications/read-all', 'POST', {}); location.reload(); } catch (error) { showError(error); } });
  for (const notification of notifications.items) {
    const row = document.createElement('tr');
    const videoCell = document.createElement('td'); videoCell.className = 'notification-video-cell';
    const videoLink = document.createElement('a'); videoLink.className = 'd-block'; videoLink.href = notification.video.url; videoLink.target = '_blank'; videoLink.rel = 'noreferrer'; videoLink.textContent = notification.video.title; videoCell.append(videoLink);
    const channelCell = document.createElement('td');
    const channelLink = document.createElement('a'); channelLink.href = `/channels/${notification.channel.id}`; channelLink.textContent = notification.channel.customName; channelCell.append(channelLink);
    const publishedCell = document.createElement('td'); publishedCell.textContent = notification.video.publishedDate;
    const createdCell = document.createElement('td'); createdCell.textContent = formatChinaTimestamp(notification.createdAt);
    const stateCell = document.createElement('td');
    const readState = document.createElement('span'); readState.className = notification.readAt === null ? 'badge text-bg-warning' : 'badge text-bg-light border'; readState.textContent = notification.readAt === null ? '未读' : `已读：${formatChinaTimestamp(notification.readAt)}`; stateCell.append(readState);
    const actionCell = document.createElement('td');
    const readButton = document.createElement('button'); readButton.className = 'btn btn-sm btn-outline-primary'; readButton.type = 'button'; readButton.textContent = '标记已读'; readButton.disabled = notification.readAt !== null; readButton.addEventListener('click', async () => { try { await request(`/api/notifications/${notification.id}/read`, 'POST', {}); location.reload(); } catch (error) { showError(error); } }); actionCell.append(readButton);
    row.append(videoCell, channelCell, publishedCell, createdCell, stateCell, actionCell); list.append(row);
  }
  renderPagination(document.querySelector('#notification-pagination'), notifications.pagination, (page) => { location.search = `?page=${page}`; });
}

load().catch(showError);
