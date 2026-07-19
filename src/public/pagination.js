export function renderPagination(container, value, onPage) {
  container.replaceChildren();
  container.hidden = value.totalItems === 0;
  if (container.hidden) return;
  const previous = document.createElement('button'); previous.type = 'button'; previous.className = 'btn btn-sm btn-outline-secondary'; previous.textContent = '上一页'; previous.disabled = value.page === 1; previous.addEventListener('click', () => onPage(value.page - 1));
  const pages = document.createElement('div'); pages.className = 'pagination-pages';
  const candidates = new Set([1, value.totalPages, value.page - 1, value.page, value.page + 1].filter((page) => page >= 1 && page <= value.totalPages));
  let lastPage = 0;
  for (const page of [...candidates].sort((left, right) => left - right)) {
    if (lastPage !== 0 && page - lastPage > 1) { const gap = document.createElement('span'); gap.textContent = '…'; pages.append(gap); }
    const button = document.createElement('button'); button.type = 'button'; button.className = `btn btn-sm ${page === value.page ? 'btn-primary' : 'btn-outline-secondary'}`; button.textContent = String(page); button.ariaLabel = `第 ${page} 页`; button.disabled = page === value.page; button.addEventListener('click', () => onPage(page)); pages.append(button); lastPage = page;
  }
  const next = document.createElement('button'); next.type = 'button'; next.className = 'btn btn-sm btn-outline-secondary'; next.textContent = '下一页'; next.disabled = value.page >= value.totalPages; next.addEventListener('click', () => onPage(value.page + 1));
  const summary = document.createElement('span'); summary.className = 'pagination-summary'; summary.textContent = `第 ${value.page} / ${value.totalPages} 页 · 共 ${value.totalItems} 条`;
  container.append(previous, pages, next, summary);
}
