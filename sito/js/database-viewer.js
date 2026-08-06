// Database Viewer - Dynamic Table Management
let currentTable = null;
let allTables = [];

function getToken() {
  return localStorage.getItem('authToken');
}

// Load all table structures from database
async function loadTableStructures() {
  try {
    const response = await fetch(`${API_URL}/table-structures`, {
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });

    if (response.ok) {
      allTables = await response.json();
      renderTablesList();
    } else {
      console.error('Failed to load table structures');
    }
  } catch (error) {
    console.error('Error loading table structures:', error);
  }
}

// Render tables list on sidebar
function renderTablesList() {
  const tablesList = document.getElementById('tablesList');
  tablesList.innerHTML = '';

  allTables.forEach(table => {
    const tableItem = document.createElement('div');
    tableItem.className = 'table-item';
    if (currentTable && currentTable.id === table.id) {
      tableItem.classList.add('active');
    }

    tableItem.innerHTML = `
      <span onclick="selectTable('${table.id}')">${table.display_name}</span>
      <div class="table-actions">
        <button class="btn-icon" onclick="editTable('${table.id}')" title="Edit">✏️</button>
        <button class="btn-icon" onclick="deleteTable('${table.id}')" title="Delete">🗑️</button>
      </div>
    `;

    tablesList.appendChild(tableItem);
  });
}

// Select a table and load its data
async function selectTable(tableId) {
  const table = allTables.find(t => t.id === tableId);
  if (!table) return;

  currentTable = table;
  renderTablesList();

  // Update header
  document.getElementById('selectedTableName').textContent = table.display_name;
  document.getElementById('selectedTableDesc').textContent = table.description || 'No description';

  // Load table data
  await loadTableData(table.table_name);
}

// Load data from a specific table
async function loadTableData(tableName) {
  const tableContent = document.getElementById('tableContent');
  tableContent.innerHTML = '<p class="loading">Loading...</p>';

  try {
    const response = await fetch(`${API_URL}/data/${tableName}`, {
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });

    if (response.ok) {
      const data = await response.json();

      if (!data || data.length === 0) {
        tableContent.innerHTML = '<div class="empty-state"><p>No data in this table</p></div>';
        return;
      }

      const columns = Object.keys(data[0]);
      const html = `
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background-color: var(--gray-100); border-bottom: 2px solid var(--gray-300);">
                ${columns.map(col => `
                  <th style="padding: 12px; text-align: left; font-weight: 600; color: var(--gray-700);">
                    ${col}
                  </th>
                `).join('')}
              </tr>
            </thead>
            <tbody>
              ${data.map(row => `
                <tr style="border-bottom: 1px solid var(--gray-200);">
                  ${columns.map(col => {
                    let value = row[col];
                    if (value === null) {
                      return '<td style="padding: 12px; color: var(--gray-400);"><em>null</em></td>';
                    }
                    if (typeof value === 'object') {
                      value = JSON.stringify(value);
                    }
                    const strValue = String(value).substring(0, 100);
                    return `<td style="padding: 12px; color: var(--gray-700);">${strValue}</td>`;
                  }).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
      tableContent.innerHTML = html;
    } else {
      tableContent.innerHTML = '<div class="empty-state"><p>Error loading data</p></div>';
    }
  } catch (error) {
    console.error('Error loading table data:', error);
    tableContent.innerHTML = '<div class="empty-state"><p>Connection error</p></div>';
  }
}

// Edit table
async function editTable(tableId) {
  const table = allTables.find(t => t.id === tableId);
  if (!table) return;

  const newDisplayName = prompt('Display Name:', table.display_name);
  if (!newDisplayName) return;

  const newDescription = prompt('Description:', table.description || '');

  try {
    const response = await fetch(`${API_URL}/table-structures/${tableId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`
      },
      body: JSON.stringify({
        display_name: newDisplayName,
        description: newDescription
      })
    });

    if (response.ok) {
      await loadTableStructures();
      if (currentTable && currentTable.id === tableId) {
        selectTable(tableId);
      }
    }
  } catch (error) {
    console.error('Error updating table:', error);
  }
}

// Delete table
async function deleteTable(tableId) {
  if (!confirm('Are you sure you want to delete this table entry?')) return;

  try {
    const response = await fetch(`${API_URL}/table-structures/${tableId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });

    if (response.ok) {
      await loadTableStructures();
      if (currentTable && currentTable.id === tableId) {
        currentTable = null;
        document.getElementById('tableContent').innerHTML = `
          <div class="empty-state"><p>Select a table from the list</p></div>
        `;
      }
    }
  } catch (error) {
    console.error('Error deleting table:', error);
  }
}

// Add new table functionality (to be implemented)

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadTableStructures();
});
