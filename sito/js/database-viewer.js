// Database Viewer - Dynamic Table Management
let currentTable = null;
let allTables = [];
let currentFilters = {};   // filtri per colonna attivi { colonna: valore }
let currentColumns = [];   // ultime colonne note (per mostrare i filtri anche a 0 risultati)

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

// Parser CSV: gestisce campi tra virgolette (con virgole/newline interni e "" per l'apice),
// rileva il delimitatore (',' o ';') e usa la prima riga come intestazione.
// Ritorna un array di oggetti { intestazione: valore }.
function parseCsv(text) {
  text = text.replace(/^﻿/, ''); // rimuove eventuale BOM
  const nl = text.indexOf('\n');
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  const delim = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';

  const records = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); records.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignora */ }
      else field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); records.push(row); }
  if (records.length === 0) return [];

  const headers = records[0].map(h => h.trim());
  const objs = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    if (rec.length === 1 && rec[0].trim() === '') continue; // salta righe vuote
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = rec[idx] !== undefined ? rec[idx] : ''; });
    objs.push(obj);
  }
  return objs;
}

// Import CSV con upsert (insert se nuovo, update se l'id esiste già).
function importCsv(tableName) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;

    let rows;
    try {
      rows = parseCsv(await file.text());
    } catch (e) {
      alert('Impossibile leggere il file: ' + e.message);
      return;
    }
    if (!rows || rows.length === 0) {
      alert('Il file CSV è vuoto o non contiene righe valide.');
      return;
    }

    try {
      const response = await fetch(`${API_URL}/data/${tableName}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ rows })
      });
      const result = await response.json();
      if (!response.ok) {
        alert('Errore nell\'import: ' + (result.error || response.status));
        return;
      }

      // Anteprima: i dati NON sono ancora salvati, serve conferma (commit) o annullamento (rollback)
      let msg = `Anteprima import (NON ancora salvato):\n- ${result.inserted} inseriti\n- ${result.updated} aggiornati`;
      if (result.skipped) msg += `\n- ${result.skipped} saltati`;
      if (result.errors && result.errors.length) {
        msg += `\n- ${result.errors.length} errori (riga ${result.errors[0].row}: ${result.errors[0].error})`;
      }
      msg += `\n\nOK = CONFERMA e salva (Commit)\nAnnulla = ANNULLA senza salvare (Rollback)`;
      const doCommit = confirm(msg);
      const endpoint = doCommit ? 'commit' : 'rollback';

      try {
        const fin = await fetch(`${API_URL}/data/import/${endpoint}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${getToken()}` }
        });
        const finRes = await fin.json();
        if (fin.ok) {
          alert(doCommit ? 'Modifiche confermate e salvate.' : 'Import annullato: nessuna modifica salvata.');
          if (doCommit) await loadTableData(tableName);
        } else {
          alert('Errore: ' + (finRes.error || fin.status));
        }
      } catch (e) {
        alert('Errore di connessione durante la conferma: ' + e.message);
      }
    } catch (e) {
      alert('Errore di connessione: ' + e.message);
    }
  };
  input.click();
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
  currentFilters = {};   // reset filtri al cambio tabella
  currentColumns = [];
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
    <button onclick="importCsv('${table.table_name}')" style="background: #3B82F6; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">Import CSV</button>
  `;
  tableData.insertBefore(buttonsDiv, tableData.firstChild);

  // Load table data
  await loadTableData(table.table_name);
}

// Load data from a specific table (con filtri per colonna)
async function loadTableData(tableName) {
  const tableContent = document.getElementById('tableData');
  const buttons = tableContent.querySelector('.table-action-buttons');
  tableContent.innerHTML = '<p class="loading">Loading...</p>';
  if (buttons) tableContent.insertBefore(buttons, tableContent.firstChild);

  // Ricostruisce il contenuto preservando i pulsanti, con eventuale messaggio
  const restore = (msgHtml) => {
    const btns = tableContent.querySelector('.table-action-buttons');
    tableContent.innerHTML = '';
    if (btns) tableContent.appendChild(btns);
    if (msgHtml) {
      const d = document.createElement('div');
      d.className = 'empty-state';
      d.innerHTML = msgHtml;
      tableContent.appendChild(d);
    }
    return tableContent;
  };

  // Query string dai filtri attivi
  const qs = Object.entries(currentFilters)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  try {
    const response = await fetch(`${API_URL}/data/${tableName}${qs ? '?' + qs : ''}`, {
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });

    if (!response.ok) { restore('<p>Error loading data</p>'); return; }

    const data = await response.json();
    const hasFilters = Object.keys(currentFilters).length > 0;
    const hiddenColumns = ['id', 'created_by', 'created_at', 'updated_at'];

    // Determina le colonne: da un record, o le ultime note se il filtro non ha risultati
    let columns;
    if (data && data.length > 0) {
      columns = Object.keys(data[0]).filter(col => !hiddenColumns.includes(col));
      currentColumns = columns;
    } else if (hasFilters && currentColumns.length) {
      columns = currentColumns;
    } else {
      restore('<p>No data in this table</p>');
      return;
    }

    const html = `
      <div style="overflow-x: auto;">
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background-color: var(--gray-100); border-bottom: 2px solid var(--gray-300);">
              ${columns.map(col => `<th style="padding: 12px; text-align: left; font-weight: 600; color: var(--gray-700);">${escapeHtml(col)}</th>`).join('')}
              <th style="padding: 12px; text-align: center; font-weight: 600; color: var(--gray-700);">Azioni</th>
            </tr>
            <tr style="background-color: var(--gray-100); border-bottom: 1px solid var(--gray-300);">
              ${columns.map(col => `<th style="padding: 4px 8px;"><input type="text" class="col-filter" data-col="${escapeHtml(col)}" value="${escapeHtml(currentFilters[col] || '')}" placeholder="Filtra…" style="width: 100%; padding: 4px 6px; border: 1px solid #ccc; border-radius: 4px; font-weight: normal; font-size: 0.85rem;"></th>`).join('')}
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${(data || []).map(row => `
              <tr style="border-bottom: 1px solid var(--gray-200);" data-row-id="${row.id}">
                ${columns.map(col => {
                  let value = row[col];
                  if (value === null) return '<td style="padding: 12px; color: var(--gray-400);"><em>null</em></td>';
                  if (typeof value === 'object') value = JSON.stringify(value);
                  const strValue = String(value).substring(0, 100);
                  return `<td style="padding: 12px; color: var(--gray-700);">${escapeHtml(strValue)}</td>`;
                }).join('')}
                <td style="padding: 12px; text-align: center; display: flex; gap: 8px; justify-content: center;">
                  <button class="btn-edit" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 4px; color: #3B82F6;" title="Edit">✏️</button>
                  <button class="btn-duplicate" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 4px; color: #10B981;" title="Duplica">📋</button>
                  <button class="btn-delete" style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 4px; color: #EF4444;" title="Delete">✕</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    const container = restore(null);
    const tableDiv = document.createElement('div');
    tableDiv.innerHTML = html;
    container.appendChild(tableDiv);

    if (!data || data.length === 0) {
      const note = document.createElement('div');
      note.style.cssText = 'padding: 12px; color: var(--gray-400); font-style: italic;';
      note.textContent = 'Nessun risultato con i filtri applicati.';
      container.appendChild(note);
    }

    // Filtri: applica al cambio (invio o uscita dal campo)
    tableDiv.querySelectorAll('.col-filter').forEach(inp => {
      inp.addEventListener('change', () => {
        const col = inp.dataset.col;
        const val = inp.value.trim();
        if (val) currentFilters[col] = val; else delete currentFilters[col];
        loadTableData(tableName);
      });
    });

    // Azioni riga
    tableDiv.querySelectorAll('.btn-edit').forEach(btn => btn.addEventListener('click', () => editRecord(tableName, btn.closest('tr').dataset.rowId)));
    tableDiv.querySelectorAll('.btn-duplicate').forEach(btn => btn.addEventListener('click', () => duplicateRecord(tableName, btn.closest('tr').dataset.rowId)));
    tableDiv.querySelectorAll('.btn-delete').forEach(btn => btn.addEventListener('click', () => deleteRecord(tableName, btn.closest('tr').dataset.rowId)));

  } catch (error) {
    console.error('Error loading table data:', error);
    restore('<p>Connection error</p>');
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
  currentFilters = {};   // reset filtri
  currentColumns = [];
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
    <button onclick="importCsv('table_structures')" style="background: #3B82F6; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">Import CSV</button>
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
async function createFormField(columnName, value, fkTable) {
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

  // Foreign key -> dropdown dalla tabella referenziata.
  // Priorità alla FK reale (da metadati); in fallback l'euristica "colonna che finisce in _id".
  let relatedTableName = fkTable || null;
  if (!relatedTableName && columnName.endsWith('_id')) {
    relatedTableName = columnName.slice(0, -3);
    if (!relatedTableName.endsWith('s')) relatedTableName = relatedTableName + 's';
  }
  if (relatedTableName) {
    try {
      let options = null;
      if (relatedTableName === 'clients') {
        // clients è EAV: usa l'elenco dei nomi (righe identità) invece di tutte le righe
        const response = await fetch(`${API_URL}/clients/names`, {
          headers: { 'Authorization': `Bearer ${getToken()}` }
        });
        if (response.ok) {
          const data = await response.json();
          options = data.map(c => ({ id: c.id, display: escapeHtml(c.name || `Item ${c.id}`) }));
        }
      } else {
        const response = await fetch(`${API_URL}/data/${relatedTableName}`, {
          headers: { 'Authorization': `Bearer ${getToken()}` }
        });
        if (response.ok) {
          const relatedData = await response.json();
          options = relatedData.map(row => ({
            id: row.id,
            display: escapeHtml(row.nominativo || row.name || row.display_name || row.description || row.title || row.valore2 || `Item ${row.id}`)
          }));
        }
      }

      if (options) {
        const optionsHtml = options.map(opt => `<option value="${escapeHtml(opt.id)}" ${opt.id == value ? 'selected' : ''}>${opt.display}</option>`).join('');
        return `<div style="margin-bottom: 1rem;"><label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">${safeColumn}</label><select name="${safeColumn}" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit;"><option value="">-- Seleziona --</option>${optionsHtml}</select></div>`;
      }
    } catch (error) {
      console.error('Error loading related data:', error);
    }
  }

  // Campi data: usa un selettore data (input type="date") così il valore è sempre
  // nel formato AAAA-MM-GG accettato dal database. Riconosce nomi tipo "data_*",
  // "scadenza", "*_data"/"*_date".
  if (columnName === 'scadenza' || /^data(_|$)/i.test(columnName) || /(^|_)(data|date)(_|$)/i.test(columnName)) {
    let dateVal = '';
    if (value) {
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        dateVal = d.toISOString().slice(0, 10);
      } else if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) {
        dateVal = String(value).slice(0, 10);
      }
    }
    return `<div style="margin-bottom: 1rem;"><label style="display: block; margin-bottom: 0.5rem; font-weight: 500;">${safeColumn}</label><input type="date" name="${safeColumn}" value="${escapeHtml(dateVal)}" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit;"></div>`;
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

  // Colonne del record, escluse le sistema e le generate (non modificabili).
  const hiddenColumns = ['id', 'created_by', 'created_at', 'updated_at'];
  const meta = await fetchColumnsMeta(tableName);
  const generated = new Set((meta || []).filter(c => c.generated).map(c => c.name));
  const fkMap = fkMapFromMeta(meta);
  currentModalColumns = Object.keys(record).filter(col => !hiddenColumns.includes(col) && !generated.has(col));

  document.getElementById('modalTitle').textContent = 'Edit Record';

  const formFields = document.getElementById('formFields');
  let htmlContent = '';

  for (const col of currentModalColumns) {
    htmlContent += await createFormField(col, record[col] || '', fkMap[col]);
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

// Apri la modale pre-compilata con i valori della riga, ma salvando come NUOVO record.
async function duplicateRecord(tableName, recordId) {
  const response = await fetch(`${API_URL}/data/${tableName}`, {
    headers: { 'Authorization': `Bearer ${getToken()}` }
  });

  if (!response.ok) return;

  const data = await response.json();
  const record = data.find(r => String(r.id) === String(recordId));
  if (!record) return;

  currentModalTable = tableName;
  currentModalRecordId = null; // null => al salvataggio esegue POST (crea un nuovo record)

  // Stesse colonne dell'edit, escluse quelle di sistema e le generate
  const hiddenColumns = ['id', 'created_by', 'created_at', 'updated_at'];
  const meta = await fetchColumnsMeta(tableName);
  const generated = new Set((meta || []).filter(c => c.generated).map(c => c.name));
  const fkMap = fkMapFromMeta(meta);
  currentModalColumns = Object.keys(record).filter(col => !hiddenColumns.includes(col) && !generated.has(col));

  document.getElementById('modalTitle').textContent = 'Duplica Record';

  const formFields = document.getElementById('formFields');
  let htmlContent = '';

  for (const col of currentModalColumns) {
    htmlContent += await createFormField(col, record[col] || '', fkMap[col]);
  }

  formFields.innerHTML = htmlContent;
  document.getElementById('recordModal').style.display = 'flex';

  // Auto-popola id_roles quando cambia role_id (come nelle altre modali)
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
        const r = await fetch(`${API_URL}/data/roles`, {
          headers: { 'Authorization': `Bearer ${getToken()}` }
        });
        if (r.ok) {
          const roles = await r.json();
          const selectedRole = roles.find(x => x.id == selectedRoleId);
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
// Metadati colonne dal backend: [{ name, generated }]. Funziona anche a tabella vuota.
async function fetchColumnsMeta(tableName) {
  try {
    const res = await fetch(`${API_URL}/data/${tableName}/columns`, {
      headers: { 'Authorization': `Bearer ${getToken()}` }
    });
    if (res.ok) return await res.json();
  } catch (e) { /* fallback gestito dal chiamante */ }
  return null;
}

// Mappa colonna -> tabella referenziata (foreign key), dai metadati.
function fkMapFromMeta(meta) {
  const m = {};
  (meta || []).forEach(c => { if (c.references) m[c.name] = c.references; });
  return m;
}

async function newRecord(tableName) {
  currentModalTable = tableName;
  currentModalRecordId = null;

  const hiddenColumns = ['id', 'created_by', 'created_at', 'updated_at'];
  // Colonne dal backend (valido anche con tabella vuota); escludi sistema e generate.
  const meta = await fetchColumnsMeta(tableName);
  const fkMap = fkMapFromMeta(meta);
  if (meta) {
    currentModalColumns = meta
      .filter(c => !hiddenColumns.includes(c.name) && !c.generated)
      .map(c => c.name);
  } else {
    // Fallback: prima riga di intestazione (la seconda è la riga dei filtri), senza "Azioni"
    const tableHeaders = Array.from(document.querySelectorAll('table thead tr:first-child th'));
    currentModalColumns = tableHeaders.length > 0
      ? tableHeaders.slice(0, -1).map(th => th.textContent.trim())
      : [];
  }

  document.getElementById('modalTitle').textContent = 'New Record';

  const formFields = document.getElementById('formFields');
  let htmlContent = '';

  for (const col of currentModalColumns) {
    htmlContent += await createFormField(col, '', fkMap[col]);
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
