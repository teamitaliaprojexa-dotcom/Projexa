// ============================================================================
// Qlik_voucher.js
// ----------------------------------------------------------------------------
// Voce di menu "Qlik" nella sidebar (sotto "Jira") + importazione voucher Qlik
// da file Excel. Segue lo stesso pattern di js/jira.js e js/integrazioni.js:
// script caricato in coda a dashboard.html, usa le funzioni/variabili globali
// già definite lì (API_URL, getAuthHeaders, showNotification, escapeHtml,
// decodeJwtPayload).
//
// VISIBILITÀ DEL PULSANTE
//   Il pulsante "Qlik" compare solo se esiste, per il tenant_id/user_id del
//   login corrente, una riga in settings con campo = 'Qlik' e valore1 = true
//   (stessa convenzione già usata per Jira, che usa campo='Jira'). La lettura
//   passa dall'endpoint generico GET /api/data/settings, che isola già i
//   risultati per tenant per i non amministratori.
//
// STEP 1 — Configurazione "Qlik voucher"
//   All'avvio il modulo cerca la riga settings.valore2 = 'Qlik voucher' per
//   ricavarne l'id, poi legge tutte le righe figlie con settings.argument =
//   <id di quella riga>. Questi dati (QlikVoucher.config) sono tenuti
//   disponibili per eventuali estensioni del programma; l'importazione dello
//   STEP 2 non ne dipende, quindi funziona comunque anche se la
//   configurazione non è (ancora) presente.
//
// STEP 2 — Importazione del file Excel
//   1) Click su "Qlik" -> selezione di un file .xlsx dal PC.
//   2) Il file viene letto interamente nel browser (SheetJS) e caricato in una
//      tabella in memoria con la STESSA struttura del file (una colonna per
//      ogni intestazione del foglio) — QlikVoucher.table.
//   3) Vengono lette le righe di ele_commesse (tenant_id/user_id del login)
//      per ricavare, da ele_commesse.cod_commessa, il project_id.
//   4) Le righe del file vengono raggruppate per (Email Dipendente, Codice
//      Commessa) sommando "Ore Attivita" (numero decimale, es. 4,50 = 4h30m).
//   5) Per ogni gruppo risolto in un project_id, il backend
//      (POST /api/qlik-voucher/import) aggiorna la riga di proj_componenti con
//      la stessa email e lo stesso project_id:
//        proj_componenti.time_spent_hh = totale ore del gruppo
//        proj_componenti.time_spent_gg = time_spent_hh / 8
//
// NOTE / LIMITI NOTI
//   - ele_commesse e proj_componenti devono essere tabelle gestite (presenti e
//     attive in table_structures) e possedere le colonne usate qui sotto,
//     altrimenti l'endpoint di import risponde con un errore esplicito.
//   - L'aggiornamento di time_spent_hh SOVRASCRIVE il valore esistente con il
//     totale calcolato dal file (non lo somma al valore già presente). Se
//     serve il comportamento incrementale, va cambiato lato server
//     (POST /api/qlik-voucher/import in server.js).
// ============================================================================

(function () {
    'use strict';

    // ---- Fallback difensivi, nel caso lo script venga caricato da solo -----
    const API_BASE = (typeof API_URL !== 'undefined' && API_URL)
        ? API_URL
        : ((location.hostname === 'localhost' || location.hostname === '127.0.0.1')
            ? location.origin
            : 'https://projexa-4mix.onrender.com') + '/api';

    function authHeaders() {
        if (typeof getAuthHeaders === 'function') return getAuthHeaders();
        const token = localStorage.getItem('authToken');
        return token ? { 'Authorization': `Bearer ${token}` } : {};
    }

    function notify(message, type) {
        if (typeof showNotification === 'function') { showNotification(message, type); return; }
        console.log(`[Qlik][${type}]`, message);
    }

    function esc(value) {
        if (typeof escapeHtml === 'function') return escapeHtml(value);
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Stato del modulo, esposto su window per ispezione/debug e per eventuali
    // estensioni future (STEP 1).
    const QlikVoucher = {
        config: null,   // { rootId, root, fields } — righe figlie di 'Qlik voucher'
        table: null,    // { columns, rows } — ultimo file importato ("insightDB" in memoria)
        lastResult: null
    };
    window.QlikVoucher = QlikVoucher;

    // ==========================================================================
    // VISIBILITÀ DEL PULSANTE (settings.campo = 'Qlik', valore1 = true)
    // Il filtro per query string fa un ILIKE '%Qlik%' sulla colonna campo, quindi
    // può restituire anche righe non pertinenti (es. un campo custom "(*) Qlik xyz"):
    // il confronto esatto viene sempre rifatto lato client dopo la risposta.
    // ==========================================================================
    async function checkQlikVisibility() {
        const nav = document.getElementById('navQlik');
        if (!nav) return;
        try {
            const res = await fetch(`${API_BASE}/data/settings?campo=${encodeURIComponent('Qlik')}`, {
                headers: authHeaders()
            });
            if (!res.ok) { nav.style.display = 'none'; return; }
            const rows = await res.json();
            const enabled = Array.isArray(rows) && rows.some((row) => {
                // I campi custom hanno il prefisso "(*) ": lo togliamo prima del confronto.
                const campo = String(row.campo == null ? '' : row.campo).trim().replace(/^\(\*\)\s*/, '');
                const v1 = row.valore1;
                return campo === 'Qlik' && (v1 === true || v1 === 'true' || v1 === 't' || v1 === 1);
            });
            nav.style.display = enabled ? '' : 'none';
        } catch (e) {
            nav.style.display = 'none';
        }
    }

    // ==========================================================================
    // STEP 1 — Configurazione "Qlik voucher": id del contenitore + righe figlie
    // (settings.argument = id del contenitore). Non blocca l'importazione se
    // assente: viene solo tenuta disponibile in QlikVoucher.config.
    // ==========================================================================
    async function loadQlikVoucherConfig() {
        try {
            const res = await fetch(`${API_BASE}/data/settings?valore2=${encodeURIComponent('Qlik voucher')}`, {
                headers: authHeaders()
            });
            if (!res.ok) return null;
            const rows = await res.json();
            const root = Array.isArray(rows)
                ? rows.find((row) => String(row.valore2 == null ? '' : row.valore2).trim() === 'Qlik voucher')
                : null;
            if (!root || root.id == null) return null;

            const childRes = await fetch(`${API_BASE}/data/settings?argument=${encodeURIComponent(root.id)}`, {
                headers: authHeaders()
            });
            const children = childRes.ok ? await childRes.json() : [];
            const config = { rootId: root.id, root, fields: Array.isArray(children) ? children : [] };
            QlikVoucher.config = config;
            return config;
        } catch (e) {
            return null;
        }
    }

    // ==========================================================================
    // STEP 2 — Selezione file ed elaborazione
    // ==========================================================================
    let fileInput = null;
    function ensureFileInput() {
        if (fileInput) return fileInput;
        fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.xlsx,.xls';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            fileInput.value = ''; // consente di ricaricare lo stesso file una seconda volta
            if (file) handleQlikFile(file);
        });
        document.body.appendChild(fileInput);
        return fileInput;
    }

    function openQlikFilePicker() {
        if (typeof XLSX === 'undefined') {
            notify('Libreria di lettura Excel non disponibile (SheetJS non caricato)', 'info');
            return;
        }
        ensureFileInput().click();
    }

    // Normalizza il nome di un'intestazione colonna (per il confronto case/spazi-insensitive).
    function normalizeHeader(name) {
        return String(name == null ? '' : name).trim().toLowerCase();
    }

    // Trova, tra le intestazioni reali del file, quella che corrisponde al nome atteso.
    function findColumn(columns, expectedName) {
        const target = normalizeHeader(expectedName);
        return columns.find((c) => normalizeHeader(c) === target) || null;
    }

    // "Ore Attivita": numero decimale, in formato italiano con la virgola
    // (es. 4,50 = 4 ore e 30 minuti = 4.5 ore decimali). Il valore può arrivare
    // dal file già come numero (caso più comune) oppure come testo con virgola.
    function parseOreAttivita(raw) {
        if (raw === null || raw === undefined || raw === '') return 0;
        if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
        const text = String(raw).trim();
        if (!text) return 0;
        // Se contiene la virgola la trattiamo come separatore decimale italiano
        // (eventuali punti restano come separatori delle migliaia e vengono rimossi).
        const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
        const n = Number(normalized);
        return Number.isFinite(n) ? n : 0;
    }

    async function handleQlikFile(file) {
        notify('Lettura del file in corso…', 'info');
        let workbook;
        try {
            const buffer = await file.arrayBuffer();
            workbook = XLSX.read(buffer, { type: 'array' });
        } catch (e) {
            notify('File non leggibile: ' + e.message, 'info');
            return;
        }

        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) {
            notify('Il file non contiene fogli leggibili', 'info');
            return;
        }

        // sheet_to_json con header:1 dà array di array (prima riga = intestazioni):
        // da qui costruiamo la struttura della tabella in memoria (colonne = intestazioni
        // del file) e, separatamente, l'elenco di oggetti riga { colonna: valore }.
        const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
        if (!Array.isArray(grid) || grid.length < 2) {
            notify('Il file non contiene righe di dati', 'info');
            return;
        }
        const columns = grid[0].map((h) => String(h == null ? '' : h).trim());
        const rows = grid.slice(1).map((cells) => {
            const obj = {};
            columns.forEach((col, idx) => { obj[col] = cells[idx] === undefined ? null : cells[idx]; });
            return obj;
        });

        // Tabella in memoria (equivalente strutturale al file caricato).
        QlikVoucher.table = { columns, rows, fileName: file.name };

        const colCommessa = findColumn(columns, 'Codice Commessa');
        const colEmail = findColumn(columns, 'Email Dipendente');
        const colOre = findColumn(columns, 'Ore Attivita');
        if (!colCommessa || !colEmail || !colOre) {
            notify('Il file deve contenere le colonne "Codice Commessa", "Email Dipendente" e "Ore Attivita"', 'info');
            return;
        }

        // Raggruppa per (Email Dipendente, Codice Commessa) sommando le ore.
        const groupsMap = new Map();
        for (const row of rows) {
            const cod = String(row[colCommessa] == null ? '' : row[colCommessa]).trim();
            const email = String(row[colEmail] == null ? '' : row[colEmail]).trim();
            if (!cod || !email) continue; // riga incompleta, viene ignorata
            const ore = parseOreAttivita(row[colOre]);
            const key = email.toLowerCase() + '\u0001' + cod;
            const current = groupsMap.get(key) || { codiceCommessa: cod, email, oreTotali: 0 };
            current.oreTotali += ore;
            groupsMap.set(key, current);
        }
        const groups = [...groupsMap.values()];
        if (groups.length === 0) {
            notify('Nessuna riga valida trovata nel file (Codice Commessa / Email Dipendente mancanti)', 'info');
            return;
        }

        notify(`File letto: ${rows.length} righe, ${groups.length} gruppi da importare…`, 'info');
        await sendQlikImport(groups);
    }

    // Invia i gruppi al backend, spezzando in blocchi per non superare il
    // limite dell'endpoint (vedi POST /api/qlik-voucher/import in server.js).
    async function sendQlikImport(groups) {
        const CHUNK_SIZE = 2000;
        let totalUpdated = 0;
        let totalWorkerUpdated = 0;
        let totalGroups = 0;
        const notFoundCommessa = new Set();
        const notFoundComponente = [];

        for (let i = 0; i < groups.length; i += CHUNK_SIZE) {
            const chunk = groups.slice(i, i + CHUNK_SIZE);
            try {
                const res = await fetch(`${API_BASE}/qlik-voucher/import`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify({ groups: chunk })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    notify('Errore durante l\'importazione: ' + (data.error || res.status), 'info');
                    return;
                }
                totalUpdated += Number(data.updated) || 0;
                // Il ricalcolo di proj_worker è per progetto (somma TUTTE le righe di
                // proj_componenti di quel progetto): se lo stesso progetto ricorre in più
                // blocchi viene ricalcolato più volte, quindi questo totale può contare la
                // stessa riga proj_worker più di una volta. È solo un dato informativo nel
                // riepilogo, il risultato finale nel database resta comunque corretto.
                totalWorkerUpdated += Number(data.workerUpdated) || 0;
                totalGroups += Number(data.totalGroups) || chunk.length;
                (data.notFoundCommessa || []).forEach((c) => notFoundCommessa.add(c));
                (data.notFoundComponente || []).forEach((c) => notFoundComponente.push(c));
            } catch (e) {
                notify('Errore di connessione durante l\'importazione', 'info');
                return;
            }
        }

        QlikVoucher.lastResult = {
            updated: totalUpdated,
            workerUpdated: totalWorkerUpdated,
            totalGroups,
            notFoundCommessa: [...notFoundCommessa],
            notFoundComponente
        };
        showQlikResultModal(QlikVoucher.lastResult);
    }

    // ==========================================================================
    // Riepilogo import: piccola modale, sullo stile delle altre della dashboard.
    // ==========================================================================
    function showQlikResultModal(result) {
        let modal = document.getElementById('qlikResultModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'qlikResultModal';
            modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:950; display:flex; align-items:center; justify-content:center;';
            document.body.appendChild(modal);
        }

        const notFoundCommessaHtml = result.notFoundCommessa.length
            ? `<div style="margin-top:0.75rem;"><strong>Codici commessa non trovati (${result.notFoundCommessa.length}):</strong>
               <div style="max-height:100px; overflow-y:auto; font-size:0.8rem; color:#6B7280; margin-top:0.3rem;">${result.notFoundCommessa.map(esc).join(', ')}</div></div>`
            : '';
        const notFoundComponenteHtml = result.notFoundComponente.length
            ? `<div style="margin-top:0.75rem;"><strong>Righe proj_componenti non trovate (${result.notFoundComponente.length}):</strong>
               <div style="max-height:140px; overflow-y:auto; font-size:0.8rem; color:#6B7280; margin-top:0.3rem;">${result.notFoundComponente.map(c => {
                   const base = esc(c.codiceCommessa) + ' — ' + esc(c.email);
                   return c.error ? (base + ' <span style="color:#B91C1C;">(' + esc(c.error) + ')</span>') : base;
               }).join('<br>')}</div></div>`
            : '';

        modal.innerHTML = `
            <div style="background:white; border-radius:10px; padding:1.5rem; width:460px; max-width:92vw; max-height:80vh; overflow-y:auto; box-shadow:0 10px 40px rgba(0,0,0,0.25);">
                <h3 style="margin:0 0 0.75rem; color:#1F2937;">Importazione Qlik voucher</h3>
                <p style="margin:0; font-size:0.95rem;">Righe aggiornate: <strong>${result.updated}</strong> di ${result.totalGroups} gruppi.</p>
                <p style="margin:0.35rem 0 0; font-size:0.85rem; color:#6B7280;">Righe proj_worker ricalcolate: <strong>${result.workerUpdated}</strong></p>
                ${notFoundCommessaHtml}
                ${notFoundComponenteHtml}
                <div style="display:flex; justify-content:flex-end; margin-top:1.25rem;">
                    <button id="qlikResultClose" type="button" style="padding:0.5rem 1rem; background:#3B82F6; color:white; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Chiudi</button>
                </div>
            </div>`;
        modal.style.display = 'flex';
        document.getElementById('qlikResultClose').addEventListener('click', () => { modal.style.display = 'none'; });
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; }, { once: true });

        notify(`Import Qlik completato: ${result.updated}/${result.totalGroups} righe aggiornate`, result.updated > 0 ? 'success' : 'info');
    }

    // ==========================================================================
    // Init
    // ==========================================================================
    function init() {
        const link = document.getElementById('navQlikLink');
        if (link) {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                openQlikFilePicker();
            });
        }
        checkQlikVisibility();
        loadQlikVoucherConfig();
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init);
    } else {
        // Se lo script viene (ri)caricato dopo il parsing del DOM, inizializza subito.
        init();
    }
})();
