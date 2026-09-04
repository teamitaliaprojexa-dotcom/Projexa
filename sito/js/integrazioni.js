// === PULSANTE «AGGIORNA INTEGRAZIONI» — UI ===
//
// Il pulsante sta nell'intestazione della dashboard, accanto a «Nuovo Progetto».
// Alla pressione lancia in sequenza i programmi di sincronizzazione del backend
// (POST /api/integrazioni/aggiorna) e mostra il riepilogo di cosa è stato letto,
// inserito e aggiornato.
//
// Il pulsante compare solo se l'integrazione Jira è abilitata per l'utente
// (flag settings campo = 'Jira'), come già avviene per la voce Jira in sidebar.
(function () {
    'use strict';

    const API_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? location.origin
        : 'https://projexa-4mix.onrender.com') + '/api';

    function authHeaders(extra) {
        const token = localStorage.getItem('authToken');
        return Object.assign({}, extra || {}, token ? { Authorization: 'Bearer ' + token } : {});
    }

    function esc(text) {
        return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    let inCorso = false;

    // ==========================================
    // FINESTRA DEL RIEPILOGO
    // ==========================================

    function injectStyles() {
        if (document.getElementById('integrStyles')) return;
        const style = document.createElement('style');
        style.id = 'integrStyles';
        style.textContent = `
        .integr-overlay { position: fixed; inset: 0; z-index: 1200; display: none;
            align-items: center; justify-content: center; background: rgba(17,24,39,0.45); }
        .integr-overlay.open { display: flex; }
        .integr-box { background: #fff; border-radius: 12px; width: min(680px, 92vw);
            max-height: 86vh; overflow: auto; box-shadow: 0 20px 50px rgba(0,0,0,0.25); }
        .integr-head { display: flex; align-items: center; gap: 0.6rem; padding: 1rem 1.25rem;
            border-bottom: 1px solid #E5E7EB; font-weight: 600; color: #1F2937; }
        .integr-head i { color: #2684FF; }
        .integr-head .integr-spacer { flex: 1 1 auto; }
        .integr-close { background: none; border: none; font-size: 1.3rem; line-height: 1;
            color: #6B7280; cursor: pointer; }
        .integr-body { padding: 1rem 1.25rem; font-size: 0.9rem; color: #374151; }
        .integr-prog { border: 1px solid #E5E7EB; border-radius: 10px; padding: 0.85rem 1rem;
            margin-bottom: 0.85rem; }
        .integr-prog h4 { margin: 0 0 0.6rem; font-size: 0.95rem; color: #1F2937;
            display: flex; align-items: center; gap: 0.45rem; }
        .integr-prog h4 .integr-esito { font-size: 0.72rem; font-weight: 700; padding: 2px 8px;
            border-radius: 999px; }
        .integr-ok { background: #D1FAE5; color: #065F46; }
        .integr-ko { background: #FEE2E2; color: #B91C1C; }
        .integr-nums { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 0.5rem; }
        .integr-num { background: #F9FAFB; border-radius: 8px; padding: 0.45rem 0.6rem; }
        .integr-num b { display: block; font-size: 1.15rem; color: #1F2937; }
        .integr-num span { font-size: 0.74rem; color: #6B7280; }
        .integr-extra { margin-top: 0.7rem; padding-top: 0.7rem; border-top: 1px dashed #E5E7EB; }
        .integr-extra-head { font-size: 0.8rem; color: #6B7280; margin-bottom: 0.5rem; }
        .integr-note { margin-top: 0.6rem; font-size: 0.78rem; color: #92400E;
            background: #FEF3C7; border-radius: 6px; padding: 0.45rem 0.6rem; }
        .integr-note ul { margin: 0.3rem 0 0; padding-left: 1.1rem; }
        .integr-err { margin-top: 0.6rem; font-size: 0.8rem; color: #B91C1C;
            background: #FEF2F2; border-radius: 6px; padding: 0.45rem 0.6rem; }
        `;
        document.head.appendChild(style);
    }

    function buildOverlay() {
        let overlay = document.getElementById('integrOverlay');
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.className = 'integr-overlay';
        overlay.id = 'integrOverlay';
        overlay.innerHTML = `
            <div class="integr-box">
                <div class="integr-head">
                    <i class="fas fa-rotate"></i><span>Aggiorna Integrazioni</span>
                    <span class="integr-spacer"></span>
                    <button type="button" class="integr-close" id="integrClose" aria-label="Chiudi">&times;</button>
                </div>
                <div class="integr-body" id="integrBody"></div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('#integrClose').addEventListener('click', close);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
        return overlay;
    }

    function open(html) {
        const overlay = buildOverlay();
        overlay.querySelector('#integrBody').innerHTML = html;
        overlay.classList.add('open');
    }

    function close() {
        const overlay = document.getElementById('integrOverlay');
        if (overlay) overlay.classList.remove('open');
    }

    // ==========================================
    // RIEPILOGO
    // ==========================================

    function numero(valore, etichetta) {
        return `<div class="integr-num"><b>${esc(valore)}</b><span>${esc(etichetta)}</span></div>`;
    }

    function elenco(titolo, voci) {
        if (!voci || voci.length === 0) return '';
        return `<div class="integr-note"><strong>${esc(titolo)}</strong>
            <ul>${voci.map(v => `<li>${esc(v)}</li>`).join('')}</ul></div>`;
    }

    // Secondo filtro Jira, configurato in Impostazioni -> Integrazioni: aggiorna
    // soltanto righe già presenti, a parità di codice Jira e SENZA guardare il
    // cliente. Non crea righe nuove. Compare solo se configurato.
    function renderPassaggioAggiuntivo(p) {
        if (!p) return '';
        return `<div class="integr-extra">
            <div class="integr-extra-head">Filtro aggiuntivo (solo aggiornamento, per codice Jira):
                <strong>${esc(p.filtro)}</strong></div>
            <div class="integr-nums">
                ${numero(p.righeJira, 'righe lette da Jira')}
                ${numero(p.aggiornate, 'aggiornate')}
                ${numero(p.ignorateNonTrovate, 'non presenti')}
                ${numero(p.ignorateScadute, 'già scadute')}
            </div>
        </div>`;
    }

    function renderProgramma(r) {
        const titolo = `<h4>${esc(r.etichetta || r.programma)}
            <span class="integr-esito ${r.ok ? 'integr-ok' : 'integr-ko'}">${r.ok ? 'ESEGUITO' : 'NON ESEGUITO'}</span></h4>`;

        if (!r.ok) {
            return `<div class="integr-prog">${titolo}
                <div class="integr-err">${esc(r.errore || 'Errore non specificato')}</div></div>`;
        }

        return `<div class="integr-prog">${titolo}
            <div style="font-size:0.8rem;color:#6B7280;margin-bottom:0.55rem;">
                Filtro Jira: <strong>${esc(r.filtro || '—')}</strong> ·
                clienti configurati: <strong>${esc(r.clientiConfigurati)}</strong>
            </div>
            <div class="integr-nums">
                ${numero(r.righeJira, 'righe lette da Jira')}
                ${numero(r.inserite, 'inserite')}
                ${numero(r.aggiornate, 'aggiornate')}
                ${numero(r.ignorateSenzaCliente, 'senza cliente')}
                ${numero(r.ignorateScadute, 'già scadute')}
                ${r.ignorateSenzaCodice ? numero(r.ignorateSenzaCodice, 'senza codice') : ''}
            </div>
            ${renderPassaggioAggiuntivo(r.passaggioAggiuntivo)}
            ${elenco('Colonne di mappatura non utilizzate:', r.colonneIgnorate)}
            ${elenco('Colonne Jira non trovate:', r.mappatureNonRisolte)}
            ${(r.errori && r.errori.length)
                ? `<div class="integr-err"><strong>Righe non elaborate:</strong>
                    <ul style="margin:0.3rem 0 0;padding-left:1.1rem;">
                    ${r.errori.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`
                : ''}
        </div>`;
    }

    // ==========================================
    // ESECUZIONE
    // ==========================================

    async function esegui() {
        if (inCorso) return;
        const btn = document.getElementById('btnAggiornaIntegrazioni');
        if (!btn) return;

        inCorso = true;
        const originale = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Aggiornamento…';

        try {
            const response = await fetch(`${API_URL}/integrazioni/aggiorna`, {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: '{}'
            });
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                open(`<div class="integr-err">${esc(data.error || `Errore HTTP ${response.status}`)}</div>`);
                return;
            }

            open((data.risultati || []).map(renderProgramma).join('') ||
                '<div class="integr-err">Nessun programma eseguito.</div>');

            // I KPI della dashboard leggono cl_quotazioni e task_app: dopo la
            // sincronizzazione vanno riletti, altrimenti mostrano i numeri di prima.
            if (typeof window.loadDashboardKpis === 'function') {
                window.loadDashboardKpis().catch(function (e) { console.warn('[INTEGRAZIONI] KPI:', e.message); });
            }
        } catch (error) {
            open(`<div class="integr-err">${esc(error.message)}</div>`);
        } finally {
            btn.disabled = false;
            btn.innerHTML = originale;
            inCorso = false;
        }
    }

    // ==========================================
    // AVVIO
    // ==========================================

    // Il pulsante ha senso solo se c'è almeno un'integrazione attiva: oggi i
    // programmi disponibili leggono tutti da Jira, quindi si allinea al flag Jira.
    async function refreshVisibilita() {
        const btn = document.getElementById('btnAggiornaIntegrazioni');
        if (!btn) return false;
        try {
            const response = await fetch(`${API_URL}/jira/status`, { headers: authHeaders() });
            const status = response.ok ? await response.json() : null;
            const attiva = !!(status && status.enabled);
            btn.style.display = attiva ? '' : 'none';
            return attiva;
        } catch (e) {
            btn.style.display = 'none';
            return false;
        }
    }

    async function init() {
        const btn = document.getElementById('btnAggiornaIntegrazioni');
        if (!btn) return;
        injectStyles();
        btn.addEventListener('click', esegui);
        await refreshVisibilita();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.ProjexaIntegrazioni = { esegui: esegui, refreshVisibilita: refreshVisibilita };
})();
