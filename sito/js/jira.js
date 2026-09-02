// === INTEGRAZIONE JIRA (SOLA LETTURA) — UI ===
//
// La voce "Jira" nella sidebar compare solo se il flag booleano in settings
// (campo = 'Jira', valore1 = true) è attivo per l'utente/tenant del login.
// Il pulsante apre un flyout a tutto schermo con:
//   - il menu a tendina dei filtri salvati dell'utente su Jira;
//   - la griglia dei risultati del filtro (100 righe per pagina, scorrimento
//     orizzontale e verticale, ordinamento e filtri per colonna).
//
// Tutti i dati arrivano dal backend (/api/jira/*), che parla con Jira Cloud con
// token di sola lettura conservati su Projexa-Auth (tabella integr_tok_auth).
(function () {
    'use strict';

    const API_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? location.origin
        : 'https://projexa-4mix.onrender.com') + '/api';

    function authHeaders(extra) {
        const token = localStorage.getItem('authToken');
        return Object.assign({}, extra || {}, token ? { Authorization: 'Bearer ' + token } : {});
    }

    // Stato della vista corrente.
    const state = {
        status: null,
        filters: [],
        filterId: '',
        filterName: '',
        columns: [],
        rows: [],
        pageTokens: [null],   // token di paginazione Jira: indice = numero di pagina
        page: 0,
        approxTotal: null,
        pageSize: 100,        // righe per pagina (deciso dal backend)
        hasNext: false,
        search: '',           // ricerca testuale: applicata da Jira su tutto il risultato
        sortBy: '',           // ordinamento: applicato da Jira su tutto il risultato
        sortDir: 'ASC',
        localSort: null,      // fallback: ordinamento della sola pagina caricata
        colFilters: {},       // filtri per colonna: applicati alla pagina caricata
        loading: false
    };

    let el = {}; // riferimenti agli elementi del flyout

    // ==========================================
    // STILI
    // ==========================================

    function injectStyles() {
        if (document.getElementById('jiraStyles')) return;
        const style = document.createElement('style');
        style.id = 'jiraStyles';
        style.textContent = `
        .jira-flyout { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; z-index: 700;
            display: none; flex-direction: column; background: #fff; }
        .jira-flyout.open { display: flex; }
        .jira-topbar { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
            padding: 0.7rem 1rem; border-bottom: 1px solid var(--border, #E5E7EB); background: #fff; }
        .jira-title { display: flex; align-items: center; gap: 0.5rem; font-weight: 600;
            color: var(--dark, #1F2937); }
        .jira-title i { color: #2684FF; font-size: 1.2rem; }
        .jira-topbar select, .jira-topbar input[type="text"] {
            padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font-size: 0.85rem;
            font-family: inherit; background: #fff; color: #1F2937; }
        .jira-topbar select { min-width: 240px; max-width: 420px; }
        .jira-topbar input[type="text"] { min-width: 220px; }
        .jira-btn { padding: 6px 12px; border: none; border-radius: 6px; font-size: 0.82rem;
            font-weight: 600; cursor: pointer; font-family: inherit; }
        .jira-btn-primary { background: #2684FF; color: #fff; }
        .jira-btn-plain { background: #E5E7EB; color: #374151; }
        .jira-btn-danger { background: #FEE2E2; color: #B91C1C; }
        .jira-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .jira-spacer { flex: 1 1 auto; }
        .jira-account { font-size: 0.78rem; color: #6B7280; white-space: nowrap; }
        .jira-body { flex: 1 1 auto; overflow: auto; position: relative; }
        .jira-msg { padding: 2rem; color: #6B7280; font-size: 0.9rem; }
        .jira-msg strong { color: #1F2937; }
        .jira-msg code { background: #F3F4F6; padding: 1px 5px; border-radius: 4px;
            font-size: 0.82rem; }
        .jira-grid { border-collapse: separate; border-spacing: 0; font-size: 0.82rem;
            white-space: nowrap; min-width: 100%; }
        .jira-grid th, .jira-grid td { border-right: 1px solid #E5E7EB;
            border-bottom: 1px solid #E5E7EB; padding: 5px 10px; text-align: left;
            max-width: 480px; overflow: hidden; text-overflow: ellipsis; }
        .jira-grid thead th { position: sticky; top: 0; z-index: 2; background: #F3F4F6;
            color: #374151; font-weight: 600; cursor: pointer; user-select: none; height: 32px; }
        .jira-grid thead tr.jira-filter-row th { top: 32px; background: #FAFAFA; cursor: default;
            padding: 3px 4px; }
        .jira-grid thead tr.jira-filter-row input { width: 100%; min-width: 90px; padding: 3px 5px;
            border: 1px solid #D1D5DB; border-radius: 4px; font-size: 0.75rem; font-family: inherit; }
        .jira-grid thead th .jira-sort { color: #9CA3AF; margin-left: 5px; font-size: 0.7rem; }
        .jira-grid thead th.sorted .jira-sort { color: #2684FF; }
        .jira-grid tbody tr:nth-child(even) { background: #FAFAFA; }
        .jira-grid tbody tr:hover { background: #EFF6FF; }
        .jira-grid td a { color: #2684FF; text-decoration: none; font-weight: 600; }
        .jira-grid td a:hover { text-decoration: underline; }
        .jira-footer { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 1rem;
            border-top: 1px solid var(--border, #E5E7EB); font-size: 0.8rem; color: #6B7280;
            background: #fff; }
        .jira-note { font-size: 0.75rem; color: #92400E; background: #FEF3C7; padding: 2px 8px;
            border-radius: 4px; }
        `;
        document.head.appendChild(style);
    }

    // ==========================================
    // COSTRUZIONE DEL FLYOUT
    // ==========================================

    function buildFlyout() {
        if (document.getElementById('jiraFlyout')) return;

        const root = document.createElement('div');
        root.className = 'jira-flyout';
        root.id = 'jiraFlyout';
        root.innerHTML = `
            <div class="jira-topbar">
                <div class="jira-title"><i class="fab fa-jira"></i><span>Jira</span></div>
                <select id="jiraFilterSelect" title="I tuoi filtri salvati su Jira"></select>
                <input type="text" id="jiraSearch" placeholder="Cerca nel testo…" title="Ricerca applicata da Jira su tutto il risultato del filtro">
                <button type="button" class="jira-btn jira-btn-plain" id="jiraReload" title="Ricarica"><i class="fas fa-rotate"></i></button>
                <span id="jiraNote"></span>
                <span class="jira-spacer"></span>
                <span class="jira-account" id="jiraAccount"></span>
                <button type="button" class="jira-btn jira-btn-primary" id="jiraConnect">Collega account Jira</button>
                <button type="button" class="jira-btn jira-btn-danger" id="jiraDisconnect">Scollega</button>
                <button type="button" class="jira-btn jira-btn-plain" id="jiraClose" title="Chiudi">✕</button>
            </div>
            <div class="jira-body" id="jiraBody"></div>
            <div class="jira-footer">
                <span id="jiraCount"></span>
                <span class="jira-spacer"></span>
                <button type="button" class="jira-btn jira-btn-plain" id="jiraPrev">‹ Precedenti</button>
                <span id="jiraPage"></span>
                <button type="button" class="jira-btn jira-btn-plain" id="jiraNext">Successive ›</button>
            </div>`;
        document.body.appendChild(root);

        el = {
            root: root,
            filterSelect: root.querySelector('#jiraFilterSelect'),
            search: root.querySelector('#jiraSearch'),
            reload: root.querySelector('#jiraReload'),
            note: root.querySelector('#jiraNote'),
            account: root.querySelector('#jiraAccount'),
            connect: root.querySelector('#jiraConnect'),
            disconnect: root.querySelector('#jiraDisconnect'),
            close: root.querySelector('#jiraClose'),
            body: root.querySelector('#jiraBody'),
            count: root.querySelector('#jiraCount'),
            prev: root.querySelector('#jiraPrev'),
            page: root.querySelector('#jiraPage'),
            next: root.querySelector('#jiraNext')
        };

        el.close.addEventListener('click', close);
        el.connect.addEventListener('click', startOAuth);
        el.disconnect.addEventListener('click', disconnect);
        el.reload.addEventListener('click', function () { loadPage(0); });
        el.filterSelect.addEventListener('change', function () {
            state.filterId = el.filterSelect.value;
            resetQuery();
            if (state.filterId) loadPage(0); else showMessage('Seleziona un filtro salvato.');
        });
        el.search.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            state.search = el.search.value.trim();
            loadPage(0);
        });
        el.prev.addEventListener('click', function () { if (state.page > 0) loadPage(state.page - 1); });
        el.next.addEventListener('click', function () { if (state.hasNext) loadPage(state.page + 1); });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && root.classList.contains('open')) close();
        });
        window.addEventListener('resize', sizeToViewport);
    }

    // Con lo zoom dell'interfaccia (body.style.zoom) gli elementi fissi vengono scalati:
    // dimensioniamo il flyout in pixel reali divisi per lo zoom, così copre esattamente
    // lo schermo come fa la dashboard con sidebar e flyout.
    function sizeToViewport() {
        if (!el.root) return;
        const zoom = parseFloat(document.body.style.zoom) || 1;
        el.root.style.width = Math.round(window.innerWidth / zoom) + 'px';
        el.root.style.height = Math.round(window.innerHeight / zoom) + 'px';
    }

    function resetQuery() {
        state.pageTokens = [null];
        state.page = 0;
        state.approxTotal = null;
        state.hasNext = false;
        state.sortBy = '';
        state.sortDir = 'ASC';
        state.localSort = null;
        state.colFilters = {};
    }

    // ==========================================
    // STATO CONNESSIONE
    // ==========================================

    async function fetchStatus() {
        try {
            const res = await fetch(API_URL + '/jira/status', { headers: authHeaders() });
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            return null;
        }
    }

    function renderConnectionUi() {
        const s = state.status || {};
        const connected = !!s.connected;
        el.connect.style.display = connected ? 'none' : '';
        el.disconnect.style.display = connected ? '' : 'none';
        el.filterSelect.style.display = connected ? '' : 'none';
        el.search.style.display = connected ? '' : 'none';
        el.reload.style.display = connected ? '' : 'none';
        el.account.textContent = connected
            ? (s.email || '') + (s.site_url ? ' · ' + s.site_url.replace(/^https?:\/\//, '') : '')
            : '';
    }

    function showMessage(html) {
        el.body.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'jira-msg';
        div.innerHTML = html;
        el.body.appendChild(div);
        el.count.textContent = '';
        el.page.textContent = '';
        el.prev.disabled = true;
        el.next.disabled = true;
    }

    // ==========================================
    // OAUTH (finestra popup + postMessage dal callback)
    // ==========================================

    async function startOAuth() {
        // Il popup va aperto nel gestore del click, altrimenti il browser lo blocca:
        // lo apriamo vuoto e ci mettiamo dentro l'URL appena il backend lo restituisce.
        const popup = window.open('', 'projexa-jira-oauth', 'width=680,height=780');
        try {
            const res = await fetch(API_URL + '/jira/authorize-url', { headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Errore');
            if (popup) popup.location.href = data.url;
            else window.location.href = data.url; // popup bloccato: si prosegue nella stessa scheda
        } catch (e) {
            if (popup) popup.close();
            showMessage('<strong>Collegamento non riuscito.</strong><br>' + escapeHtml(e.message));
        }
    }

    async function onOAuthMessage(event) {
        if (event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.source !== 'projexa-jira') return;
        if (!data.ok) {
            showMessage('<strong>Collegamento a Jira non riuscito.</strong><br>' + escapeHtml(data.error || ''));
            return;
        }
        state.status = await fetchStatus();
        renderConnectionUi();
        await loadFilters();
    }

    async function disconnect() {
        if (!window.confirm('Scollegare l\'account Jira? I dati di accesso salvati verranno eliminati.')) return;
        try {
            await fetch(API_URL + '/jira/disconnect', { method: 'POST', headers: authHeaders() });
        } catch (e) { /* la UI si aggiorna comunque */ }
        state.status = await fetchStatus();
        state.filters = [];
        state.filterId = '';
        el.filterSelect.innerHTML = '';
        resetQuery();
        renderConnectionUi();
        showMessage('Account scollegato. Collega di nuovo l\'account per consultare i filtri.');
    }

    // ==========================================
    // FILTRI E RISULTATI
    // ==========================================

    async function loadFilters() {
        showMessage('Caricamento dei filtri…');
        try {
            const res = await fetch(API_URL + '/jira/filters', { headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) return handleApiError(data);

            state.filters = data.filters || [];
            el.filterSelect.innerHTML = '';
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = state.filters.length
                ? '— Scegli un filtro salvato —'
                : '— Nessun filtro salvato —';
            el.filterSelect.appendChild(placeholder);
            state.filters.forEach(function (f) {
                const opt = document.createElement('option');
                opt.value = f.id;
                opt.textContent = f.name;
                opt.title = f.jql || '';
                el.filterSelect.appendChild(opt);
            });
            showMessage(state.filters.length
                ? 'Seleziona uno dei tuoi filtri salvati per vedere i risultati.'
                : 'Non risultano filtri salvati sul tuo account Jira.');
        } catch (e) {
            showMessage('<strong>Errore nel caricamento dei filtri.</strong><br>' + escapeHtml(e.message));
        }
    }

    function handleApiError(data) {
        const code = data && data.code;
        if (code === 'JIRA_DISABLED') {
            showMessage('L\'integrazione Jira non è più abilitata nelle impostazioni: i dati di accesso sono stati eliminati.');
            hideNav();
            return;
        }
        if (code === 'JIRA_NOT_CONNECTED' || code === 'JIRA_REAUTH_REQUIRED') {
            state.status = Object.assign({}, state.status, { connected: false });
            renderConnectionUi();
            showMessage('Autorizzazione Jira non più valida: collega di nuovo il tuo account.');
            return;
        }
        showMessage('<strong>Errore Jira.</strong><br>' + escapeHtml((data && data.error) || 'Errore sconosciuto'));
    }

    async function loadPage(pageIndex) {
        if (!state.filterId || state.loading) return;
        state.loading = true;
        el.prev.disabled = true;
        el.next.disabled = true;
        showMessage('Caricamento dei dati…');
        try {
            const res = await fetch(API_URL + '/jira/search', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    filterId: state.filterId,
                    search: state.search,
                    orderBy: state.sortBy,
                    orderDir: state.sortDir,
                    pageToken: state.pageTokens[pageIndex] || null
                })
            });
            const data = await res.json();
            if (!res.ok) return handleApiError(data);

            state.page = pageIndex;
            state.columns = data.columns || [];
            state.rows = data.rows || [];
            state.filterName = data.filterName || '';
            state.pageSize = data.pageSize || 100;
            state.hasNext = !!data.nextPageToken;
            if (data.nextPageToken && state.pageTokens.length === pageIndex + 1) {
                state.pageTokens.push(data.nextPageToken);
            }
            if (typeof data.approxTotal === 'number') state.approxTotal = data.approxTotal;

            // Jira non sa ordinare per quella colonna: si ripiega sull'ordinamento
            // della sola pagina caricata, dicendolo esplicitamente all'utente.
            if (state.sortBy && data.orderApplied === false) {
                state.localSort = { by: state.sortBy, dir: state.sortDir };
                el.note.innerHTML = '<span class="jira-note">Ordinamento applicato solo alla pagina corrente</span>';
            } else {
                state.localSort = null;
                el.note.innerHTML = '';
            }
            renderGrid();
        } catch (e) {
            showMessage('<strong>Errore nel caricamento dei dati.</strong><br>' + escapeHtml(e.message));
        } finally {
            state.loading = false;
        }
    }

    // ==========================================
    // GRIGLIA
    // ==========================================

    // Righe della pagina dopo i filtri per colonna (e l'eventuale ordinamento locale).
    function visibleRows() {
        const active = Object.keys(state.colFilters).filter(function (k) { return state.colFilters[k]; });
        let rows = state.rows;
        if (active.length) {
            rows = rows.filter(function (row) {
                return active.every(function (k) {
                    return String(row[k] || '').toLowerCase().indexOf(state.colFilters[k].toLowerCase()) !== -1;
                });
            });
        }
        if (state.localSort) {
            const by = state.localSort.by;
            const sign = state.localSort.dir === 'DESC' ? -1 : 1;
            rows = rows.slice().sort(function (a, b) {
                return String(a[by] || '').localeCompare(String(b[by] || ''), 'it', { numeric: true }) * sign;
            });
        }
        return rows;
    }

    function renderGrid() {
        el.body.innerHTML = '';
        if (!state.columns.length) {
            showMessage('Nessuna colonna configurata per questo filtro.');
            return;
        }

        const table = document.createElement('table');
        table.className = 'jira-grid';

        // Intestazioni: clic per ordinare (Jira ordina l'intero risultato, non solo la pagina).
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        state.columns.forEach(function (col) {
            const th = document.createElement('th');
            th.textContent = col.label;
            th.title = 'Ordina per ' + col.label;
            if (state.sortBy === col.value) th.classList.add('sorted');
            const arrow = document.createElement('span');
            arrow.className = 'jira-sort';
            arrow.textContent = state.sortBy === col.value ? (state.sortDir === 'ASC' ? '▲' : '▼') : '↕';
            th.appendChild(arrow);
            th.addEventListener('click', function () { toggleSort(col.value); });
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);

        // Seconda riga di intestazione: filtri per colonna sulla pagina caricata.
        const filterRow = document.createElement('tr');
        filterRow.className = 'jira-filter-row';
        state.columns.forEach(function (col) {
            const th = document.createElement('th');
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'Filtra…';
            input.value = state.colFilters[col.value] || '';
            input.addEventListener('input', function () {
                state.colFilters[col.value] = input.value.trim();
                renderBody(table);
                updateFooter();
            });
            th.appendChild(input);
            filterRow.appendChild(th);
        });
        thead.appendChild(filterRow);
        table.appendChild(thead);
        table.appendChild(document.createElement('tbody'));

        el.body.appendChild(table);
        renderBody(table);
        updateFooter();
    }

    function renderBody(table) {
        const tbody = table.querySelector('tbody');
        tbody.innerHTML = '';
        const rows = visibleRows();
        if (!rows.length) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = state.columns.length;
            td.textContent = 'Nessuna riga da mostrare.';
            td.style.color = '#6B7280';
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
        }
        rows.forEach(function (row) {
            const tr = document.createElement('tr');
            state.columns.forEach(function (col) {
                const td = document.createElement('td');
                const value = row[col.value] == null ? '' : String(row[col.value]);
                // La chiave dell'issue diventa un link al ticket su Jira (nuova scheda).
                if (col.value === 'issuekey' && row._url) {
                    const a = document.createElement('a');
                    a.href = row._url;
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    a.textContent = value;
                    td.appendChild(a);
                } else {
                    td.textContent = value; // testo grezzo: nessun HTML da Jira viene interpretato
                    td.title = value;
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
    }

    function updateFooter() {
        const shown = visibleRows().length;
        const from = state.rows.length ? state.page * state.pageSize + 1 : 0;
        const to = state.page * state.pageSize + state.rows.length;
        const filtered = shown !== state.rows.length ? ' — ' + shown + ' dopo i filtri di colonna' : '';
        const total = typeof state.approxTotal === 'number' ? ' di circa ' + state.approxTotal : '';
        el.count.textContent = state.rows.length
            ? 'Righe ' + from + '–' + to + total + filtered
            : 'Nessun risultato';
        el.page.textContent = 'Pagina ' + (state.page + 1);
        el.prev.disabled = state.page === 0;
        el.next.disabled = !state.hasNext;
    }

    // Ordinamento: primo clic crescente, secondo decrescente, terzo torna
    // all'ordinamento originale del filtro. Ricarica sempre dalla prima pagina
    // perché l'ordine cambia su tutto il risultato.
    function toggleSort(field) {
        if (state.sortBy !== field) {
            state.sortBy = field;
            state.sortDir = 'ASC';
        } else if (state.sortDir === 'ASC') {
            state.sortDir = 'DESC';
        } else {
            state.sortBy = '';
            state.sortDir = 'ASC';
        }
        state.pageTokens = [null];
        state.hasNext = false;
        loadPage(0);
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML;
    }

    // ==========================================
    // APERTURA / CHIUSURA
    // ==========================================

    async function open() {
        buildFlyout();
        el.root.classList.add('open');
        sizeToViewport();
        el.note.innerHTML = '';

        state.status = await fetchStatus();
        if (!state.status || !state.status.enabled) {
            hideNav();
            close();
            return;
        }
        renderConnectionUi();

        if (!state.status.configured) {
            showMessage('<strong>Integrazione non configurata sul server.</strong><br>' +
                'Mancano le variabili d\'ambiente <code>JIRA_CLIENT_ID</code> e <code>JIRA_CLIENT_SECRET</code>.');
            el.connect.style.display = 'none';
            return;
        }
        if (!state.status.connected) {
            showMessage('<strong>Account Jira non collegato.</strong><br>' +
                'Premi «Collega account Jira»: verrà chiesta l\'autorizzazione di sola lettura ' +
                'e i dati di accesso resteranno salvati per gli accessi successivi.');
            return;
        }
        await loadFilters();
    }

    function close() {
        if (el.root) el.root.classList.remove('open');
    }

    function hideNav() {
        const nav = document.getElementById('navJira');
        if (nav) nav.style.display = 'none';
    }

    // Rilegge il flag in settings e mostra/nasconde la voce nella sidebar.
    // La chiama anche la dashboard dopo il salvataggio delle Impostazioni, così
    // attivando o disattivando Jira il pulsante compare/sparisce senza ricaricare.
    async function refreshNav() {
        const nav = document.getElementById('navJira');
        if (!nav) return false;
        const status = await fetchStatus();
        state.status = status;
        const enabled = !!(status && status.enabled);
        nav.style.display = enabled ? '' : 'none';
        if (!enabled) close();
        return enabled;
    }

    // ==========================================
    // AVVIO
    // ==========================================

    async function init() {
        const nav = document.getElementById('navJira');
        if (!nav) return;
        injectStyles();
        window.addEventListener('message', onOAuthMessage);

        nav.querySelector('a').addEventListener('click', function (e) {
            e.preventDefault();
            open();
        });

        // La voce di menu compare solo con il flag settings 'Jira' attivo.
        await refreshNav();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.ProjexaJira = { open: open, close: close, refreshNav: refreshNav };
})();
