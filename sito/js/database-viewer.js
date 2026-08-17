// Database Viewer - Dynamic Table Management
let currentTable = null;
let allTables = [];

function getToken() {
  return localStorage.getItem('authToken');
}

// Escaping HTML per evitare XSS: i dati del DB non sono fidati e vengono inseriti in innerHTML.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

// Render tables list on sidebar - simple list
function renderTablesList() {
  const tablesList = document.getElementById('tablesList');
  tablesList.innerHTML = '';

  allTables.filter(table => table.is_active).forEach(table => {
    const tableLink = document.createElement('a');
    tableLink.href = '#';
    tableLink.textContent = table.display_name;
    tableLink.style.cssText = `
      display: block;
      padding: 8px 0;
      color: var(--primary);
      cursor: pointer;
      font-weight: 500;
      text-decoration: none;
      border-bottom: 1px solid var(--gray-200);
      transition: all 0.2s;
    `;

    tableLink.addEventListener('mouseover', () => {
      tableLink.style.textDecoration = 'underline';
    });

    tableLink.addEventListener('mouseout', () => {
      if (!(currentTable && currentTable.id === table.id)) {
        tableLink.style.textDecoration = 'none';
      }
    });

    if (currentTable && currentTable.id === table.id) {
      tableLink.style.textDecoration = 'underline';
      tableLink.style.fontWeight = 'bold';
      tableLink.style.color = '#1E40AF';
    }

    tableLink.addEventListener('click', (e) => {
      e.preventDefault();
      selectTable(table.id);
    });

    tablesList.appendChild(tableLink);
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

  // Add action buttons
  const tableData = document.getElementById('tableData');
  const existingButtons = tableData.querySelector('.table-action-buttons');
  if (existingButtons) existingButtons.remove();

  const buttonsDiv = document.createElement('div');
  buttonsDiv.className = 'table-action-buttons';
  buttonsDiv.style.cssText = 'display: flex; gap: 10px; margin-bottom: 20px;';
  buttonsDiv.innerHTML = `
    <button onclick="newRecord('${table.table_name}')" style="background: #10B981; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">New</button>
  `;
  tableData.insertBefore(buttonsDiv, tableData.firstChild);

  // Load table data
  await loadTableData(table.table_name);
}

// Load data from a specific table
async function loadTableData(tableName) {
  const tableContent = document.getElementById('tableData');
  const buttons = tableContent.querySelector('.table-action-buttons');
  tableContent.innerHTML = '<p class="loading">Loading...</p>';
  if (buttons) {
    tableContent.insertBefore(buttons, tableContent.firstChild);
  }

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

      // Filter out system columns
      const hiddenColumns = ['id', 'created_by', 'created_at', 'updated_at'];
      const columns = Object.keys(data[0]).filter(col => !hiddenColumns.includes(col));

      const html = `
        <div style="overflow-x: auto;">
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background-color: var(--gray-100); border-bottom: 2px solid var(--gray-300);">
                ${columns.map(col => `
                  <th style="padding: 12px; text-align: left; font-weight: 600; color: var(--gray-700);">
                    ${escapeHtml(col)}
                  </th>
                `).join('')}
                <th style="padding: 12px; text-align: center; font-weight: 600; color: var(--gray-700);">Azioni</th>
              </tr>
            </thead>
            <tbody>
              ${data.map(row => `
                <tr style="border-bottom: 1px solid var(--gray-200);" data-row-id="${row.id}">
                  ${columns.map(col => {
                    let value = row[col];
                    if (value === null) {
                      return '<td style="padding: 12px; color: var(--gray-400);"><em>null</em></td>';
                    }
                    if (typeof value === 'object') {
                      value = JSON.stringify(value);
                    }
                    const strValue = String(value).substring(0, 100);
                    return `<td style="padding: 12px; color: var(--gray-700);">${escapeHtml(strValue)}</td>`;
                  }).join('')}
                  <td style="padding: 12px; text-align: center; display: flex; gap: 8px; justify-content: center;">
                    <button class="btn-edit" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 4px; color: #3B82F6;" title="Edit">✏️</button>
                    <button class="btn-delete" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 4px; color: #EF4444;" title="Delete">✕</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
      // Preserve buttons and insert table after them
      const buttons = tableContent.querySelector('.table-action-buttons');
      tableContent.innerHTML = '';
      if (buttons) {
        tableContent.appendChild(buttons);
      }
      const tableDiv = document.createElement('div');
      tableDiv.innerHTML = html;
      tableContent.appendChild(tableDiv);

      // Add event listeners for action buttons
      tableDiv.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const rowId = btn.closest('tr').dataset.rowId;
          console.log(`Edit clicked: table=${tableName}, id=${rowId}`);
          editRecord(tableName, rowId);
        });
      });

      tableDiv.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const rowId = btn.closest('tr').dataset.rowId;
          console.log(`Delete clicked: table=${tableName}, id=${rowId}`);
          deleteRecord(tableName, rowId);
        });
      });
    } else {
      const buttons = tableContent.querySelector('.table-action-buttons');
      tableContent.innerHTML = '';
      if (buttons) {
        tableContent.appendChild(buttons);
      }
      const errorDiv = document.createElement('div');
      errorDiv.className = 'empty-state';
      errorDiv.innerHTML = '<p>Error loading data</p>';
      tableContent.appendChild(errorDiv);
    }
  } catch (error) {
    console.error('Error loading table data:', error);
    const buttons = tableContent.querySelector('.table-action-buttons');
    tableContent.innerHTML = '';
    if (buttons) {
      tableContent.appendChild(buttons);
    }
    const errorDiv = document.createElement('div');
    errorDiv.className = 'empty-state';
    errorDiv.innerHTML = '<p>Connection error</p>';
    tableContent.appendChild(errorDiv);
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
        document.getElementById('tableData').innerHTML = `
          <p class="loading">Select a table from the list</p>
        `;
      }
    }
  } catch (error) {
    console.error('Error deleting table:', error);
  }
}

// Load table_structures table directly
async function loadTableStructuresTable() {
  // Update header
  document.getElementById('selectedTableName').textContent = 'Table Structures';
  document.getElementById('selectedTableDesc').textContent = 'Manage database tables metadata';

  // Add action buttons
  const tableData = document.getElementById('tableData');
  const existingButtons = tableData.querySelector('.table-action-buttons');
  if (existingButtons) existingButtons.remove();

  const buttonsDiv = document.createElement('div');
  buttonsDiv.className = 'table-action-buttons';
  buttonsDiv.style.cssText = 'display: flex; gap: 10px; margin-bottom: 20px;';
  buttonsDiv.innerHTML = `
    <button onclick="newRecord('table_structures')" style="background: #10B981; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">New</button>
  `;
  tableData.insertBefore(buttonsDiv, tableData.firstChild);

  // Load table data
  await loadTableData('table_structures');
}

// Modal state
let currentModalTable = null;
let currentModalRecordId = null;
let currentModalColumns = [];

// Create form field (handles foreign keys, boolean fields, and password fields)
async function createFormField(columnName, value) {
  const safeColumn = escapeHtml(columnName);

  // Check if this is a password field
  if (columnName === 'password' || columnName === 'password_hash') {
    return `<div style="margin-bottom: 1rem;"><label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">${safeColumn}</label><input type="password" name="${safeColumn}" placeholder="Enter password" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit;"></div>`;
  }

  // Check if this is a boolean field (starts with is_ or has_)
  if (columnName.startsWith('is_') || columnName.startsWith('has_')) {
    const isChecked = value === true || value === 'true' || value === 1 || value === '1';
    return `<div style="margin-bottom: 1rem;"><label style="display: flex; align-items: center; gap: 12px; font-weight: 500; cursor: pointer;"><input type="hidden" name="${safeColumn}" value="false"><input type="checkbox" name="${safeColumn}" value="true" ${isChecked ? 'checked' : ''} style="width: 20px; height: 20px; cursor: pointer; accent-color: #10B981;"><span>${safeColumn}</span></label></div>`;
  }

  // Check if this is a foreign key field (ends with _id)
  if (columnName.endsWith('_id')) {
    let relatedTableName = columnName.slice(0, -3); // Remove "_id"

    // Pluralize table name (simple rules)
    if (!relatedTableName.endsWith('s')) {
      relatedTableName = relatedTableName + 's';
    }

    try {
      const response = await fetch(`${API_URL}/data/${relatedTableName}`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });

      if (response.ok) {
        const relatedData = await response.json();
        const options = relatedData.map(row => ({
          id: row.id,
          display: escapeHtml(row.name || row.display_name || row.description || row.title || `Item ${row.id}`)
        }));

        const optionsHtml = options.map(opt => `<option value="${escapeHtml(opt.id)}" ${opt.id == value ? 'selected' : ''}>${opt.display}</option>`).join('');

        return `<div style="margin-bottom: 1rem;"><label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">${safeColumn}</label><select name="${safeColumn}" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit;"><option value="">-- Seleziona --</option>${optionsHtml}</select></div>`;
      }
    } catch (error) {
      console.error('Error loading related data:', error);
    }
  }

  // Default: text input
  const stringValue = escapeHtml(value);
  return `<div style="margin-bottom: 1rem;"><label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">${safeColumn}</label><input type="text" name="${safeColumn}" value="${stringValue}" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit;"></div>`;
}

// Open modal for editing a record
async function editRecord(tableName, recordId) {
  const response = await fetch(`${API_URL}/data/${tableName}`, {
    headers: { 'Authorization': `Bearer ${getToken()}` }
  });

  if (!response.ok) return;

  const data = await response.json();
  // recordId arriva da dataset.rowId (stringa); r.id può essere numerico.
  // Confronto per stringa per evitare il mismatch "5" === 5 → false.
  const record = data.find(r => String(r.id) === String(recordId));
  if (!record) return;

  currentModalTable = tableName;
  currentModalRecordId = recordId;

  // Get all columns except system ones
  const hiddenColumns = ['id', 'created_by', 'created_at', 'updated_at'];
  currentModalColumns = Object.keys(record).filter(col => !hiddenColumns.includes(col));

  document.getElementById('modalTitle').textContent = 'Edit Record';

  const formFields = document.getElementById('formFields');
  let htmlContent = '';

  for (const col of currentModalColumns) {
    htmlContent += await createFormField(col, record[col] || '');
  }

  formFields.innerHTML = htmlContent;
  document.getElementById('recordModal').style.display = 'flex';

  // Auto-populate id_roles when role_id changes
  const roleSelect = document.querySelector('select[name="role_id"]');
  const idRolesInput = document.querySelector('input[name="id_roles"]');

  if (roleSelect && idRolesInput) {
    roleSelect.addEventListener('change', async (e) => {
      const selectedRoleId = e.target.value;
      if (!selectedRoleId) {
        idRolesInput.value = '';
        return;
      }

      try {
        const response = await fetch(`${API_URL}/data/roles`, {
          headers: { 'Authorization': `Bearer ${getToken()}` }
        });

        if (response.ok) {
          const roles = await response.json();
          const selectedRole = roles.find(r => r.id == selectedRoleId);
          if (selectedRole && selectedRole.id_roles) {
            idRolesInput.value = selectedRole.id_roles;
          }
        }
      } catch (error) {
        console.error('Error loading role details:', error);
      }
    });
  }
}

// Open modal for creating a new record
async function newRecord(tableName) {
  currentModalTable = tableName;
  currentModalRecordId = null;

  // Extract columns from the table header (works for any table)
  const tableHeaders = Array.from(document.querySelectorAll('table thead th'));
  if (tableHeaders.length > 0) {
    // Remove last column (Azioni)
    currentModalColumns = tableHeaders.slice(0, -1).map(th => th.textContent.trim());
  } else {
    currentModalColumns = [];
  }

  document.getElementById('modalTitle').textContent = 'New Record';

  const formFields = document.getElementById('formFields');
  let htmlContent = '';

  for (const col of currentModalColumns) {
    htmlContent += await createFormField(col, '');
  }

  formFields.innerHTML = htmlContent;
  document.getElementById('recordModal').style.display = 'flex';

  // Auto-populate id_roles when role_id changes
  const roleSelect = document.querySelector('select[name="role_id"]');
  const idRolesInput = document.querySelector('input[name="id_roles"]');

  if (roleSelect && idRolesInput) {
    roleSelect.addEventListener('change', async (e) => {
      const selectedRoleId = e.target.value;
      if (!selectedRoleId) {
        idRolesInput.value = '';
        return;
      }

      try {
        const response = await fetch(`${API_URL}/data/roles`, {
          headers: { 'Authorization': `Bearer ${getToken()}` }
        });

        if (response.ok) {
          const roles = await response.json();
          const selectedRole = roles.find(r => r.id == selectedRoleId);
          if (selectedRole && selectedRole.id_roles) {
            idRolesInput.value = selectedRole.id_roles;
          }
        }
      } catch (error) {
        console.error('Error loading role details:', error);
      }
    });
  }
}

// Save record (Create or Update)
async function saveRecord(event) {
  event.preventDefault();

  const formData = new FormData(document.getElementById('recordForm'));
  const data = Object.fromEntries(formData);

  // Save table name before closeModal() resets it
  const tableName = currentModalTable;
  const recordId = currentModalRecordId;

  const method = recordId ? 'PUT' : 'POST';
  const url = recordId
    ? `${API_URL}/data/${tableName}/${recordId}`
    : `${API_URL}/data/${tableName}`;

  try {
    const response = await fetch(url, {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`
      },
      body: JSON.stringify(data)
    });

    if (response.ok) {
      closeModal();
      // If modifying table_structures, reload sidebar
      if (tableName === 'table_structures') {
        await loadTableStructures();
      }
      // Reload table data using saved table name
      await loadTableData(tableName);
    } else {
      alert('Error saving record');
    }
  } catch (error) {
    console.error('Error saving record:', error);
    alert('Error saving record');
  }
}

// Close modal
function closeModal() {
  document.getElementById('recordModal').style.display = 'none';
  currentModalTable = null;
  currentModalRecordId = null;
  currentModalColumns = [];
}

// Delete a record
async function deleteRecord(tableName, recordId) {
  if (!confirm('Are you sure you want to delete this record?')) return;

  try {
    const response = await fetch(`${API_URL}/data/${tableName}/${recordId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });

    if (response.ok) {
      // If deleting from table_structures, reload sidebar
      if (tableName === 'table_structures') {
        await loadTableStructures();
      }
      // Reload table data
      const table = currentTable || { table_name: tableName };
      await loadTableData(table.table_name || tableName);
    } else {
      alert('Error deleting record');
    }
  } catch (error) {
    console.error('Error deleting record:', error);
    alert('Error deleting record');
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadTableStructures();
});
