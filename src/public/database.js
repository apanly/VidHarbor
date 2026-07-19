const tableList = document.querySelector('#database-table-list');
const queryForm = document.querySelector('#database-query-form');
const sqlInput = document.querySelector('#database-sql');
const runButton = document.querySelector('#database-run');
const result = document.querySelector('#database-result');
const pageError = document.querySelector('#database-page-error');

async function request(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok) throw payload.error;
  return payload;
}

function showError(error) {
  pageError.textContent = `${error.code}: ${error.message}`;
  pageError.hidden = false;
}

function renderResult(columns, rows) {
  result.textContent = '';

  const summary = document.createElement('p');
  summary.className = 'database-result-summary';
  summary.textContent = `共 ${rows.length} 行 · ${columns.length} 列`;
  result.append(summary);

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'database-result-empty';
    empty.textContent = '无数据';
    result.append(empty);
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'table-responsive';
  const table = document.createElement('table');
  table.className = 'table table-bordered table-hover align-middle mb-0 text-nowrap font-monospace small';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of columns) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = column;
    headRow.append(cell);
  }
  head.append(headRow);

  const body = document.createElement('tbody');
  for (const row of rows) {
    const tableRow = document.createElement('tr');
    for (const value of row) {
      const cell = document.createElement('td');
      cell.className = 'database-cell';
      cell.textContent = value === null ? '' : String(value);
      cell.title = cell.textContent;
      tableRow.append(cell);
    }
    body.append(tableRow);
  }
  table.append(head, body);
  wrapper.append(table);
  result.append(wrapper);
}

async function executeQuery() {
  runButton.disabled = true;
  pageError.hidden = true;
  try {
    const payload = await request('/api/database/query', 'POST', { sql: sqlInput.value });
    renderResult(payload.columns, payload.rows);
  } catch (error) {
    showError(error);
  } finally {
    runButton.disabled = false;
  }
}

async function loadTables() {
  try {
    const { tables } = await request('/api/database/tables');
    tableList.textContent = '';
    for (const table of tables) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'list-group-item list-group-item-action text-start text-truncate';
      button.textContent = table;
      button.title = table;
      button.addEventListener('click', () => {
        for (const item of tableList.querySelectorAll('button')) item.classList.remove('active');
        button.classList.add('active');
        sqlInput.value = `SELECT * FROM ${table} LIMIT 200`;
        void executeQuery();
      });
      tableList.append(button);
    }
  } catch (error) {
    showError(error);
  }
}

queryForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void executeQuery();
});

void loadTables();
