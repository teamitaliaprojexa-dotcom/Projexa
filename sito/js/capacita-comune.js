// Capacità e allocazione delle risorse (2026-10-16, FACOLTATIVA): parti comuni della pagina
// Capacità (capacita.html) e della scheda «Risorse» del Cruscotto PM (pm.html).
// API: /api/pm/capacita* (backend/routes/pm.js, backend/config/capacita.js).
(function () {
    const { esc, api, fmt, dataIt, toast, modale, valori } = PM;

    const stile = document.createElement('style');
    stile.textContent = `
        .cap-g { font-variant-numeric: tabular-nums; }
        .cap-cell { text-align: right; white-space: nowrap; }
        .cap-cell small { display: block; color: var(--pm-tenue); font-size: 0.72rem; }
        .cap-ok { background: #ECFDF5; } .cap-att { background: #FFFBEB; } .cap-ko { background: #FEF2F2; color: #991B1B; font-weight: 600; }
        .cap-heat td.h { text-align: center; font-size: 0.78rem; font-weight: 600; min-width: 54px; border-left: 2px solid #fff; }
        .cap-heat td.h.zero { background: #F3F4F6; color: #9CA3AF; font-weight: 400; }
        .cap-heat td.h.basso { background: #D1FAE5; color: #065F46; }
        .cap-heat td.h.medio { background: #FDE68A; color: #92400E; }
        .cap-heat td.h.alto { background: #FCA5A5; color: #7F1D1D; }
        .cap-heat td.h.assente { background: repeating-linear-gradient(45deg, #E5E7EB, #E5E7EB 4px, #F9FAFB 4px, #F9FAFB 8px); color: #6B7280; }
        /* Prima colonna (persona / ruolo / progetto) ferma durante lo scorrimento orizzontale */
        table.cap-fissa > thead > tr > th:first-child,
        table.cap-fissa > tbody > tr > td:first-child { position: sticky; left: 0; z-index: 2; background: #fff; box-shadow: 6px 0 8px -6px rgba(15,23,42,0.18); }
        table.cap-fissa > thead > tr > th:first-child { z-index: 3; }
        table.cap-fissa > tbody > tr.azc-pers > td:first-child { background: #FAFAFF; }
        table.cap-fissa > tbody > tr > td[colspan]:first-child { position: static; box-shadow: none; }
        table.cap-fissa > tbody > tr.click:hover > td:first-child { background: #F9FAFB; }
        /* Selettore a due posizioni (es. «Per ruolo | Per progetto») con cursore che scorre */
        .cap-seg { position: relative; display: inline-grid; grid-template-columns: 1fr 1fr; padding: 4px; border-radius: 999px;
            background: linear-gradient(180deg, #EEF2FF, #E0E7FF); box-shadow: inset 0 1px 2px rgba(49,46,129,0.12); font-size: 0.82rem; font-weight: 600; user-select: none; }
        .cap-seg::before { content: ''; position: absolute; top: 4px; bottom: 4px; left: 4px; width: calc(50% - 4px); border-radius: 999px;
            background: linear-gradient(135deg, #6366F1, #4F46E5); box-shadow: 0 4px 12px rgba(79,70,229,0.35);
            transition: transform 0.28s cubic-bezier(.4,.0,.2,1); }
        .cap-seg.destra::before { transform: translateX(100%); }
        .cap-seg button { position: relative; z-index: 1; border: none; background: none; cursor: pointer; padding: 0.42rem 1rem; border-radius: 999px;
            display: inline-flex; align-items: center; justify-content: center; gap: 0.45rem; color: #4338CA; font: inherit; white-space: nowrap; transition: color 0.2s; }
        .cap-seg button.on { color: #fff; }
        .cap-seg button:not(.on):hover { color: #312E81; }
        .cap-seg button:focus-visible { outline: 2px solid #A5B4FC; outline-offset: 2px; }
        .cap-pers-btn { border: 1px solid #E5E7EB; background: #fff; border-radius: 6px; padding: 0.05rem 0.4rem; cursor: pointer; color: #4F46E5; font-size: 0.78rem; }
        .cap-pers-btn:hover { background: #EEF2FF; border-color: #C7D2FE; }
        .cap-pers-btn small { color: var(--pm-tenue); }
        tr.azc-pers td { background: #FAFAFF; }
        .cap-legenda span { display: inline-flex; align-items: center; gap: 0.3rem; margin-right: 0.9rem; font-size: 0.78rem; color: var(--pm-tenue); }
        .cap-legenda i { width: 14px; height: 14px; border-radius: 3px; display: inline-block; }`;
    document.head.appendChild(stile);

    const g = (n) => fmt(n, 1);
    // Classe del carico % di una settimana.
    function classeCarico(s) {
        if (s.capacita <= 0 && s.allocato <= 0) return s.assenze ? 'assente' : 'zero';
        if (s.carico == null || s.carico > 100.5) return 'alto';
        if (s.carico >= 80) return 'medio';
        return s.allocato > 0 ? 'basso' : 'zero';
    }
    // Fabbisogno contro capacità di un ruolo in un mese.
    function classeFabbisogno(fab, cap) {
        if (cap == null || cap <= 0) return '';
        if (fab > cap + 0.05) return 'cap-ko';
        if (fab >= cap * 0.8) return 'cap-att';
        return 'cap-ok';
    }
    const meseIt = (m) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString('it-IT', { month: 'short', year: '2-digit', timeZone: 'UTC' });

    // Finestra di una allocazione (nuova o da modificare). progetti: [{ projectId, nome, cliente }]
    // oppure null con projectId fisso (Cruscotto). onSalvato() dopo il salvataggio.
    function formAllocazione({ x = {}, risorse, progetti = null, projectId = null, onSalvato }) {
        const nuovo = !x.id;
        const sola = !nuovo && x.puoModificare === false;
        if (!risorse.length) { toast('Prima aggiungi le persone nella scheda Risorse della pagina Capacità', 'errore'); return; }
        const oggi = new Date().toISOString().slice(0, 10);
        const m = modale({
            titolo: `<i class="fas fa-user-clock"></i> ${nuovo ? 'Nuova allocazione' : 'Allocazione'}`,
            corpo: `${sola ? '<div class="pm-avviso">Sola lettura: il tuo ruolo non può modificare questa allocazione.</div>' : ''}<div class="pm-form">
                <label>Persona<select name="risorsa_id">${risorse.map((r) => `<option value="${esc(r.id)}" ${r.id === x.risorsa_id ? 'selected' : ''}>${esc(r.nominativo)}${r.ruolo ? ` – ${esc(r.ruolo)}` : ''}</option>`).join('')}</select></label>
                ${progetti ? `<label>Progetto<select name="projectId">${progetti.map((p) => `<option value="${esc(p.projectId)}" ${p.projectId === x.project_id ? 'selected' : ''}>${esc(p.cliente ? `${p.cliente} · ` : '')}${esc(p.nome)}</option>`).join('')}</select></label>` : ''}
                <label>Percentuale del suo tempo (%)<input name="perc" type="number" min="1" max="100" value="${esc(x.perc ?? 50)}"></label>
                <label>Dal<input type="date" name="dal" value="${esc(x.dal || oggi)}"></label>
                <label>Al<input type="date" name="al" value="${esc(x.al || '')}"></label>
                <label class="largo">Note<textarea name="note" style="min-height:50px">${esc(x.note || '')}</textarea></label></div>
                <p class="pm-nota">Esempio: 50% dal 01/11 al 31/12 = metà del tempo della persona su questo progetto in quel periodo. Il carico tiene conto di festività, assenze e della quota di tempo che la persona dedica ai progetti.</p>`,
            pulsanti: [
                ...(!nuovo && !sola ? [{ testo: '<i class="fas fa-trash"></i> Elimina', classe: 'pericolo', azione: async () => {
                    if (!confirm('Eliminare questa allocazione?')) return false;
                    await api(`/capacita/allocazioni/${encodeURIComponent(x.id)}`, { metodo: 'DELETE' });
                    toast('Allocazione eliminata'); onSalvato && onSalvato();
                } }] : []),
                { testo: 'Annulla' },
                ...(!sola ? [{ testo: '<i class="fas fa-floppy-disk"></i> Salva', classe: 'primario', azione: async (mm) => {
                    const v = valori(mm);
                    if (!v.al) throw new Error('Indica la data di fine dell\'allocazione');
                    if (!progetti) v.projectId = projectId;
                    if (nuovo) await api('/capacita/allocazioni', { metodo: 'POST', corpo: v });
                    else await api(`/capacita/allocazioni/${encodeURIComponent(x.id)}`, { metodo: 'PUT', corpo: v });
                    toast('Allocazione salvata'); onSalvato && onSalvato();
                } }] : [])
            ]
        });
        if (sola) m.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
    }

    window.CapacitaUI = { g, classeCarico, classeFabbisogno, meseIt, formAllocazione };
})();
