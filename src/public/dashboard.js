const errorRegion = document.querySelector('#page-error');
const summary = document.querySelector('#channel-summary');
const labels = { success: '检查成功', no_updates: '没有更新', failed: '检查失败' };
const styles = { success: 'text-bg-success', no_updates: 'text-bg-secondary', failed: 'text-bg-danger' };

function showError(error) {
  errorRegion.textContent = error instanceof Error
    ? `${error.name}: ${error.message}`
    : `${error.code}: ${error.message}`;
  errorRegion.hidden = false;
}

async function load() {
  const [channelResponse, notificationResponse, downloadResponse] = await Promise.all([fetch('/api/channels/updates', { credentials: 'same-origin' }), fetch('/api/notifications?page=1', { credentials: 'same-origin' }), fetch('/api/downloads?page=1', { credentials: 'same-origin' })]);
  const body = await channelResponse.json();
  const notifications = await notificationResponse.json();
  const downloads = await downloadResponse.json();
  if (!channelResponse.ok) { showError(body.error); return; }
  if (!notificationResponse.ok) { showError(notifications.error); return; }
  if (!downloadResponse.ok) { showError(downloads.error); return; }
  const unreadCount = notifications.unreadCount;
  const runningCount = downloads.statusCounts.pending + downloads.statusCounts.running + downloads.statusCounts.downloading + downloads.statusCounts.deleting;
  const failedCount = downloads.statusCounts.failed + downloads.statusCounts.interrupted;
  const totals = document.createElement('div'); totals.className = 'col-12'; totals.innerHTML = `<div class="alert alert-info">未读提醒：${unreadCount}；进行中下载：${runningCount}；失败/中断下载：${failedCount}</div>`; summary.append(totals);
  if (body.items.length === 0) return;
  for (const channel of body.items) {
    const column = document.createElement('div');
    column.className = 'col-md-6 col-xl-4';
    const card = document.createElement('article');
    card.className = 'card h-100';
    const cardBody = document.createElement('div');
    cardBody.className = 'card-body';
    const title = document.createElement('h2');
    title.className = 'h5';
    const link = document.createElement('a');
    link.href = `/channels/${channel.id}`;
    link.textContent = channel.customName;
    title.append(link);
    cardBody.append(title);
    const result = channel.lastCheck.result;
    const badge = document.createElement('span');
    badge.className = `badge ${result === null ? 'text-bg-light' : styles[result]}`;
    badge.textContent = result === null ? '尚无定时检查' : labels[result];
    cardBody.append(badge);
    if (result === 'failed') {
      const reason = document.createElement('p');
      reason.className = 'text-danger mt-3 mb-0';
      reason.textContent = channel.lastCheck.error;
      cardBody.append(reason);
    }
    card.append(cardBody);
    column.append(card);
    summary.append(column);
  }
}

load().catch(showError);
