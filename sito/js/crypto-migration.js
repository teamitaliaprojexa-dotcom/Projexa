// ============================================================================
// MIGRAZIONE CRYPTO (database-viewer)
// ----------------------------------------------------------------------------
// Finestra per cifrare/decifrare i dati già presenti su UNA tabella alla volta:
//   1) si sceglie il database (Projexa, Projexa-Auth, Projexa-Lic, Projexa-Notif)
//   2) si sceglie la tabella
//   3) compaiono i pulsanti "Crypta" e "Decripta"
//
// Il database viaggia come parametro `db` (non con l'header X-Target-DB): così si
// può migrare un ambiente diverso da quello che si sta guardando nella pagina.
// Endpoint: /api/crypto/* (riservati agli amministratori).
// ============================================================================

function cryptoAuthHeaders() {
  return { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` };
}

function cryptoEsc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cryptoBox(color, bg, html) {
  return `<div style="border-left: 4px solid ${color}; background: ${bg}; padding: 10px 12px; border-radius: 4px; font-size: 0.9rem; line-height: 1.5;">${html}</div>`;
}

function openCryptoMigration() {
  document.getElementById('cryptoModal').style.display = 'flex';
  document.getElementById('cryptoResult').innerHTML = '';
  const dbSel = document.getElementById('cryptoDb');
  const tableSel = document.getElementById('cryptoTable');

  if (!dbSel.dataset.bound) {
    dbSel.addEventListener('change', () => loadCryptoTables());
    tableSel.addEventListener('change', () => loadCryptoTableInfo());
    dbSel.dataset.bound = '1';
    // Parte dall'ambiente selezionato nella pagina, se compatibile.
    if (window.__TARGET_DB) dbSel.value = window.__TARGET_DB;
  }
  loadCryptoTables();
}

function closeCryptoMigration() {
  document.getElementById('cryptoModal').style.display = 'none';
}

// Elenco delle tabelle del database scelto. Le tabelle senza colonna "crypto"
// restano selezionabili ma vengono segnalate: non possono essere migrate.
async function loadCryptoTables() {
  const db = document.getElementById('cryptoDb').value;
  const tableSel = document.getElementById('cryptoTable');
  const info = document.getElementById('cryptoInfo');

  tableSel.innerHTML = '<option value="">-- Caricamento… --</option>';
  info.innerHTML = '';
  document.getElementById('cryptoResult').innerHTML = '';
  document.getElementById('cryptoEncryptBtn').style.display = 'none';
  document.getElementById('cryptoDecryptBtn').style.display = 'none';

  try {
    const res = await fetch(`${API_URL}/crypto/tables?db=${encodeURIComponent(db)}`, { headers: cryptoAuthHeaders() });
    const data = await res.json();
    if (!res.ok) {
      tableSel.innerHTML = '<option value="">-- Errore --</option>';
      info.innerHTML = cryptoBox('#DC2626', '#FEF2F2', cryptoEsc(data.error || res.status));
      return;
    }
    const options = data.tables
      .map(t => `<option value="${cryptoEsc(t.name)}">${cryptoEsc(t.name)}${t.hasCrypto ? '' : '  (senza colonna crypto)'}</option>`)
      .join('');
    tableSel.innerHTML = '<option value="">-- Seleziona una tabella --</option>' + options;
  } catch (e) {
    tableSel.innerHTML = '<option value="">-- Errore --</option>';
    info.innerHTML = cryptoBox('#DC2626', '#FEF2F2', 'Errore di connessione: ' + cryptoEsc(e.message));
  }
}

// Anteprima: colonne coinvolte, righe marcate crypto = 1, valori già cifrati.
async function loadCryptoTableInfo(keepResult = false) {
  const db = document.getElementById('cryptoDb').value;
  const table = document.getElementById('cryptoTable').value;
  const info = document.getElementById('cryptoInfo');
  const encBtn = document.getElementById('cryptoEncryptBtn');
  const decBtn = document.getElementById('cryptoDecryptBtn');

  if (!keepResult) document.getElementById('cryptoResult').innerHTML = '';
  encBtn.style.display = 'none';
  decBtn.style.display = 'none';
  if (!table) { info.innerHTML = ''; return; }

  info.innerHTML = '<p class="loading">Analisi della tabella…</p>';

  try {
    const res = await fetch(
      `${API_URL}/crypto/table-info?db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`,
      { headers: cryptoAuthHeaders() }
    );
    const d = await res.json();
    if (!res.ok) {
      info.innerHTML = cryptoBox('#DC2626', '#FEF2F2', cryptoEsc(d.error || res.status));
      return;
    }

    const notes = [];
    if (!d.hasKey) {
      notes.push(cryptoBox('#DC2626', '#FEF2F2',
        '<strong>ENCRYPTION_KEY non impostata.</strong> Configurala nel file .env (locale) e ' +
        'nelle variabili d\'ambiente su Render, poi riavvia il servizio.'));
    }
    if (!d.hasCryptoColumn) {
      notes.push(cryptoBox('#DC2626', '#FEF2F2',
        `La tabella <strong>${cryptoEsc(d.table)}</strong> non ha la colonna <code>crypto</code>: ` +
        'non può essere migrata. Aggiungila con lo script <code>Supporto/CreaDB/crypto_migrazione.sql</code>.'));
    } else if (d.encryptColumns.length === 0) {
      notes.push(cryptoBox('#F59E0B', '#FFFBEB',
        'Nessuna colonna di questa tabella è cifrabile secondo la regola.'));
    }

    const skippedHtml = (d.skipped || []).length
      ? `<div style="margin-top: 8px; color: var(--gray-600); font-size: 0.85rem;">
           <strong>Colonne escluse:</strong> ${(d.skipped || []).map(s => `${cryptoEsc(s.column)} <em>(${cryptoEsc(s.reason)})</em>`).join(', ')}
         </div>`
      : '';

    info.innerHTML = notes.join('') + `
      <div style="border: 1px solid var(--gray-200); border-radius: 4px; padding: 12px; margin-top: ${notes.length ? '10px' : '0'};">
        <div><strong>Database:</strong> ${cryptoEsc(d.label)} &nbsp;·&nbsp; <strong>Tabella:</strong> ${cryptoEsc(d.table)}</div>
        <div style="margin-top: 6px;"><strong>Colonne che verranno cifrate:</strong>
          ${d.encryptColumns.length ? d.encryptColumns.map(c => `<code>${cryptoEsc(c)}</code>`).join(', ') : '<em>nessuna</em>'}
        </div>
        <div style="margin-top: 6px;">
          Righe totali: <strong>${d.rowsTotal}</strong> ·
          con crypto = 1: <strong>${d.rowsCrypto}</strong>
        </div>
        <div style="margin-top: 6px;">
          Valori già cifrati: <strong>${d.valuesEncrypted}</strong> ·
          ancora in chiaro: <strong>${d.valuesPlain}</strong>
        </div>
        ${skippedHtml}
      </div>`;

    if (d.hasKey && d.hasCryptoColumn) {
      encBtn.style.display = d.encryptColumns.length ? 'inline-block' : 'none';
      decBtn.style.display = 'inline-block';
    }
  } catch (e) {
    info.innerHTML = cryptoBox('#DC2626', '#FEF2F2', 'Errore di connessione: ' + cryptoEsc(e.message));
  }
}

// Esecuzione: una transazione lato server, con conferma esplicita dell'utente.
async function runCryptoMigration(mode) {
  const db = document.getElementById('cryptoDb').value;
  const table = document.getElementById('cryptoTable').value;
  if (!table) return;

  const message = mode === 'encrypt'
    ? `CIFRARE i dati della tabella "${table}"?\n\nVengono modificate solo le righe con crypto = 1.\nA video i dati resteranno leggibili.`
    : `Riportare IN CHIARO i dati della tabella "${table}"?\n\n` +
      'Nota: le righe restano marcate crypto = 1, quindi al primo salvataggio\n' +
      'dall\'applicazione verranno cifrate di nuovo. Per lasciarle stabilmente in\n' +
      'chiaro imposta prima crypto = 0 su quelle righe.';
  if (!confirm(message)) return;

  const result = document.getElementById('cryptoResult');
  const encBtn = document.getElementById('cryptoEncryptBtn');
  const decBtn = document.getElementById('cryptoDecryptBtn');
  encBtn.disabled = true;
  decBtn.disabled = true;
  result.innerHTML = '<p class="loading">Elaborazione in corso…</p>';

  try {
    const res = await fetch(`${API_URL}/crypto/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cryptoAuthHeaders() },
      body: JSON.stringify({ db, table })
    });
    const d = await res.json();
    if (!res.ok) {
      result.innerHTML = cryptoBox('#DC2626', '#FEF2F2', '<strong>Operazione annullata.</strong><br>' + cryptoEsc(d.error || res.status));
      return;
    }
    result.innerHTML = cryptoBox('#10B981', '#ECFDF5',
      `<strong>${mode === 'encrypt' ? 'Cifratura' : 'Decifratura'} completata</strong> su ${cryptoEsc(d.table)}.<br>` +
      `Righe esaminate: ${d.rowsScanned} · righe modificate: ${d.rowsChanged} · valori modificati: ${d.valuesChanged}`);
    await loadCryptoTableInfo(true);
    // Ricarica i dati mostrati nella pagina: devono restare leggibili.
    if (typeof currentTable !== 'undefined' && currentTable && currentTable.table_name) {
      loadTableData(currentTable.table_name);
    }
  } catch (e) {
    result.innerHTML = cryptoBox('#DC2626', '#FEF2F2', 'Errore di connessione: ' + cryptoEsc(e.message));
  } finally {
    encBtn.disabled = false;
    decBtn.disabled = false;
  }
}
