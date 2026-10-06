// issue.js - Gestione delle issue
// La griglia è in sola lettura: la lente all'inizio di ogni riga apre la finestra di
// dettaglio, da cui si modifica o si elimina la issue. "Aggiungi" apre la stessa finestra vuota.

// Stesso helper usato da dashboard.html: legge il JWT salvato al login e lo
// aggiunge come header Authorization. Senza questo, requireAuth sul server
// rifiuta ogni chiamata (401) anche dopo aver aggiunto gli endpoint mancanti.
function getAuthHeaders() {
    const token = localStorage.getItem('authToken');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// Colonne della griglia e della finestra di dettaglio, nell'ordine di visualizzazione
const COLONNE_ISSUE = [
    'data_segnalazione', 'project_id', 'visibilita', 'modulo',
    'richiedente', 'categoria', 'stato', 'priorita', 'descrizione',
    'mysupport', 'tkt_jira', 'owner', 'deadline', 'note',
    'data_chiusura'
];

class IssueManager {
    constructor() {
        this.selectedClientId = null;
        this.issues = [];
        this.detailDraft = null;
        this.userRole = null;
        this.contextUserId = null;
        this.contextTenantId = null;
        this.projectOptions = [];
        this.moduleOptions = [];
        this.requesterOptions = [];
        this.ownerOptions = [];
        this.ownerMe = null;
        this.ownerList = null;
        this.clientLogoUrl = null;

        this.initializeElements();
        this.attachEventListeners();
        this.loadContext();
    }

    initializeElements() {
        this.clientSelect = document.getElementById('clientSelect');
        this.clientInfo = document.getElementById('clientInfo');
        this.clientName = document.getElementById('clientName');
        this.clientEmail = document.getElementById('clientEmail');
        this.toolbar = document.getElementById('toolbar');
        this.gridSection = document.getElementById('gridSection');
        this.dashboardSection = document.getElementById('dashboardSection');
        this.clientLogoImage = document.getElementById('issueClientLogo');
        this.clientLogoPlaceholder = document.getElementById('issueClientLogoPlaceholder');
        this.issueTable = document.getElementById('issueTable');
        this.issueTableBody = document.getElementById('issueTableBody');
        this.loadingSpinner = document.getElementById('loadingSpinner');
        this.noData = document.getElementById('noData');

        // Bottoni
        this.addBtn = document.getElementById('addBtn');

        // Messaggi
        this.errorMessage = document.getElementById('errorMessage');
        this.successMessage = document.getElementById('successMessage');

        // Finestra note (sola lettura dalla griglia)
        this.noteModal = document.getElementById('noteModal');
        this.noteModalTextarea = document.getElementById('noteModalTextarea');
        this.noteModalSave = document.getElementById('noteModalSave');
        this.noteModalClose = document.getElementById('noteModalClose');

        // Finestra di dettaglio della issue (lente): modifica ed eliminazione
        this.issueModal = document.getElementById('issueModal');
        this.issueModalTitle = document.getElementById('issueModalTitle');
        this.issueForm = document.getElementById('issueForm');
        this.issueModalSave = document.getElementById('issueModalSave');
        this.issueModalCancel = document.getElementById('issueModalCancel');
        this.issueModalDelete = document.getElementById('issueModalDelete');
        this.issueModalCloseIssue = document.getElementById('issueModalCloseIssue');
        this.issueModalClose = document.getElementById('issueModalClose');
        this.issueModalReadonly = document.getElementById('issueModalReadonly');

        // KPI
        this.kpiAperti = document.getElementById('kpiAperti');
        this.kpiChiusi = document.getElementById('kpiChiusi');
        this.kpiAlta = document.getElementById('kpiAlta');
        this.kpiMedia = document.getElementById('kpiMedia');
        this.kpiBassa = document.getElementById('kpiBassa');
        this.kpiSospesi = document.getElementById('kpiSospesi');
    }

    attachEventListeners() {
        this.clientSelect.addEventListener('change', () => this.onClientChange());
        this.addBtn.addEventListener('click', () => this.onAddClick());
        this.exportBtn = document.getElementById('exportBtn');
        this.exportBtn.addEventListener('click', () => this.exportExcel());
        // In griglia la nota è solo da leggere: si modifica dalla finestra di dettaglio
        this.noteModalSave.style.display = 'none';
        this.noteModalClose.addEventListener('click', () => this.closeNoteModal());
        this.noteModal.addEventListener('click', (event) => {
            if (event.target === this.noteModal) this.closeNoteModal();
        });
        this.issueModalSave.addEventListener('click', () => this.saveDetail());
        this.issueModalCancel.addEventListener('click', () => this.closeDetail());
        this.issueModalClose.addEventListener('click', () => this.closeDetail());
        this.issueModalDelete.addEventListener('click', () => this.deleteDetail());
        this.issueModalCloseIssue.addEventListener('click', () => this.closeIssueDetail());
        this.issueModal.addEventListener('click', (event) => {
            if (event.target === this.issueModal) this.closeDetail();
        });
        const jiraModal = document.getElementById('jiraModal');
        document.getElementById('jiraModalClose').addEventListener('click', () => this.closeJiraLookup());
        jiraModal.addEventListener('click', (event) => {
            if (event.target === jiraModal) this.closeJiraLookup();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            if (jiraModal.classList.contains('show')) this.closeJiraLookup();
            else if (this.noteModal.classList.contains('show')) this.closeNoteModal();
            else if (this.issueModal.classList.contains('show')) this.closeDetail();
        });
    }

    async loadContext() {
        try {
            const response = await fetch('/api/auth/context', {
                method: 'GET',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }
            });
            if (!response.ok) throw new Error('Errore nel caricamento del contesto');
            const data = await response.json();
            this.contextUserId = data.user_id;
            this.contextTenantId = data.tenant_id;
            this.userRole = data.id_roles;
            await this.loadClients();
        } catch (err) {
            this.showError('Errore nel caricamento del contesto: ' + err.message);
        }
    }

    async loadClients() {
        try {
            const response = await fetch('/api/issue/clients', {
                method: 'GET',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }
            });
            if (!response.ok) throw new Error('Errore nel caricamento dei clienti');
            const clients = await response.json();
            this.populateClientSelect(clients);
        } catch (err) {
            this.showError('Errore nel caricamento dei clienti: ' + err.message);
        }
    }

    populateClientSelect(clients) {
        this.clientSelect.innerHTML = '<option value="">-- Seleziona azienda --</option>';
        clients.forEach(client => {
            const option = document.createElement('option');
            option.value = client.id;
            option.textContent = client.name;
            option.dataset.email = client.email || '';
            this.clientSelect.appendChild(option);
        });
    }

    async onClientChange() {
        this.selectedClientId = this.clientSelect.value;

        if (!this.selectedClientId) {
            this.clearClientLogo();
            this.hideGrid();
            this.hideDashboard();
            return;
        }

        const selectedOption = this.clientSelect.options[this.clientSelect.selectedIndex];
        const clientName = selectedOption.textContent;
        const clientEmail = selectedOption.dataset.email;

        this.clientName.textContent = clientName;
        this.clientEmail.textContent = clientEmail || '';
        this.clientInfo.style.display = 'block';

        this.showDashboard();
        this.showGrid();
        await Promise.all([
            this.loadClientLogo(),
            this.loadIssueOptions(),
            this.loadIssues()
        ]);
        // Gli elenchi contengono UUID come valore e descrizione/nominativo come label:
        // ridisegna la griglia solo dopo che entrambi sono disponibili.
        this.renderTable();
        this.updateKPIs();
    }

    clearClientLogo(message = 'Logo non disponibile') {
        if (this.clientLogoUrl) URL.revokeObjectURL(this.clientLogoUrl);
        this.clientLogoUrl = null;
        this.clientLogoBlob = null;
        if (this.clientLogoImage) {
            this.clientLogoImage.removeAttribute('src');
            this.clientLogoImage.style.display = 'none';
        }
        if (this.clientLogoPlaceholder) {
            this.clientLogoPlaceholder.textContent = message;
            this.clientLogoPlaceholder.style.display = '';
        }
    }

    async loadClientLogo() {
        const clientId = this.selectedClientId;
        if (!clientId) {
            this.clearClientLogo();
            return;
        }
        this.clearClientLogo('Caricamento logo…');
        try {
            const response = await fetch(`/api/client-logos/${encodeURIComponent(clientId)}`, {
                headers: getAuthHeaders()
            });
            if (clientId !== this.selectedClientId) return;
            if (response.status === 404) {
                this.clearClientLogo();
                return;
            }
            if (!response.ok) throw new Error(`Errore HTTP ${response.status}`);
            const blob = await response.blob();
            if (clientId !== this.selectedClientId) return;
            this.clearClientLogo();
            this.clientLogoBlob = blob; // per l'export Excel
            this.clientLogoUrl = URL.createObjectURL(blob);
            if (this.clientLogoImage) {
                this.clientLogoImage.src = this.clientLogoUrl;
                this.clientLogoImage.style.display = 'block';
            }
            if (this.clientLogoPlaceholder) this.clientLogoPlaceholder.style.display = 'none';
        } catch (error) {
            if (clientId === this.selectedClientId) this.clearClientLogo('Logo non disponibile');
            console.warn('[LOGO CLIENTE ISSUE]', error.message);
        }
    }

    async loadIssueOptions() {
        try {
            const requestOptions = {
                method: 'GET',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }
            };
            const [response, projectsResponse] = await Promise.all([
                fetch(`/api/issue/options?client_id=${encodeURIComponent(this.selectedClientId)}`, requestOptions),
                fetch(`/api/projects/list?clientId=${encodeURIComponent(this.selectedClientId)}`, requestOptions)
            ]);
            if (!response.ok || !projectsResponse.ok) {
                throw new Error('Errore nel caricamento degli elenchi');
            }

            const [data, projects] = await Promise.all([
                response.json(),
                projectsResponse.json()
            ]);
            this.projectOptions = Array.isArray(projects)
                ? projects.map(project => ({ value: String(project.id), label: project.name }))
                : [];
            this.moduleOptions = Array.isArray(data.moduli) ? data.moduli : [];
            this.requesterOptions = Array.isArray(data.richiedenti) ? data.richiedenti : [];
            this.ownerOptions = Array.isArray(data.owners) ? data.owners : [];
            this.ownerMe = data.ownerMe || null;
        } catch (err) {
            this.projectOptions = [];
            this.moduleOptions = [];
            this.requesterOptions = [];
            this.ownerOptions = [];
            this.ownerMe = null;
            this.showError('Errore nel caricamento di progetti, moduli e richiedenti: ' + err.message);
        }
    }

    async loadIssues() {
        try {
            this.showLoading();
            const response = await fetch(`/api/issue?client_id=${this.selectedClientId}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }
            });
            if (!response.ok) throw new Error('Errore nel caricamento delle issue');
            const issues = await response.json();
            this.issues = issues.map(issue => ({
                ...issue,
                // Converte anche l'eventuale valore storico "Privata" nella
                // nuova scelta prevista dalla griglia.
                visibilita: String(issue.visibilita || '').toLowerCase() === 'cliente'
                    ? 'Cliente'
                    : 'Interna'
            }));
            this.renderTable();
        } catch (err) {
            this.showError('Errore nel caricamento delle issue: ' + err.message);
            this.showNoData();
        }
    }

    renderTable() {
        if (this.issues.length === 0) {
            this.showNoData();
            return;
        }

        this.hideNoData();
        this.issueTable.style.display = 'table';
        this.loadingSpinner.style.display = 'none';

        // Creare header se vuoto
        if (!document.querySelector('th[data-column]')) {
            this.createTableHeaders();
        }

        this.issueTableBody.innerHTML = '';
        this.issues.forEach((issue, index) => {
            const row = this.createTableRow(issue, index);
            this.issueTableBody.appendChild(row);
        });
    }

    createTableHeaders() {
        const headerRow = document.getElementById('headerRow');
        COLONNE_ISSUE.forEach(col => {
            const th = document.createElement('th');
            th.dataset.column = col;
            th.textContent = this.formatColumnName(col);
            headerRow.appendChild(th);
        });
    }

    formatColumnName(col) {
        const names = {
            'data_segnalazione': 'Data Segnalazione',
            'project_id': 'Project ID',
            'visibilita': 'Visibilità',
            'modulo': 'Modulo',
            'richiedente': 'Richiedente',
            'mysupport': 'MySupport',
            'tkt_jira': 'Ticket Jira',
            'categoria': 'Categoria',
            'stato': 'Stato',
            'priorita': 'Priorità',
            'descrizione': 'Descrizione',
            'owner': 'Owner',
            'deadline': 'Scadenza',
            'note': 'Note',
            'data_chiusura': 'Data chiusura'
        };
        return names[col] || col;
    }

    createTableRow(issue, index) {
        const row = document.createElement('tr');
        row.dataset.id = issue.id;
        row.dataset.index = index;

        // Lente: apre la finestra di dettaglio (modifica / eliminazione)
        const detailTd = document.createElement('td');
        detailTd.className = 'detail-cell';
        const detailBtn = document.createElement('button');
        detailBtn.type = 'button';
        detailBtn.className = 'detail-btn';
        detailBtn.title = 'Apri il dettaglio della issue';
        detailBtn.setAttribute('aria-label', detailBtn.title);
        detailBtn.innerHTML = '<i class="fas fa-search"></i>';
        detailBtn.addEventListener('click', () => this.openDetail(index));
        detailTd.appendChild(detailBtn);
        row.appendChild(detailTd);

        // Colonne dati
        COLONNE_ISSUE.forEach(col => {
            const td = document.createElement('td');
            td.dataset.column = col;
            if (col === 'project_id') {
                td.textContent = this.getProjectLabel(issue[col]);
            } else if (col === 'modulo') {
                td.textContent = this.getLookupLabel(this.moduleOptions, issue[col]);
            } else if (col === 'richiedente') {
                td.textContent = this.getLookupLabel(this.requesterOptions, issue[col]);
            } else if (col === 'owner') {
                td.textContent = this.getOwnerLabel(issue[col]);
            } else if (col === 'note') {
                this.renderNoteCell(td, issue[col], index);
            } else if (col === 'tkt_jira' && String(issue[col] || '').trim()) {
                // Lente: cerca i ticket in Quotazioni e, se non ci sono, nei Task Jira
                const span = document.createElement('span');
                span.textContent = String(issue[col]);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'jira-lookup-btn';
                btn.title = 'Cerca il ticket in Quotazioni e Task Jira';
                btn.setAttribute('aria-label', btn.title);
                btn.innerHTML = '<i class="fas fa-search"></i>';
                btn.addEventListener('click', () => this.openJiraLookup(issue[col]));
                td.classList.add('jira-cell');
                td.append(span, btn);
            } else {
                td.textContent = this.formatCellValue(issue[col], col);
            }
            row.appendChild(td);
        });

        return row;
    }

    formatCellValue(value, column) {
        if (!value) return '';
        if (column.includes('date') || column === 'data_segnalazione' || column === 'deadline' || column === 'data_chiusura') {
            return new Date(value).toLocaleDateString('it-IT');
        }
        if (column === 'descrizione' && value.length > 50) {
            return value.substring(0, 50) + '...';
        }
        return String(value);
    }

    onAddClick() {
        if (!this.canModify()) {
            this.showError('Non hai i permessi per aggiungere issue');
            return;
        }
        this.openDetail(null);
    }

    newIssue() {
        return {
            tenant_id: this.contextTenantId,
            user_id: this.contextUserId,
            client_id: this.selectedClientId,
            data_segnalazione: this.todayIso(),
            project_id: '',
            visibilita: 'Interna',
            modulo: '',
            richiedente: '',
            mysupport: '',
            tkt_jira: '',
            categoria: '',
            stato: 'Aperto',
            priorita: 'Media',
            descrizione: '',
            owner: '',
            deadline: '',
            note: '',
            data_chiusura: null,
            id_roles_write: this.userRole
        };
    }

    // Finestra di dettaglio: index = riga della griglia, null = nuova issue.
    // Si lavora su una copia: la griglia cambia solo dopo il salvataggio.
    openDetail(index) {
        const isNew = index === null;
        this.detailDraft = isNew ? this.newIssue() : { ...this.issues[index] };
        const editable = isNew || this.canModifyRow(this.detailDraft);

        this.issueModalTitle.textContent = isNew ? 'Nuova issue' : 'Dettaglio issue';
        this.renderDetailForm(editable);
        this.issueModalSave.style.display = editable ? 'inline-flex' : 'none';
        this.issueModalDelete.style.display = editable && !isNew ? 'inline-flex' : 'none';
        this.issueModalCloseIssue.style.display =
            editable && !isNew && this.detailDraft.stato !== 'Chiuso' ? 'inline-flex' : 'none';
        this.issueModalReadonly.style.display = editable ? 'none' : 'inline';
        this.issueModalCancel.innerHTML = editable
            ? '<i class="fas fa-times"></i> Annulla'
            : '<i class="fas fa-times"></i> Chiudi';
        this.issueModal.classList.add('show');
        this.issueModal.setAttribute('aria-hidden', 'false');
    }

    closeDetail() {
        this.issueModal.classList.remove('show');
        this.issueModal.setAttribute('aria-hidden', 'true');
        this.detailDraft = null;
        this.issueForm.innerHTML = '';
        if (this.ownerList) this.ownerList.remove();
        this.ownerList = null;
    }

    renderDetailForm(editable) {
        const issue = this.detailDraft;
        const set = col => value => { issue[col] = value; };
        const fixedSelect = (col, values) => {
            const select = document.createElement('select');
            const current = issue[col] || '';
            // Mantiene un eventuale valore storico non più previsto
            if (current && !values.includes(current)) values = [current, ...values];
            if (!current) select.appendChild(new Option('', ''));
            values.forEach(v => select.appendChild(new Option(v, v, false, v === current)));
            select.addEventListener('change', () => set(col)(select.value));
            return select;
        };
        const dateInput = col => {
            const input = document.createElement('input');
            input.type = 'date';
            input.value = issue[col] ? String(issue[col]).split('T')[0] : '';
            input.addEventListener('change', () => set(col)(input.value || null));
            return input;
        };
        const textInput = col => {
            const input = document.createElement('input');
            input.type = 'text';
            input.value = issue[col] || '';
            input.addEventListener('input', () => set(col)(input.value));
            return input;
        };
        const textArea = col => {
            const textarea = document.createElement('textarea');
            textarea.value = issue[col] || '';
            textarea.addEventListener('input', () => set(col)(textarea.value));
            return textarea;
        };

        const campi = {
            data_segnalazione: () => dateInput('data_segnalazione'),
            project_id: () => this.createLookupSelect(this.projectOptions, issue.project_id,
                '-- Seleziona progetto --', set('project_id'), false),
            visibilita: () => fixedSelect('visibilita', ['Interna', 'Cliente']),
            modulo: () => this.createLookupSelect(this.moduleOptions, issue.modulo,
                this.moduleOptions.length ? '-- Seleziona modulo --' : '-- Nessuna licenza: compila «Elenco Licenze» nella scheda del cliente --',
                set('modulo')),
            richiedente: () => this.createLookupSelect(this.requesterOptions, issue.richiedente,
                '-- Seleziona richiedente --', set('richiedente')),
            categoria: () => fixedSelect('categoria', ['Bug', 'Richiesta', 'Configurazione', 'Report', 'Altro']),
            stato: () => {
                const select = fixedSelect('stato', ['Aperto', 'in Lavorazione', 'Chiuso', 'Sospeso']);
                // Stato e data di chiusura vanno insieme: "Chiuso" mette la data di oggi
                // (se manca), qualunque altro stato la svuota.
                select.addEventListener('change', () => {
                    const chiusa = select.value === 'Chiuso';
                    if (chiusa && issue.data_chiusura) return;
                    issue.data_chiusura = chiusa ? this.todayIso() : null;
                    const input = document.getElementById('issueField_data_chiusura');
                    if (input) input.value = issue.data_chiusura || '';
                });
                return select;
            },
            priorita: () => fixedSelect('priorita', ['Alta', 'Media', 'Bassa']),
            descrizione: () => textArea('descrizione'),
            mysupport: () => textInput('mysupport'),
            tkt_jira: () => textInput('tkt_jira'),
            owner: () => this.createOwnerSearch(issue, editable),
            deadline: () => dateInput('deadline'),
            note: () => textArea('note'),
            data_chiusura: () => dateInput('data_chiusura')
        };

        this.issueForm.innerHTML = '';
        COLONNE_ISSUE.forEach(col => {
            const field = document.createElement('div');
            field.className = 'field' + (col === 'descrizione' || col === 'note' ? ' full' : '');
            const control = campi[col]();
            // Owner: il controllo è un contenitore, il campo vero è l'input di ricerca
            const input = control.tagName === 'DIV' ? control.querySelector('input') : control;
            input.id = 'issueField_' + col;
            if (!editable) {
                if (input.tagName === 'SELECT') input.disabled = true;
                else input.readOnly = true;
            }
            const label = document.createElement('label');
            label.htmlFor = input.id;
            label.textContent = this.formatColumnName(col);
            // Accanto a "Owner" il pulsante "me" sceglie il proprio contatto di rubrica
            if (control.meButton) label.append(' ', control.meButton);
            field.append(label, control);
            this.issueForm.appendChild(field);
        });
    }

    async saveDetail() {
        const issue = this.detailDraft;
        if (!issue) return;
        if (issue.id && !this.canModifyRow(issue)) {
            this.showError('Non hai i permessi per modificare questa issue');
            return;
        }
        try {
            this.issueModalSave.disabled = true;
            await this.saveIssue(issue);
            this.closeDetail();
            await this.loadIssues();
            this.updateKPIs();
            this.showSuccess('Issue salvata con successo');
        } catch (err) {
            this.showError('Errore nel salvataggio: ' + err.message);
        } finally {
            this.issueModalSave.disabled = false;
        }
    }

    // Data di oggi (ora locale) nel formato dei campi data: AAAA-MM-GG
    todayIso() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // "Chiudi issue": stato Chiuso + data di chiusura di oggi, salvati subito
    // insieme alle eventuali altre modifiche fatte nella finestra.
    async closeIssueDetail() {
        const issue = this.detailDraft;
        if (!issue || !issue.id) return;
        issue.stato = 'Chiuso';
        if (!issue.data_chiusura) issue.data_chiusura = this.todayIso();
        await this.saveDetail();
    }

    async deleteDetail() {
        const issue = this.detailDraft;
        if (!issue || !issue.id) return;
        if (!this.canModifyRow(issue)) {
            this.showError('Non hai i permessi per eliminare questa issue');
            return;
        }
        if (!confirm('Eliminare questa issue? Questa azione non può essere annullata.')) return;
        try {
            const response = await fetch(`/api/issue/${encodeURIComponent(issue.id)}`, {
                method: 'DELETE',
                headers: getAuthHeaders()
            });
            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.error || `HTTP ${response.status}`);
            }
            this.issues = this.issues.filter(i => i.id !== issue.id);
            this.closeDetail();
            this.renderTable();
            this.updateKPIs();
            this.showSuccess('Issue eliminata con successo');
        } catch (err) {
            this.showError('Errore nell\'eliminazione: ' + err.message);
        }
    }

    // POST per una nuova issue (senza id), PUT per le modifiche
    async saveIssue(issue) {
        const isNew = !issue.id;
        const response = await fetch(isNew ? '/api/issue' : `/api/issue/${issue.id}`, {
            method: isNew ? 'POST' : 'PUT',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify(issue)
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || `Errore nel salvataggio della issue (HTTP ${response.status})`);
        }
    }

    getProjectLabel(projectId) {
        if (!projectId) return '';
        const selected = this.projectOptions.find(option => option.value === String(projectId));
        return selected ? selected.label : 'Progetto non disponibile';
    }

    getLookupLabel(options, value) {
        if (!value) return '';
        const selected = options.find(option => {
            const optionValue = option && typeof option === 'object'
                ? option.value ?? option.id ?? ''
                : option;
            return String(optionValue) === String(value);
        });
        if (!selected) return 'Valore non disponibile';
        return selected && typeof selected === 'object'
            ? String(selected.label ?? selected.name ?? selected.value ?? '')
            : String(selected);
    }

    // Campo Owner: si scrive il nominativo e si sceglie tra i contatti attivi della rubrica
    // (come "Assegnato a" della To-Do), salvando rubrica.id. Testo vuoto = nessun owner;
    // testo che non corrisponde a un contatto = salvato così com'è (owner libero), senza
    // scrivere nulla in rubrica.
    createOwnerSearch(issue, editable) {
        const wrap = document.createElement('div');
        wrap.className = 'owner-search';
        const input = document.createElement('input');
        input.type = 'text';
        input.autocomplete = 'off';
        input.placeholder = 'Scrivi il nominativo…';
        input.value = this.getOwnerLabel(issue.owner);
        wrap.appendChild(input);
        if (!editable) return wrap;

        const options = this.ownerOptions.filter(o => o.attivo);
        const list = document.createElement('div');
        list.className = 'owner-list';
        list.setAttribute('role', 'listbox');
        document.body.appendChild(list);
        this.ownerList = list;
        let selectedText = input.value;
        let active = -1;
        let shown = [];

        const close = () => { list.classList.remove('open'); active = -1; };
        const choose = option => {
            input.value = selectedText = option ? option.label : '';
            issue.owner = option ? option.value : '';
            close();
        };
        const position = () => {
            // La pagina è ridotta con zoom: coordinate dello schermo -> pixel CSS del body
            const z = parseFloat(getComputedStyle(document.body).zoom) || 1;
            const rect = input.getBoundingClientRect();
            list.style.left = (rect.left / z) + 'px';
            list.style.top = (rect.bottom / z + 2) + 'px';
            list.style.width = Math.max(rect.width / z, 240) + 'px';
        };
        const item = (option, index) => {
            const div = document.createElement('div');
            div.className = 'owner-item' + (index === active ? ' active' : '');
            div.setAttribute('role', 'option');
            div.dataset.index = index;
            div.textContent = option.label;
            if (option.email) {
                const small = document.createElement('small');
                small.textContent = option.email;
                div.appendChild(small);
            }
            return div;
        };
        const render = () => {
            const needle = input.value.trim().toLocaleLowerCase('it-IT');
            shown = options.filter(o => !needle || o.label.toLocaleLowerCase('it-IT').includes(needle)).slice(0, 30);
            list.innerHTML = '';
            if (shown.length) {
                shown.forEach((o, i) => list.appendChild(item(o, i)));
            } else {
                const empty = document.createElement('div');
                empty.className = 'owner-empty';
                empty.textContent = (options.length ? 'Nessun contatto trovato' : 'Rubrica vuota')
                    + ': verrà salvato il testo scritto';
                list.appendChild(empty);
            }
            position();
            list.classList.add('open');
        };

        input.addEventListener('focus', render);
        input.addEventListener('input', () => { active = -1; render(); });
        input.addEventListener('keydown', event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!list.classList.contains('open')) render();
                if (!shown.length) return;
                active = (active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
                render();
                list.querySelector('.owner-item.active')?.scrollIntoView({ block: 'nearest' });
            } else if (event.key === 'Enter' && list.classList.contains('open')) {
                event.preventDefault();
                if (active >= 0 && shown[active]) choose(shown[active]);
                else if (shown.length === 1) choose(shown[0]);
            } else if (event.key === 'Enter') {
                event.preventDefault();
                input.blur(); // conferma il testo libero
            } else if (event.key === 'Escape' && list.classList.contains('open')) {
                event.stopPropagation(); // chiude solo l'elenco, non la finestra
                input.value = selectedText;
                close();
            }
        });
        // mousedown (non click): scatta prima che il campo perda il fuoco
        list.addEventListener('mousedown', event => {
            event.preventDefault();
            const el = event.target.closest('.owner-item');
            if (el) choose(shown[Number(el.dataset.index)]);
        });
        // Uscendo dal campo: un testo uguale a un solo nominativo sceglie quel contatto;
        // altrimenti si salva il testo scritto così com'è (owner libero, la rubrica non cambia).
        input.addEventListener('blur', () => {
            if (input.value === selectedText) { close(); return; }
            const typed = input.value.trim();
            const text = typed.toLocaleLowerCase('it-IT');
            const exact = text ? options.filter(o => o.label.toLocaleLowerCase('it-IT') === text) : [];
            if (exact.length === 1) choose(exact[0]);
            else if (!text) choose(null);
            else {
                input.value = selectedText = typed;
                issue.owner = typed;
                close();
            }
        });
        // Scorrendo la finestra l'elenco resterebbe staccato dal campo
        this.issueModal.querySelector('.modal-card').addEventListener('scroll', close);

        const me = document.createElement('button');
        me.type = 'button';
        me.className = 'owner-me';
        me.textContent = 'me';
        me.title = 'Owner = io (contatto di rubrica con la mia email)';
        me.addEventListener('click', event => {
            event.preventDefault();
            const mine = this.ownerOptions.find(o => o.value === this.ownerMe);
            if (mine) choose(mine);
            else this.showError('Il tuo nominativo non è in rubrica: aggiungi un contatto con la tua email');
        });
        wrap.meButton = me;
        return wrap;
    }

    // Owner salvato come id della rubrica; i valori storici (testo libero) si mostrano così come sono
    getOwnerLabel(value) {
        if (!value) return '';
        const found = this.ownerOptions.find(o => o.value === String(value));
        return found ? found.label : String(value);
    }

    createLookupSelect(options, currentValue, placeholder, onChange, preserveCurrent = true) {
        const select = document.createElement('select');
        const values = options.map(option => {
            if (option && typeof option === 'object') {
                return {
                    value: String(option.value ?? option.id ?? ''),
                    label: String(option.label ?? option.name ?? option.value ?? '')
                };
            }
            return { value: String(option), label: String(option) };
        });
        const selectedValue = String(currentValue || '');

        // Mantiene selezionabile un eventuale valore storico non più presente
        // nella tabella di origine.
        if (preserveCurrent && selectedValue && !values.some(option => option.value === selectedValue)) {
            values.unshift({ value: selectedValue, label: selectedValue });
        }

        const emptyOption = document.createElement('option');
        emptyOption.value = '';
        emptyOption.textContent = placeholder;
        select.appendChild(emptyOption);

        values.forEach(item => {
            const option = document.createElement('option');
            option.value = item.value;
            option.textContent = item.label;
            option.selected = item.value === selectedValue;
            select.appendChild(option);
        });

        select.addEventListener('change', () => onChange(select.value));
        return select;
    }

    renderNoteCell(td, note, index) {
        td.innerHTML = '';
        td.classList.add('note-cell');

        if (!String(note || '').trim()) return;

        const flag = document.createElement('i');
        flag.className = 'fas fa-flag note-flag';
        flag.title = 'Nota presente';
        flag.setAttribute('aria-label', 'Nota presente');
        td.appendChild(flag);

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'note-view-btn';
        button.title = 'Visualizza la nota completa';
        button.setAttribute('aria-label', button.title);
        button.innerHTML = '<i class="fas fa-eye"></i>';
        button.addEventListener('click', event => {
            event.stopPropagation();
            this.openNoteModal(index);
        });
        td.appendChild(button);
    }

    // ExcelJS (supporta le immagini, a differenza di SheetJS): caricato solo al primo export
    loadExcelJs() {
        if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
        if (!this.excelJsPromise) {
            this.excelJsPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
                script.onload = () => resolve(window.ExcelJS);
                script.onerror = () => { this.excelJsPromise = null; reject(new Error('libreria Excel non caricata')); };
                document.head.appendChild(script);
            });
        }
        return this.excelJsPromise;
    }

    // Logo del cliente per Excel: { buffer, extension, width, height } oppure null
    // (Excel accetta solo png, jpeg e gif; gli altri formati vengono saltati).
    async logoForExcel() {
        // Il blob è tenuto da loadClientLogo: la CSP non permette fetch() su URL blob:
        const blob = this.clientLogoBlob;
        if (!blob) return null;
        const extension = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/gif': 'gif' }[blob.type];
        if (!extension) return null;
        const img = this.clientLogoImage;
        const ratio = img && img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 16 / 9;
        // Dentro un riquadro 180 x 90 px, proporzioni originali
        const width = Math.min(180, 90 * ratio);
        return { buffer: await blob.arrayBuffer(), extension, width, height: width / ratio };
    }

    // Esporta in Excel: in alto logo, cliente e KPI (come nella pagina), sotto le issue
    // con tutte le colonne e i testi completi (descrizione e note non troncate).
    async exportExcel() {
        if (!this.selectedClientId) return;
        const label = this.exportBtn.innerHTML;
        this.exportBtn.disabled = true;
        this.exportBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Esportazione…';
        try {
            const ExcelJS = await this.loadExcelJs();
            const clientName = this.clientName.textContent || 'Cliente';
            const wb = new ExcelJS.Workbook();
            wb.creator = 'Projexa';
            const ws = wb.addWorksheet('Issue', { views: [{ showGridLines: false }] });
            const blu = 'FF1E40AF';
            const grigio = 'FFF3F4F6';
            const bordo = { style: 'thin', color: { argb: 'FFE5E7EB' } };
            const bordi = { top: bordo, left: bordo, bottom: bordo, right: bordo };

            // --- Intestazione: logo (A1:B5), cliente e data ---
            const logo = await this.logoForExcel().catch(() => null);
            if (logo) {
                const id = wb.addImage({ buffer: logo.buffer, extension: logo.extension });
                ws.addImage(id, { tl: { col: 0.1, row: 0.2 }, ext: { width: logo.width, height: logo.height } });
            }
            ws.getCell('D2').value = `Issue - ${clientName}`;
            ws.getCell('D2').font = { size: 16, bold: true, color: { argb: blu } };
            ws.getCell('D3').value = `Estratto il ${new Date().toLocaleString('it-IT')}`;
            ws.getCell('D3').font = { size: 10, color: { argb: 'FF6B7280' } };

            // --- KPI (righe 7-8), gli stessi della pagina ---
            const kpi = [
                ['Totale issue aperti', this.kpiAperti.textContent],
                ['Issue chiusi', this.kpiChiusi.textContent],
                ['Priorità alta', this.kpiAlta.textContent],
                ['Priorità media', this.kpiMedia.textContent],
                ['Priorità bassa', this.kpiBassa.textContent],
                ['Attività in sospeso', this.kpiSospesi.textContent]
            ];
            kpi.forEach(([nome, valore], i) => {
                const etichetta = ws.getCell(7, i + 1);
                etichetta.value = nome;
                etichetta.font = { size: 9, color: { argb: 'FF6B7280' } };
                const numero = ws.getCell(8, i + 1);
                numero.value = Number(valore) || 0;
                numero.font = { size: 14, bold: true, color: { argb: 'FF3B82F6' } };
                [etichetta, numero].forEach(c => {
                    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: grigio } };
                    c.border = bordi;
                });
            });
            ws.getRow(7).height = 28;
            ws.getRow(8).height = 24;

            // --- Dati (dalla riga 10) ---
            const HEADER_ROW = 10;
            const header = ws.getRow(HEADER_ROW);
            COLONNE_ISSUE.forEach((col, i) => {
                const c = header.getCell(i + 1);
                c.value = this.formatColumnName(col);
                c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: blu } };
                c.alignment = { vertical: 'middle', wrapText: true };
                c.border = bordi;
            });
            header.height = 22;

            const isDate = col => ['data_segnalazione', 'deadline', 'data_chiusura'].includes(col);
            this.issues.forEach((issue, r) => {
                const row = ws.getRow(HEADER_ROW + 1 + r);
                COLONNE_ISSUE.forEach((col, i) => {
                    let v = issue[col];
                    if (col === 'project_id') v = this.getProjectLabel(v);
                    else if (col === 'modulo') v = this.getLookupLabel(this.moduleOptions, v);
                    else if (col === 'richiedente') v = this.getLookupLabel(this.requesterOptions, v);
                    else if (col === 'owner') v = this.getOwnerLabel(v);
                    else if (isDate(col)) {
                        // Data senza ora: mezzanotte UTC, così Excel non la sposta di un giorno
                        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
                        v = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
                    }
                    const c = row.getCell(i + 1);
                    c.value = v === undefined || v === '' ? null : v;
                    if (isDate(col)) c.numFmt = 'dd/mm/yyyy';
                    c.alignment = { vertical: 'top', wrapText: col === 'descrizione' || col === 'note' };
                    c.border = bordi;
                });
            });

            // Larghezze: testi lunghi più larghi
            COLONNE_ISSUE.forEach((col, i) => {
                ws.getColumn(i + 1).width = col === 'descrizione' || col === 'note' ? 50
                    : isDate(col) ? 14 : 18;
            });
            ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: HEADER_ROW, column: COLONNE_ISSUE.length } };
            ws.views = [{ state: 'frozen', ySplit: HEADER_ROW, showGridLines: false }];

            const buffer = await wb.xlsx.writeBuffer();
            const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const a = document.createElement('a');
            const oggi = this.todayIso();
            a.href = URL.createObjectURL(blob);
            a.download = `Issue_${clientName.replace(/[\\/:*?"<>|]+/g, '').trim().replace(/\s+/g, '_')}_${oggi}.xlsx`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        } catch (err) {
            this.showError('Errore nell\'esportazione Excel: ' + err.message);
        } finally {
            this.exportBtn.disabled = false;
            this.exportBtn.innerHTML = label;
        }
    }

    // Finestra "Ticket Jira": per ogni codice scritto nel campo (anche più di uno, es.
    // ADFPE-299/ADFPE-300) i dati trovati in Quotazioni oppure, in mancanza, in Task Jira.
    async openJiraLookup(text) {
        const modal = document.getElementById('jiraModal');
        const body = document.getElementById('jiraModalBody');
        body.innerHTML = '<div class="loading"><div class="spinner"></div><p>Ricerca in corso…</p></div>';
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
        try {
            const response = await fetch(`/api/issue/jira-lookup?codes=${encodeURIComponent(text)}`, {
                headers: getAuthHeaders()
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
            body.innerHTML = '';
            data.forEach(result => body.appendChild(this.renderJiraResult(result)));
        } catch (err) {
            body.innerHTML = '';
            const p = document.createElement('p');
            p.className = 'jira-none';
            p.textContent = 'Errore nella ricerca: ' + err.message;
            body.appendChild(p);
        }
    }

    renderJiraResult(result) {
        const section = document.createElement('section');
        section.className = 'jira-result';
        const h = document.createElement('h4');
        h.textContent = result.codice;
        if (result.fonte) {
            const badge = document.createElement('span');
            badge.className = 'jira-fonte';
            badge.textContent = result.fonte;
            h.append(' ', badge);
        }
        section.appendChild(h);

        if (!result.righe.length) {
            const p = document.createElement('p');
            p.className = 'jira-none';
            p.textContent = 'Nessuna corrispondenza in Quotazioni né in Task Jira';
            section.appendChild(p);
            return section;
        }
        result.righe.forEach(campi => {
            const table = document.createElement('table');
            table.className = 'jira-table';
            campi.forEach(({ campo, valore }) => {
                const tr = document.createElement('tr');
                const th = document.createElement('th');
                th.textContent = campo;
                const td = document.createElement('td');
                if (/^https?:\/\//i.test(valore)) {
                    const a = document.createElement('a');
                    a.href = valore;
                    a.target = '_blank';
                    a.rel = 'noopener';
                    a.textContent = valore;
                    td.appendChild(a);
                } else if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(valore)) {
                    td.textContent = new Date(valore).toLocaleDateString('it-IT');
                } else {
                    td.textContent = valore;
                }
                tr.append(th, td);
                table.appendChild(tr);
            });
            section.appendChild(table);
        });
        return section;
    }

    closeJiraLookup() {
        const modal = document.getElementById('jiraModal');
        modal.classList.remove('show');
        modal.setAttribute('aria-hidden', 'true');
    }

    openNoteModal(index) {
        this.noteModalTextarea.value = this.issues[index].note || '';
        this.noteModalTextarea.readOnly = true;
        this.noteModal.classList.add('show');
        this.noteModal.setAttribute('aria-hidden', 'false');
    }

    closeNoteModal() {
        this.noteModal.classList.remove('show');
        this.noteModal.setAttribute('aria-hidden', 'true');
    }

    updateKPIs() {
        const aperti = this.issues.filter(i => i.stato === 'Aperto').length;
        const chiusi = this.issues.filter(i => i.stato === 'Chiuso').length;
        const alta = this.issues.filter(i => i.priorita === 'Alta').length;
        const media = this.issues.filter(i => i.priorita === 'Media').length;
        const bassa = this.issues.filter(i => i.priorita === 'Bassa').length;
        const sospesi = this.issues.filter(i => i.stato === 'Sospeso').length;

        this.kpiAperti.textContent = aperti;
        this.kpiChiusi.textContent = chiusi;
        this.kpiAlta.textContent = alta;
        this.kpiMedia.textContent = media;
        this.kpiBassa.textContent = bassa;
        this.kpiSospesi.textContent = sospesi;
    }

    canModify() {
        return this.userRole && this.userRole <= 70;
    }

    // Stessa regola del server: modificabile se id_roles_write coincide con il ruolo del
    // contesto (anche più ruoli separati da virgola); l'Admin (1) sempre; vuoto = sola lettura.
    canModifyRow(issue) {
        if (!this.userRole) return false;
        if (Number(this.userRole) === 1) return true;
        return String(issue.id_roles_write == null ? '' : issue.id_roles_write)
            .split(/[;,\s]+/).filter(Boolean).includes(String(Number(this.userRole)));
    }

    showError(message) {
        this.errorMessage.textContent = message;
        this.errorMessage.classList.add('show');
        setTimeout(() => this.errorMessage.classList.remove('show'), 5000);
    }

    showSuccess(message) {
        this.successMessage.textContent = message;
        this.successMessage.classList.add('show');
        setTimeout(() => this.successMessage.classList.remove('show'), 5000);
    }

    showLoading() {
        this.loadingSpinner.style.display = 'block';
        this.issueTable.style.display = 'none';
        this.noData.style.display = 'none';
    }

    showNoData() {
        this.loadingSpinner.style.display = 'none';
        this.issueTable.style.display = 'none';
        this.noData.style.display = 'block';
    }

    hideNoData() {
        this.noData.style.display = 'none';
    }

    hideGrid() {
        this.toolbar.style.display = 'none';
        this.gridSection.style.display = 'none';
        this.issueTableBody.innerHTML = '';
    }

    showGrid() {
        this.toolbar.style.display = 'flex';
        this.gridSection.style.display = 'block';
    }

    hideDashboard() {
        this.dashboardSection.style.display = 'none';
    }

    showDashboard() {
        this.dashboardSection.style.display = 'block';
    }
}

// Inizializza il manager quando il DOM è pronto
document.addEventListener('DOMContentLoaded', () => {
    new IssueManager();
});
