// issue.js - Gestione delle issue

// Stesso helper usato da dashboard.html: legge il JWT salvato al login e lo
// aggiunge come header Authorization. Senza questo, requireAuth sul server
// rifiuta ogni chiamata (401) anche dopo aver aggiunto gli endpoint mancanti.
function getAuthHeaders() {
    const token = localStorage.getItem('authToken');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

class IssueManager {
    constructor() {
        this.selectedClientId = null;
        this.issues = [];
        this.isEditMode = false;
        this.selectedRows = new Set();
        this.modifiedRows = new Map();
        this.userRole = null;
        this.contextUserId = null;
        this.contextTenantId = null;
        
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
        this.issueTable = document.getElementById('issueTable');
        this.issueTableBody = document.getElementById('issueTableBody');
        this.loadingSpinner = document.getElementById('loadingSpinner');
        this.noData = document.getElementById('noData');
        
        // Bottoni
        this.addBtn = document.getElementById('addBtn');
        this.deleteBtn = document.getElementById('deleteBtn');
        this.closeBtn = document.getElementById('closeBtn');
        this.editBtn = document.getElementById('editBtn');
        this.saveBtn = document.getElementById('saveBtn');
        this.cancelBtn = document.getElementById('cancelBtn');
        this.selectAllCheckbox = document.getElementById('selectAllCheckbox');
        
        // Messaggi
        this.errorMessage = document.getElementById('errorMessage');
        this.successMessage = document.getElementById('successMessage');
        
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
        this.deleteBtn.addEventListener('click', () => this.onDeleteClick());
        this.closeBtn.addEventListener('click', () => this.onCloseClick());
        this.editBtn.addEventListener('click', () => this.onEditClick());
        this.saveBtn.addEventListener('click', () => this.onSaveClick());
        this.cancelBtn.addEventListener('click', () => this.onCancelClick());
        this.selectAllCheckbox.addEventListener('change', (e) => this.onSelectAllChange(e));
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
        this.isEditMode = false;
        this.modifiedRows.clear();
        await this.loadIssues();
        this.updateKPIs();
        this.updateToolbarButtons();
    }

    async loadIssues() {
        try {
            this.showLoading();
            const response = await fetch(`/api/issue?client_id=${this.selectedClientId}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }
            });
            if (!response.ok) throw new Error('Errore nel caricamento delle issue');
            this.issues = await response.json();
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
        const colonne = ['data_segnalazione', 'categoria', 'stato', 'priorita', 'descrizione', 'owner', 'deadline', 'note', 'data_chiusura'];
        
        colonne.forEach(col => {
            const th = document.createElement('th');
            th.dataset.column = col;
            th.textContent = this.formatColumnName(col);
            headerRow.appendChild(th);
        });
    }

    formatColumnName(col) {
        const names = {
            'data_segnalazione': 'Data Segnalazione',
            'categoria': 'Categoria',
            'stato': 'Stato',
            'priorita': 'Priorità',
            'descrizione': 'Descrizione',
            'owner': 'Owner',
            'deadline': 'Deadline',
            'note': 'Note',
            'data_chiusura': 'Data Chiusura'
        };
        return names[col] || col;
    }

    createTableRow(issue, index) {
        const row = document.createElement('tr');
        row.dataset.id = issue.id;
        row.dataset.index = index;
        row.dataset.idRolesWrite = issue.id_roles_write;

        // Checkbox
        const checkboxTd = document.createElement('td');
        checkboxTd.className = 'checkbox-cell';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.addEventListener('change', () => this.updateSelectedRows());
        checkboxTd.appendChild(checkbox);
        row.appendChild(checkboxTd);

        // Colonne dati
        const colonne = ['data_segnalazione', 'categoria', 'stato', 'priorita', 'descrizione', 'owner', 'deadline', 'note', 'data_chiusura'];
        colonne.forEach(col => {
            const td = document.createElement('td');
            td.dataset.column = col;
            td.textContent = this.formatCellValue(issue[col], col);
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

        const newIssue = {
            id: 'new-' + Date.now(),
            tenant_id: this.contextTenantId,
            user_id: this.contextUserId,
            client_id: this.selectedClientId,
            data_segnalazione: new Date().toISOString().split('T')[0],
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

        this.issues.unshift(newIssue);
        this.isEditMode = true;
        this.renderTable();
        this.makeRowEditable(0);
        this.updateToolbarButtons();
        this.updateEditableRows();
    }

    onDeleteClick() {
        if (this.selectedRows.size === 0) {
            this.showError('Seleziona almeno una issue da eliminare');
            return;
        }

        const selectedIssues = Array.from(this.selectedRows).map(index => this.issues[index]);
        
        // Verifica permessi
        for (let issue of selectedIssues) {
            if (!this.canModifyRow(issue)) {
                this.showError('Non hai i permessi per eliminare questa issue');
                return;
            }
        }

        if (!confirm(`Eliminare ${this.selectedRows.size} issue? Questa azione non può essere annullata.`)) {
            return;
        }

        this.deleteSelectedIssues(selectedIssues);
    }

    async deleteSelectedIssues(issues) {
        try {
            for (let issue of issues) {
                if (!issue.id.toString().startsWith('new-')) {
                    await fetch(`/api/issue/${issue.id}`, { method: 'DELETE', headers: getAuthHeaders() });
                }
            }
            this.issues = this.issues.filter(i => !issues.some(d => d.id === i.id));
            this.selectedRows.clear();
            this.renderTable();
            this.updateToolbarButtons();
            this.updateKPIs();
            this.showSuccess('Issue eliminate con successo');
        } catch (err) {
            this.showError('Errore nell\'eliminazione: ' + err.message);
        }
    }

    onCloseClick() {
        if (this.selectedRows.size === 0) {
            this.showError('Seleziona almeno una issue da chiudere');
            return;
        }

        const selectedIssues = Array.from(this.selectedRows).map(index => this.issues[index]);
        
        for (let issue of selectedIssues) {
            if (!this.canModifyRow(issue)) {
                this.showError('Non hai i permessi per chiudere questa issue');
                return;
            }
        }

        selectedIssues.forEach(issue => {
            const today = new Date();
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            issue.data_chiusura = yesterday.toISOString().split('T')[0];
        });

        this.saveIssues(selectedIssues);
    }

    onEditClick() {
        if (!this.canModify()) {
            this.showError('Non hai i permessi per modificare issue');
            return;
        }

        this.isEditMode = true;
        this.updateEditableRows();
        this.updateToolbarButtons();
    }

    async onSaveClick() {
        try {
            const rowsToSave = Array.from(this.modifiedRows.keys())
                .map(index => this.issues[index])
                .filter(issue => {
                    if (!this.canModifyRow(issue)) {
                        this.showError('Non hai i permessi per modificare questa issue');
                        return false;
                    }
                    return true;
                });

            await this.saveIssues(rowsToSave);
            
            this.isEditMode = false;
            this.modifiedRows.clear();
            this.renderTable();
            this.updateToolbarButtons();
            this.updateKPIs();
            this.showSuccess('Modifiche salvate con successo');
        } catch (err) {
            this.showError('Errore nel salvataggio: ' + err.message);
        }
    }

    async saveIssues(issues) {
        for (let issue of issues) {
            if (issue.id.toString().startsWith('new-')) {
                // POST per nuove issue
                delete issue.id;
                const response = await fetch('/api/issue', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                    body: JSON.stringify(issue)
                });
                if (!response.ok) throw new Error('Errore nel salvataggio della issue');
                const saved = await response.json();
                Object.assign(issue, saved);
            } else {
                // PUT per modifiche
                const response = await fetch(`/api/issue/${issue.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
                    body: JSON.stringify(issue)
                });
                if (!response.ok) throw new Error('Errore nel salvataggio della issue');
            }
        }
    }

    onCancelClick() {
        this.isEditMode = false;
        this.modifiedRows.clear();
        this.selectedRows.clear();
        this.renderTable();
        this.updateToolbarButtons();
    }

    onSelectAllChange(e) {
        if (e.target.checked) {
            this.selectedRows.clear();
            document.querySelectorAll('tbody tr').forEach((row, index) => {
                if (row.style.display !== 'none') {
                    this.selectedRows.add(index);
                    row.classList.add('selected');
                    row.querySelector('input[type="checkbox"]').checked = true;
                }
            });
        } else {
            this.selectedRows.clear();
            document.querySelectorAll('tbody tr input[type="checkbox"]').forEach(cb => cb.checked = false);
            document.querySelectorAll('tbody tr').forEach(row => row.classList.remove('selected'));
        }
        this.updateToolbarButtons();
    }

    updateSelectedRows() {
        this.selectedRows.clear();
        document.querySelectorAll('tbody tr input[type="checkbox"]:checked').forEach(cb => {
            const row = cb.closest('tr');
            const index = parseInt(row.dataset.index);
            this.selectedRows.add(index);
            row.classList.add('selected');
        });
        this.updateToolbarButtons();
    }

    updateEditableRows() {
        const rows = document.querySelectorAll('tbody tr');
        rows.forEach((row, index) => {
            if (!this.isEditMode) {
                row.classList.remove('editable');
                this.renderRowCells(row, this.issues[index]);
            } else if (this.canModifyRow(this.issues[index])) {
                row.classList.add('editable');
                this.makeRowEditable(index);
            }
        });
    }

    makeRowEditable(index) {
        const row = document.querySelector(`tr[data-index="${index}"]`);
        const issue = this.issues[index];

        const cellsToEdit = row.querySelectorAll('td:not(:first-child)');
        const colonne = ['data_segnalazione', 'categoria', 'stato', 'priorita', 'descrizione', 'owner', 'deadline', 'note', 'data_chiusura'];

        cellsToEdit.forEach((td, colIndex) => {
            const col = colonne[colIndex];
            const currentValue = issue[col] || '';

            if (col === 'categoria') {
                const select = document.createElement('select');
                ['Bug', 'Richiesta', 'Configurazione', 'Report', 'Altro'].forEach(cat => {
                    const opt = document.createElement('option');
                    opt.value = cat;
                    opt.textContent = cat;
                    if (cat === currentValue) opt.selected = true;
                    select.appendChild(opt);
                });
                select.addEventListener('change', () => this.onCellEdit(index, col, select.value));
                td.innerHTML = '';
                td.appendChild(select);
            } else if (col === 'priorita') {
                const select = document.createElement('select');
                ['Alta', 'Media', 'Bassa'].forEach(pri => {
                    const opt = document.createElement('option');
                    opt.value = pri;
                    opt.textContent = pri;
                    if (pri === currentValue) opt.selected = true;
                    select.appendChild(opt);
                });
                select.addEventListener('change', () => this.onCellEdit(index, col, select.value));
                td.innerHTML = '';
                td.appendChild(select);
            } else if (col === 'stato') {
                const select = document.createElement('select');
                ['Aperto', 'in Lavorazione', 'Chiuso', 'Sospeso'].forEach(st => {
                    const opt = document.createElement('option');
                    opt.value = st;
                    opt.textContent = st;
                    if (st === currentValue) opt.selected = true;
                    select.appendChild(opt);
                });
                select.addEventListener('change', () => this.onCellEdit(index, col, select.value));
                td.innerHTML = '';
                td.appendChild(select);
            } else if (col.includes('date')) {
                const input = document.createElement('input');
                input.type = 'date';
                input.value = currentValue ? currentValue.split('T')[0] : '';
                input.addEventListener('change', () => this.onCellEdit(index, col, input.value));
                td.innerHTML = '';
                td.appendChild(input);
            } else if (col === 'descrizione') {
                const textarea = document.createElement('textarea');
                textarea.value = currentValue;
                textarea.addEventListener('change', () => this.onCellEdit(index, col, textarea.value));
                td.innerHTML = '';
                td.appendChild(textarea);
            } else {
                const input = document.createElement('input');
                input.type = 'text';
                input.value = currentValue;
                input.addEventListener('change', () => this.onCellEdit(index, col, input.value));
                td.innerHTML = '';
                td.appendChild(input);
            }
        });
    }

    renderRowCells(row, issue) {
        const cellsToEdit = row.querySelectorAll('td:not(:first-child)');
        const colonne = ['data_segnalazione', 'categoria', 'stato', 'priorita', 'descrizione', 'owner', 'deadline', 'note', 'data_chiusura'];

        cellsToEdit.forEach((td, colIndex) => {
            const col = colonne[colIndex];
            td.textContent = this.formatCellValue(issue[col], col);
        });
    }

    onCellEdit(index, column, value) {
        this.issues[index][column] = value;
        this.modifiedRows.set(index, true);
        this.updateToolbarButtons();
    }

    updateToolbarButtons() {
        const hasSelection = this.selectedRows.size > 0;
        const hasModifications = this.modifiedRows.size > 0;

        this.deleteBtn.disabled = !hasSelection || this.isEditMode;
        this.closeBtn.disabled = !hasSelection || this.isEditMode;
        this.editBtn.style.display = this.isEditMode || hasModifications ? 'none' : 'inline-flex';
        this.saveBtn.style.display = this.isEditMode && hasModifications ? 'inline-flex' : 'none';
        this.cancelBtn.style.display = this.isEditMode ? 'inline-flex' : 'none';
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

    canModifyRow(issue) {
        if (!this.userRole) return false;
        return this.userRole <= issue.id_roles_write;
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
