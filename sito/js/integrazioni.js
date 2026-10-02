// === PULSANTE «AGGIORNA INTEGRAZIONI» — UI ===
//
// Il pulsante sta nella barra in alto della pagina Jira (js/jira.js), che chiama
// window.ProjexaIntegrazioni.esegui(pulsante). Alla pressione lancia in sequenza i programmi di sincronizzazione del backend
// (POST /api/integrazioni/aggiorna) e mostra il riepilogo di cosa è stato letto,
// inserito e aggiornato.
//
// Il lancio vale per tutto il tenant: un solo passaggio aggiorna anche i dati degli
// altri utenti, con la configurazione Jira di chi preme (o di un altro utente del
// tenant configurato). Il riepilogo dice di chi è la configurazione usata.
//
// Il pulsante è visibile a chi apre la pagina Jira, cioè a chi ha il flag
// settings campo = 'Jira' attivo (come la voce Jira in sidebar).
(function () {
    'use strict';

    const API_URL = location.origin + '/api';

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
        .integr-user-box + .integr-user-box { margin-top: 0.8rem; padding-top: 0.8rem;
            border-top: 1px dashed #E5E7EB; }
        .integr-user { font-size: 0.85rem; font-weight: 600; color: #1F2937; margin-bottom: 0.45rem; }
        .integr-user i { color: #6B7280; margin-right: 0.3rem; }
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
                ${p.invariate ? numero(p.invariate, 'invariate') : ''}
                ${numero(p.ignorateNonTrovate, 'non presenti')}
                ${numero(p.ignorateScadute, 'già scadute')}
            </div>
        </div>`;
    }

    // Il lancio vale per tutto il tenant: per ogni programma il backend restituisce
    // le configurazioni Jira provate (utenti[]): quella usata con i numeri e quelle
    // scartate con il motivo (es. Jira non collegato).
    function renderProgramma(r) {
        const titolo = `<h4>${esc(r.etichetta || r.programma)}
            <span class="integr-esito ${r.ok ? 'integr-ok' : 'integr-ko'}">${r.ok ? 'ESEGUITO' : 'NON ESEGUITO'}</span></h4>`;

        if (!r.ok) {
            return `<div class="integr-prog">${titolo}
                <div class="integr-err">${esc(r.errore || 'Errore non specificato')}</div></div>`;
        }

        // Risposta per singolo utente (formato precedente): nessun elenco utenti.
        if (!Array.isArray(r.utenti)) {
            return `<div class="integr-prog">${titolo}${renderDettaglio(r)}</div>`;
        }

        const utenti = r.utenti.map(function (u) {
            const nome = esc(u.nome || u.userId);
            if (u.ok) {
                return `<div class="integr-user-box"><div class="integr-user"><i class="fas fa-user-gear"></i> Tutto il tenant, con la configurazione Jira di ${nome}</div>${renderDettaglio(u.report || {})}</div>`;
            }
            const classe = u.saltato ? 'integr-note' : 'integr-err';
            return `<div class="integr-user-box"><div class="integr-user"><i class="fas fa-user-slash"></i> Configurazione di ${nome} non utilizzata</div><div class="${classe}">${esc(u.errore || 'Errore non specificato')}</div></div>`;
        }).join('');

        return `<div class="integr-prog">${titolo}${utenti}</div>`;
    }

    // Numeri e avvisi della sincronizzazione di un singolo utente.
    function renderDettaglio(r) {
        return `
            <div style="font-size:0.8rem;color:#6B7280;margin-bottom:0.55rem;">
                Filtro Jira: <strong>${esc(r.filtro || '—')}</strong> ·
                clienti configurati: <strong>${esc(r.clientiConfigurati)}</strong>
            </div>
            <div class="integr-nums">
                ${numero(r.righeJira, 'righe lette da Jira')}
                ${numero(r.inserite, 'inserite')}
                ${numero(r.aggiornate, 'aggiornate')}
                ${r.invariate ? numero(r.invariate, 'invariate') : ''}
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
                : ''}`;
    }

    // ==========================================
    // ESECUZIONE
    // ==========================================

    // sorgente: il pulsante premuto (o l'evento del click). Lo stesso comando è
    // disponibile nella dashboard e nella pagina Jira (js/jira.js): la rotellina
    // compare sul pulsante che è stato premuto.
    async function esegui(sorgente) {
        if (inCorso) return;
        const btn = (sorgente && sorgente.currentTarget) || (sorgente && sorgente.nodeType === 1 ? sorgente : null);
        if (!btn) return;
        injectStyles();

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

    // Richiamato dal pulsante della pagina Jira (js/jira.js).
    window.ProjexaIntegrazioni = { esegui: esegui };
})();
