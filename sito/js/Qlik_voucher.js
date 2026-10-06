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
//   passa dall'endpoint dedicato GET /api/settings/feature-flag, che applica
//   sempre tenant_id e user_id del token, anche durante l'impersonificazione.
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
//   1) Click su "Qlik" -> scelta dell'ambito (solo progetti attivi oppure
//      tutto lo storico) e selezione di un file .xlsx dal PC.
//   2) Il file viene letto interamente nel browser (SheetJS) e caricato in una
//      tabella in memoria con la STESSA struttura del file (una colonna per
//      ogni intestazione del foglio) — QlikVoucher.table.
//   3) Il backend legge le commesse (proj_commessa, più commesse per progetto;
//      ele_commesse solo se proj_commessa non esiste) di TUTTO il tenant del
//      login per ricavare, da cod_commessa (+ titolo), la commessa e il suo
//      project_id: chiunque importi il file aggiorna anche i progetti degli
//      altri utenti del tenant. Le righe nuove di proj_componenti sono intestate
//      al proprietario del progetto e portano commessa_id.
//   4) Le righe del file vengono raggruppate per (Email Dipendente, Codice
//      Commessa, Titolo Commessa) sommando "Ore Attivita" (numero decimale,
//      es. 4,50 = 4h30m).
//   5) Per ogni gruppo risolto in una commessa, il backend
//      (POST /api/qlik-voucher/import) aggiorna la riga di proj_componenti con
//      la stessa email, lo stesso project_id e la stessa commessa_id oppure, se
//      non esiste, la crea usando anche "Nome Dipendente"; poi ricalcola le ore
//      di proj_worker per commessa:
//        proj_componenti.time_spent_hh = totale ore del gruppo
//        proj_componenti.time_spent_gg = time_spent_hh / 8
//
// NOTE / LIMITI NOTI
//   - proj_commessa (o ele_commesse) e proj_componenti devono essere tabelle gestite (presenti e
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
        : location.origin + '/api';

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
        lastResult: null,
        scope: 'active',
        mode: 'qlik'    // 'qlik' = file voucher Qlik; 'consuntivi' = template Consuntivi.xlsx
    };
    window.QlikVoucher = QlikVoucher;

    // Importazioni che usano un TEMPLATE fisso (Impostazioni › Caricamenti, campi tipo 21):
    // stesso programma dei voucher Qlik, ma il file deve avere esattamente la struttura del
    // template (nome del foglio, colonne e loro ordine), altrimenti viene rifiutato.
    // Il template si scarica da GET /api/templates/<chiave> (Documentazione/Template).
    const TEMPLATE_IMPORTS = {
        consuntivi: {
            title: 'Importazione Consuntivi',
            sheetName: 'Consuntivi',
            columns: ['Nome Dipendente', 'Codice Commessa', 'Titolo Commessa', 'Codice Articolo', 'Ore Attivita', 'Email Dipendente']
        }
    };

    // Avvio da un campo tipo 21: stessa scelta dell'ambito (attivi/storico) del pulsante Qlik.
    QlikVoucher.startTemplateImport = function (key) {
        if (!TEMPLATE_IMPORTS[key]) { notify('Importazione non prevista: ' + key, 'info'); return; }
        QlikVoucher.mode = key;
        showQlikScopeModal();
    };

    // null se il file rispetta il template, altrimenti il motivo del rifiuto.
    function templateMismatch(workbook, columns, tpl) {
        if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== tpl.sheetName) {
            return `il file deve avere un solo foglio chiamato "${tpl.sheetName}"`;
        }
        const got = columns.slice();
        while (got.length && !got[got.length - 1]) got.pop(); // celle vuote in coda (formattazione)
        const same = got.length === tpl.columns.length && got.every((c, i) => c === tpl.columns[i]);
        return same ? null : `le colonne devono essere, in quest'ordine: ${tpl.columns.join(', ')}`;
    }

    // ==========================================================================
    // VISIBILITÀ DEL PULSANTE (settings.campo = 'Qlik', valore1 = true)
    // L'endpoint dedicato applica sempre tenant_id e user_id del token attivo,
    // senza il bypass amministratore previsto dall'endpoint generico /api/data.
    // ==========================================================================
    async function checkQlikVisibility() {
        const nav = document.getElementById('navQlik');
        if (!nav) return;
        try {
            const params = new URLSearchParams({ argument: 'Integrazioni', campo: 'Qlik' });
            const res = await fetch(`${API_BASE}/settings/feature-flag?${params.toString()}`, {
                headers: authHeaders()
            });
            if (!res.ok) { nav.style.display = 'none'; return; }
            const data = await res.json();
            // Accetta sia il contratto corrente { enabled: boolean } sia quello
            // storico { value: boolean }; normalizza inoltre gli eventuali valori
            // testuali restituiti da versioni precedenti del backend.
            const rawValue = Object.prototype.hasOwnProperty.call(data, 'enabled')
                ? data.enabled
                : data.value;
            const enabled = rawValue === true
                || rawValue === 1
                || ['true', 't', '1'].includes(String(rawValue).trim().toLowerCase());
            nav.style.display = enabled ? '' : 'none';
        } catch (e) {
            nav.style.display = 'none';
        }
    }

    QlikVoucher.refreshNav = checkQlikVisibility;

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

    function openQlikFilePicker(scope) {
        if (typeof XLSX === 'undefined') {
            notify('Libreria di lettura Excel non disponibile (SheetJS non caricato)', 'info');
            return;
        }
        QlikVoucher.scope = scope === 'history' ? 'history' : 'active';
        ensureFileInput().click();
    }

    // Primo passo del pulsante Qlik: quale importazione? Voucher (job di sempre, poi la
    // scelta dell'ambito) oppure MySupport (quesiti di assistenza nella tabella mysupport).
    function showQlikTypeModal() {
        let modal = document.getElementById('qlikTypeModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'qlikTypeModal';
            modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:950; display:flex; align-items:center; justify-content:center;';
            document.body.appendChild(modal);
        }
        modal.innerHTML = `
            <div style="background:white; border-radius:10px; padding:1.5rem; width:480px; max-width:92vw; box-shadow:0 10px 40px rgba(0,0,0,0.25);">
                <h3 style="margin:0 0 0.75rem; color:#1F2937;">Importazione Qlik</h3>
                <p style="margin:0; color:#4B5563; line-height:1.45;">Quale file vuoi caricare?</p>
                <div style="display:flex; flex-direction:column; gap:0.65rem; margin-top:1.15rem;">
                    <button id="qlikTypeVoucher" type="button" style="padding:0.75rem 1rem; text-align:left; background:#3B82F6; color:white; border:none; border-radius:7px; font-weight:600; cursor:pointer;">
                        Voucher <span style="display:block; font-size:0.78rem; font-weight:400; opacity:0.9; margin-top:0.2rem;">Ore attività sulle commesse dei progetti</span>
                    </button>
                    <button id="qlikTypeMySupport" type="button" style="padding:0.75rem 1rem; text-align:left; background:#F3F4F6; color:#1F2937; border:1px solid #D1D5DB; border-radius:7px; font-weight:600; cursor:pointer;">
                        MySupport <span style="display:block; font-size:0.78rem; font-weight:400; color:#6B7280; margin-top:0.2rem;">Quesiti di assistenza dei clienti (campo My Support della scheda cliente)</span>
                    </button>
                </div>
                <div style="display:flex; justify-content:flex-end; margin-top:1rem;">
                    <button id="qlikTypeCancel" type="button" style="padding:0.5rem 0.9rem; background:white; color:#4B5563; border:1px solid #D1D5DB; border-radius:6px; cursor:pointer;">Annulla</button>
                </div>
            </div>`;
        modal.style.display = 'flex';
        const close = () => { modal.style.display = 'none'; };
        document.getElementById('qlikTypeVoucher').onclick = () => { close(); QlikVoucher.mode = 'qlik'; showQlikScopeModal(); };
        document.getElementById('qlikTypeMySupport').onclick = () => { close(); QlikVoucher.mode = 'mysupport'; openQlikFilePicker('active'); };
        document.getElementById('qlikTypeCancel').onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };
    }

    // ==========================================================================
    // MYSUPPORT — colonne del file -> colonne della tabella mysupport
    // ==========================================================================
    const MYSUPPORT_MAPPA = [
        ['Codice Quesito', 'codice_quesito'],
        ['Stato Finale', 'stato_finale'],
        ['Cliente', 'mycliente'],
        ['Procedura', 'procedura'],
        ['Data Apertura', 'data_apertura'],
        ['Data Chiusura', 'data_chiusura'],
        ['Modulo', 'modulo'],
        ['Urgenza', 'urgenza'],
        ['year_TKT', 'year_tkt'],
        ['Operatore', 'operatore']
    ];

    // Data/ora del file -> 'AAAA-MM-GG HH:MM:SS' (ora locale). Excel la passa come numero
    // seriale (giorni dal 30/12/1899) oppure come testo "gg/mm/aaaa hh:mm".
    function excelDataOra(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        const due = (n) => String(n).padStart(2, '0');
        if (typeof raw === 'number' && Number.isFinite(raw)) {
            // Seriale Excel -> ms (UTC "nominale"), arrotondato al secondo: i decimali di Excel
            // darebbero altrimenti 11:55:59 per un orario delle 11:56.
            const ms = Math.round((raw - 25569) * 86400) * 1000;
            const d = new Date(ms);
            return `${d.getUTCFullYear()}-${due(d.getUTCMonth() + 1)}-${due(d.getUTCDate())} ${due(d.getUTCHours())}:${due(d.getUTCMinutes())}:${due(d.getUTCSeconds())}`;
        }
        const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(raw).trim());
        if (m) return `${m[3]}-${due(m[2])}-${due(m[1])} ${due(m[4] || 0)}:${m[5] || '00'}:${m[6] || '00'}`;
        const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(raw).trim());
        if (iso) return `${iso[1]}-${iso[2]}-${iso[3]} ${iso[4] || '00'}:${iso[5] || '00'}:${iso[6] || '00'}`;
        return null;
    }

    async function handleMySupportFile(columns, rows, fileName) {
        const mancanti = MYSUPPORT_MAPPA.filter(([nome]) => !findColumn(columns, nome)).map(([nome]) => nome);
        if (mancanti.length) {
            notify(`Il file MySupport non contiene le colonne: ${mancanti.join(', ')}`, 'info');
            return;
        }
        const colonna = Object.fromEntries(MYSUPPORT_MAPPA.map(([nome, db]) => [db, findColumn(columns, nome)]));
        const righe = rows.map((row) => {
            const out = {};
            MYSUPPORT_MAPPA.forEach(([, db]) => {
                const v = row[colonna[db]];
                out[db] = (db === 'data_apertura' || db === 'data_chiusura') ? excelDataOra(v)
                    : (v === null || v === undefined ? null : String(v).trim());
            });
            return out;
        }).filter((r) => r.codice_quesito);
        if (!righe.length) { notify('Nessuna riga con "Codice Quesito" nel file', 'info'); return; }

        notify(`File letto: ${righe.length} quesiti da importare…`, 'info');
        const CHUNK = 2000;
        const tot = { totale: 0, inserted: 0, updated: 0, unchanged: 0, invalid: 0, nonTrovati: new Map(), ambigui: new Set() };
        for (let i = 0; i < righe.length; i += CHUNK) {
            try {
                const res = await fetch(`${API_BASE}/mysupport/import`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify({ rows: righe.slice(i, i + CHUNK) })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) { notify('Errore durante l\'importazione MySupport: ' + (data.error || res.status), 'info'); return; }
                ['totale', 'inserted', 'updated', 'unchanged', 'invalid'].forEach((k) => { tot[k] += Number(data[k]) || 0; });
                (data.nonTrovati || []).forEach((x) => tot.nonTrovati.set(x.nome, (tot.nonTrovati.get(x.nome) || 0) + x.righe));
                (data.ambigui || []).forEach((x) => tot.ambigui.add(x));
            } catch (e) {
                notify('Errore di connessione durante l\'importazione MySupport', 'info');
                return;
            }
        }
        showMySupportResultModal(tot, fileName);
    }

    function showMySupportResultModal(r, fileName) {
        let modal = document.getElementById('qlikResultModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'qlikResultModal';
            modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:950; display:flex; align-items:center; justify-content:center;';
            document.body.appendChild(modal);
        }
        const nonTrovati = [...r.nonTrovati].sort((a, b) => b[1] - a[1]);
        const scartate = nonTrovati.reduce((t, [, n]) => t + n, 0);
        const nonTrovatiHtml = nonTrovati.length
            ? `<div style="margin-top:0.75rem;"><strong>Clienti del file non abbinati (${nonTrovati.length}, ${scartate} righe non caricate):</strong>
               <div style="max-height:140px; overflow-y:auto; font-size:0.8rem; color:#6B7280; margin-top:0.3rem;">${nonTrovati.map(([nome, n]) => `${esc(nome)} (${n})`).join('<br>')}</div>
               <div style="font-size:0.78rem; color:#6B7280; margin-top:0.3rem;">Per caricarli, scrivi il nome come nel file nel campo <em>My Support</em> della scheda del cliente.</div></div>`
            : '';
        const ambiguiHtml = r.ambigui.size
            ? `<div style="margin-top:0.75rem; color:#B45309;"><strong>Nome My Support presente su più clienti (righe non caricate):</strong>
               <div style="font-size:0.8rem; margin-top:0.3rem;">${[...r.ambigui].map(esc).join('<br>')}</div></div>`
            : '';
        modal.innerHTML = `
            <div style="background:white; border-radius:10px; padding:1.5rem; width:480px; max-width:92vw; max-height:80vh; overflow-y:auto; box-shadow:0 10px 40px rgba(0,0,0,0.25);">
                <h3 style="margin:0 0 0.75rem; color:#1F2937;">Importazione MySupport</h3>
                <p style="margin:0 0 0.45rem; font-size:0.85rem; color:#6B7280;">File: <strong>${esc(fileName || '')}</strong> · ${r.totale} quesiti letti</p>
                <p style="margin:0; font-size:0.95rem;">Quesiti nuovi inseriti: <strong>${r.inserted}</strong></p>
                <p style="margin:0.35rem 0 0; font-size:0.95rem;">Quesiti aggiornati: <strong>${r.updated}</strong></p>
                <p style="margin:0.35rem 0 0; font-size:0.85rem; color:#6B7280;">Già presenti senza variazioni: <strong>${r.unchanged}</strong></p>
                ${r.invalid ? `<p style="margin:0.35rem 0 0; font-size:0.85rem; color:#6B7280;">Righe senza Codice Quesito: <strong>${r.invalid}</strong></p>` : ''}
                ${nonTrovatiHtml}
                ${ambiguiHtml}
                <div style="display:flex; justify-content:flex-end; margin-top:1.25rem;">
                    <button id="qlikResultClose" type="button" style="padding:0.5rem 1rem; background:#3B82F6; color:white; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Chiudi</button>
                </div>
            </div>`;
        modal.style.display = 'flex';
        document.getElementById('qlikResultClose').addEventListener('click', () => { modal.style.display = 'none'; });
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; }, { once: true });
        notify(`Import MySupport completato: ${r.inserted} inseriti, ${r.updated} aggiornati`, (r.inserted + r.updated) > 0 ? 'success' : 'info');
    }

    // Chiede esplicitamente se limitare l'aggiornamento ai progetti attivi
    // (scadenza 31/12/2099) oppure includere anche tutti i progetti storici.
    function showQlikScopeModal() {
        let modal = document.getElementById('qlikScopeModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'qlikScopeModal';
            modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:950; display:flex; align-items:center; justify-content:center;';
            document.body.appendChild(modal);
        }

        modal.innerHTML = `
            <div style="background:white; border-radius:10px; padding:1.5rem; width:480px; max-width:92vw; box-shadow:0 10px 40px rgba(0,0,0,0.25);">
                <h3 style="margin:0 0 0.75rem; color:#1F2937;">${QlikVoucher.mode === 'consuntivi' ? 'Aggiornamento Consuntivi' : 'Aggiornamento Qlik'}</h3>
                <p style="margin:0; color:#4B5563; line-height:1.45;">Quali progetti vuoi aggiornare?</p>
                <div style="display:flex; flex-direction:column; gap:0.65rem; margin-top:1.15rem;">
                    <button id="qlikScopeActive" type="button" style="padding:0.75rem 1rem; text-align:left; background:#3B82F6; color:white; border:none; border-radius:7px; font-weight:600; cursor:pointer;">
                        Attivo <span style="display:block; font-size:0.78rem; font-weight:400; opacity:0.9; margin-top:0.2rem;">Solo progetti con scadenza 31/12/2099</span>
                    </button>
                    <button id="qlikScopeHistory" type="button" style="padding:0.75rem 1rem; text-align:left; background:#F3F4F6; color:#1F2937; border:1px solid #D1D5DB; border-radius:7px; font-weight:600; cursor:pointer;">
                        Tutto lo storico <span style="display:block; font-size:0.78rem; font-weight:400; color:#6B7280; margin-top:0.2rem;">Tutti i progetti, senza filtro sulla scadenza</span>
                    </button>
                </div>
                <div style="display:flex; justify-content:flex-end; margin-top:1rem;">
                    <button id="qlikScopeCancel" type="button" style="padding:0.5rem 0.9rem; background:white; color:#4B5563; border:1px solid #D1D5DB; border-radius:6px; cursor:pointer;">Annulla</button>
                </div>
            </div>`;
        modal.style.display = 'flex';

        const close = () => { modal.style.display = 'none'; };
        document.getElementById('qlikScopeActive').onclick = () => { close(); openQlikFilePicker('active'); };
        document.getElementById('qlikScopeHistory').onclick = () => { close(); openQlikFilePicker('history'); };
        document.getElementById('qlikScopeCancel').onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };
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

        // Import da template (es. Consuntivi): struttura identica al template o niente.
        const tpl = TEMPLATE_IMPORTS[QlikVoucher.mode];
        if (tpl) {
            const why = templateMismatch(workbook, columns, tpl);
            if (why) {
                showTemplateErrorModal(tpl, why);
                return;
            }
        }
        const rows = grid.slice(1).map((cells) => {
            const obj = {};
            columns.forEach((col, idx) => { obj[col] = cells[idx] === undefined ? null : cells[idx]; });
            return obj;
        });

        // Tabella in memoria (equivalente strutturale al file caricato).
        QlikVoucher.table = { columns, rows, fileName: file.name, scope: QlikVoucher.scope };

        // File MySupport: altro programma (tabella mysupport), non i voucher.
        if (QlikVoucher.mode === 'mysupport') {
            await handleMySupportFile(columns, rows, file.name);
            return;
        }

        const colCommessa = findColumn(columns, 'Codice Commessa');
        const colTitoloCommessa = findColumn(columns, 'Titolo Commessa');
        const colEmail = findColumn(columns, 'Email Dipendente');
        const colNomeDipendente = findColumn(columns, 'Nome Dipendente');
        const colCodiceArticolo = findColumn(columns, 'Codice Articolo');
        const colOre = findColumn(columns, 'Ore Attivita');
        if (!colCommessa || !colTitoloCommessa || !colEmail || !colNomeDipendente || !colCodiceArticolo || !colOre) {
            notify('Il file deve contenere le colonne "Codice Commessa", "Titolo Commessa", "Email Dipendente", "Nome Dipendente", "Codice Articolo" e "Ore Attivita"', 'info');
            return;
        }

        // Raggruppa per (Email Dipendente, Codice Commessa, Titolo Commessa)
        // sommando le ore. Il nominativo viene mantenuto per creare l'eventuale
        // componente che non esiste ancora nel progetto.
        const groupsMap = new Map();
        for (const row of rows) {
            const cod = String(row[colCommessa] == null ? '' : row[colCommessa]).trim();
            const titolo = String(row[colTitoloCommessa] == null ? '' : row[colTitoloCommessa]).trim();
            const email = String(row[colEmail] == null ? '' : row[colEmail]).trim();
            const nominativo = String(row[colNomeDipendente] == null ? '' : row[colNomeDipendente]).trim();
            const codiceArticolo = String(row[colCodiceArticolo] == null ? '' : row[colCodiceArticolo]).trim();
            if (!cod || !titolo || !email) continue; // riga incompleta, viene ignorata
            const ore = parseOreAttivita(row[colOre]);
            const key = email.toLowerCase() + '\u0001' + cod + '\u0001' + titolo.toLowerCase();
            const current = groupsMap.get(key) || {
                codiceCommessa: cod,
                titoloCommessa: titolo,
                email,
                nominativo,
                codiceArticolo,
                oreTotali: 0
            };
            if (!current.nominativo && nominativo) current.nominativo = nominativo;
            if (!current.codiceArticolo && codiceArticolo) current.codiceArticolo = codiceArticolo;
            current.oreTotali += ore;
            groupsMap.set(key, current);
        }
        const groups = [...groupsMap.values()];
        if (groups.length === 0) {
            notify('Nessuna riga valida trovata nel file (Codice Commessa / Titolo Commessa / Email Dipendente mancanti)', 'info');
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
        let totalUnchanged = 0;
        let totalInserted = 0;
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
                    body: JSON.stringify({ groups: chunk, scope: QlikVoucher.scope })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    notify('Errore durante l\'importazione: ' + (data.error || res.status), 'info');
                    return;
                }
                totalUpdated += Number(data.updated) || 0;
                totalUnchanged += Number(data.unchanged) || 0;
                totalInserted += Number(data.inserted) || 0;
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
            unchanged: totalUnchanged,
            inserted: totalInserted,
            workerUpdated: totalWorkerUpdated,
            totalGroups,
            scope: QlikVoucher.scope,
            notFoundCommessa: [...notFoundCommessa],
            notFoundComponente
        };
        showQlikResultModal(QlikVoucher.lastResult);
    }

    // File diverso dal template: importazione bloccata, con invito a usare l'originale.
    function showTemplateErrorModal(tpl, why) {
        let modal = document.getElementById('qlikTemplateErrorModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'qlikTemplateErrorModal';
            modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:950; display:flex; align-items:center; justify-content:center;';
            document.body.appendChild(modal);
        }
        modal.innerHTML = `
            <div style="background:white; border-radius:10px; padding:1.5rem; width:480px; max-width:92vw; box-shadow:0 10px 40px rgba(0,0,0,0.25);">
                <h3 style="margin:0 0 0.75rem; color:#B91C1C;">File non valido</h3>
                <p style="margin:0; color:#374151; line-height:1.45;">Il file non ha la struttura del template: ${esc(why)}.</p>
                <p style="margin:0.75rem 0 0; color:#374151; line-height:1.45;"><strong>Usa il template originale</strong> (pulsante "Scarica template"), compilalo senza modificare foglio e colonne e importalo di nuovo.</p>
                <div style="display:flex; justify-content:flex-end; margin-top:1.25rem;">
                    <button id="qlikTemplateErrorClose" type="button" style="padding:0.5rem 1rem; background:#3B82F6; color:white; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Chiudi</button>
                </div>
            </div>`;
        modal.style.display = 'flex';
        const close = () => { modal.style.display = 'none'; };
        document.getElementById('qlikTemplateErrorClose').onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };
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
                <h3 style="margin:0 0 0.75rem; color:#1F2937;">${esc((TEMPLATE_IMPORTS[QlikVoucher.mode] || {}).title || 'Importazione Qlik voucher')}</h3>
                <p style="margin:0 0 0.45rem; font-size:0.85rem; color:#6B7280;">Ambito: <strong>${result.scope === 'history' ? 'Tutto lo storico' : 'Solo progetti attivi'}</strong></p>
                <p style="margin:0; font-size:0.95rem;">Righe aggiornate: <strong>${result.updated}</strong> di ${result.totalGroups} gruppi.</p>
                ${result.unchanged ? `<p style="margin:0.35rem 0 0; font-size:0.85rem; color:#6B7280;">Righe già aggiornate (nessuna modifica): <strong>${result.unchanged}</strong></p>` : ''}
                <p style="margin:0.35rem 0 0; font-size:0.85rem; color:#6B7280;">Nuovi componenti inseriti: <strong>${result.inserted}</strong></p>
                <p style="margin:0.35rem 0 0; font-size:0.85rem; color:#6B7280;">Righe proj_worker con ore cambiate: <strong>${result.workerUpdated}</strong></p>
                ${notFoundCommessaHtml}
                ${notFoundComponenteHtml}
                <div style="display:flex; justify-content:flex-end; margin-top:1.25rem;">
                    <button id="qlikResultClose" type="button" style="padding:0.5rem 1rem; background:#3B82F6; color:white; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Chiudi</button>
                </div>
            </div>`;
        modal.style.display = 'flex';
        document.getElementById('qlikResultClose').addEventListener('click', () => { modal.style.display = 'none'; });
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; }, { once: true });

        notify(`Import ${QlikVoucher.mode === 'qlik' ? 'Qlik' : 'Consuntivi'} completato: ${result.updated} aggiornate, ${result.inserted} inserite`, (result.updated + result.inserted) > 0 ? 'success' : 'info');
    }

    // ==========================================================================
    // Init
    // ==========================================================================
    function init() {
        const link = document.getElementById('navQlikLink');
        if (link) {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                // Prima la scelta Voucher / MySupport (vedi showQlikTypeModal).
                showQlikTypeModal();
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
