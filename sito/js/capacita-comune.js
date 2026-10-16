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
        /* Tooltip ricco (attivaTooltip) */
        .cap-tip { position: fixed; z-index: 2000; display: none; pointer-events: none; max-width: 360px; background: #111827; color: #F9FAFB;
            border-radius: 10px; padding: 0.6rem 0.75rem; font-size: 0.78rem; line-height: 1.5; box-shadow: 0 10px 30px rgba(0,0,0,0.25); }
        .cap-tip .t { font-weight: 700; color: #fff; margin-bottom: 0.2rem; }
        .cap-tip .b { padding-left: 0.6rem; color: #D1D5DB; }
        .cap-tip .r { margin-top: 0.3rem; padding-top: 0.3rem; border-top: 1px solid #374151; font-weight: 700; color: #A7F3D0; }
        .cap-tip .n { margin-top: 0.35rem; color: #9CA3AF; font-style: italic; font-size: 0.72rem; }
        [data-tip] { cursor: help; }
        .cop-legenda { display: inline-flex; gap: 0.9rem; flex-wrap: wrap; align-items: center; font-size: 0.78rem; color: #6B7280; margin: 0 0 0.6rem; }
        .cop-legenda .es { display: inline-flex; flex-direction: column; min-width: 70px; padding: 0.15rem 0.4rem; border-radius: 6px; background: #ECFDF5; font-size: 0.74rem; }
        .cop-legenda .es b { color: #1F2937; } .cop-legenda .es span { color: #6B7280; }
        /* Copertura: riquadri riassuntivi, avvisi, celle «coperte / da fare» con barra */
        .cop-kpi { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 0.8rem; margin-bottom: 1rem; }
        .cop-kpi > div { background: #fff; border: 1px solid var(--pm-bordo); border-radius: 14px; padding: 0.85rem 1rem; box-shadow: 0 1px 3px rgba(15,23,42,0.05); }
        .cop-kpi small { display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--pm-tenue); font-weight: 600; }
        .cop-kpi b { display: block; font-size: 1.7rem; color: #1E1B4B; margin: 0.15rem 0; }
        .cop-kpi span { font-size: 0.78rem; color: var(--pm-tenue); }
        .cop-kpi > div.ko { border-color: #FECACA; background: linear-gradient(180deg, #FEF2F2, #fff); } .cop-kpi > div.ko b { color: #B91C1C; }
        .cop-kpi > div.ok { border-color: #A7F3D0; background: linear-gradient(180deg, #ECFDF5, #fff); } .cop-kpi > div.ok b { color: #047857; }
        .cop-prog-bar { display: block; height: 5px; border-radius: 99px; background: #E5E7EB; overflow: hidden; margin: 0.3rem 0 0.15rem; max-width: 260px; }
        .cop-prog-bar.grande { height: 8px; max-width: none; margin-top: 0.45rem; }
        .cop-prog-bar i { display: block; height: 100%; border-radius: 99px; }
        .cop-prog-bar i.ok { background: linear-gradient(90deg, #34D399, #059669); } .cop-prog-bar i.parz { background: linear-gradient(90deg, #FCD34D, #F59E0B); } .cop-prog-bar i.ko { background: linear-gradient(90deg, #FCA5A5, #DC2626); }
        .cop-avvisi { list-style: none; margin: 0 0 0.6rem; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
        .cop-avvisi li { display: flex; gap: 0.55rem; align-items: flex-start; padding: 0.45rem 0.7rem; border-radius: 9px; font-size: 0.85rem; border-left: 4px solid; }
        .cop-avvisi li.alta { background: #FEF2F2; border-color: #DC2626; color: #7F1D1D; } .cop-avvisi li.alta i { color: #DC2626; }
        .cop-avvisi li.media { background: #FFFBEB; border-color: #F59E0B; color: #78350F; } .cop-avvisi li.media i { color: #D97706; }
        .cop-avvisi li.bassa { background: #EFF6FF; border-color: #93C5FD; color: #1E3A8A; } .cop-avvisi li.bassa i { color: #3B82F6; }
        .cop-avvisi li i { margin-top: 2px; }
        .cop-tab td.cop { min-width: 74px; padding: 0.35rem 0.45rem; vertical-align: middle; }
        .cop-num { display: flex; gap: 0.25rem; justify-content: flex-end; align-items: baseline; font-size: 0.8rem; white-space: nowrap; }
        .cop-num span { color: var(--pm-tenue); font-size: 0.72rem; }
        .cop-bar { height: 4px; border-radius: 99px; background: rgba(0,0,0,0.07); margin-top: 3px; overflow: hidden; }
        .cop-bar i { display: block; height: 100%; border-radius: 99px; }
        td.cop-ok { background: #ECFDF5; } td.cop-ok .cop-bar i { background: #10B981; }
        td.cop-parz { background: #FFFBEB; } td.cop-parz .cop-bar i { background: #F59E0B; }
        td.cop-ko { background: #FEF2F2; } td.cop-ko .cop-bar i { background: #DC2626; } td.cop-ko b { color: #B91C1C; }
        td.cop-extra { background: #EFF6FF; } td.cop-extra .cop-bar i { background: #60A5FA; }
        td.cop-vuoto { color: #D1D5DB; text-align: center; }
        .cop-mancano { display: inline-block; background: #FEE2E2; color: #B91C1C; font-weight: 700; border-radius: 99px; padding: 0.05rem 0.5rem; font-size: 0.8rem; }
        .cop-mancano.forte { background: #DC2626; color: #fff; }
        .cop-okt { color: #059669; }
        .cop-dasist > summary { list-style: none; cursor: pointer; user-select: none; }
        .cop-dasist > summary::-webkit-details-marker { display: none; }
        .cop-dasist > summary h2 { margin: 0; display: flex; align-items: center; gap: 0.45rem; }
        .cop-dasist[open] > summary h2 { margin-bottom: 0.7rem; }
        .cop-dasist .cop-freccia { font-size: 0.75rem; color: #9CA3AF; transition: transform .15s; width: 12px; }
        .cop-dasist[open] .cop-freccia { transform: rotate(90deg); }
        .cop-periodi { display: flex; flex-wrap: wrap; gap: 0.3rem; }
        .cop-periodo { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.76rem; color: #065F46; background: #ECFDF5; border: 1px solid #A7F3D0; border-radius: 999px; padding: 0.05rem 0.55rem; white-space: nowrap; }
        .cop-periodo b { color: #047857; }
        .cop-periodo:hover { background: #D1FAE5; border-color: #6EE7B7; }
        tr.cop-prog td { border-top: 2px solid #EEF2FF; }
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
        .cap-nome { border: 0; background: none; padding: 0; cursor: pointer; color: inherit; font: inherit; text-align: left; }
        .cap-nome i { color: #9CA3AF; font-size: 0.75rem; margin-left: 0.15rem; }
        .cap-nome:hover b { color: #4F46E5; text-decoration: underline; } .cap-nome:hover i { color: #4F46E5; }
        .cap-pers-btn small { color: var(--pm-tenue); }
        tr.azc-pers td { background: #FAFAFF; }
        /* Carico con le ore della persona e gli altri PM del tenant */
        .cap-tenant td.h { position: relative; min-width: 78px; line-height: 1.25; }
        .cap-tenant td.h .mie { display: block; font-weight: 700; }
        .cap-tenant td.h .altri { display: block; font-size: 0.68rem; color: #6D28D9; font-weight: 600; }
        .cap-tenant td.h .tot { display: block; font-size: 0.64rem; color: #6B7280; font-weight: 400; }
        .cap-tenant td.h.alto { box-shadow: inset 0 0 0 2px #DC2626; }
        .cap-tenant td.h.alto::before { content: '⚠'; position: absolute; top: 1px; right: 3px; font-size: 0.78rem; color: #B91C1C; }
        .cap-tenant th.w-alert { color: #B91C1C; }
        .cap-tenant th.w-alert::after { content: ' ⚠'; }
        .cap-flag { display: inline-flex; align-items: center; gap: 0.3rem; background: #DC2626; color: #fff; border-radius: 99px; padding: 0.05rem 0.5rem; font-size: 0.7rem; font-weight: 700; margin-left: 0.35rem; vertical-align: 2px; }
        .cap-ore { display: inline-flex; align-items: center; gap: 0.25rem; background: #EEF2FF; color: #3730A3; border-radius: 99px; padding: 0.02rem 0.45rem; font-size: 0.72rem; font-weight: 600; margin-top: 3px; }
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
        if (!risorse.length) { toast('Nessuna persona ancora: usa «Alloca» sulle persone del team o «Alloca tutti i team» nella pagina Capacità', 'errore'); return; }
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
                <p class="pm-nota">Esempio: 50% dal 01/11 al 31/12 = metà del tempo della persona su questo progetto in quel periodo. La percentuale si calcola sulle ore lavorate a settimana della persona (Rubrica, 32 h se non indicate); il carico tiene conto di festività e assenze.</p>`,
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

    // Tooltip ricco: elementi con data-tip (testo, una riga per «\n»). Prima riga = titolo;
    // righe che iniziano con «•» rientrate; righe che iniziano con «ℹ» = nota in corsivo;
    // righe «=» = riga di risultato in evidenza. Un solo tooltip per pagina.
    let tipEl = null;
    function attivaTooltip(root) {
        if (!tipEl) {
            tipEl = document.createElement('div');
            tipEl.className = 'cap-tip';
            document.body.appendChild(tipEl);
        }
        const mostra = (el, e) => {
            const righe = String(el.dataset.tip || '').split('\n');
            tipEl.innerHTML = righe.map((r, i) => {
                if (i === 0) return `<div class="t">${esc(r)}</div>`;
                if (r.startsWith('•')) return `<div class="b">${esc(r)}</div>`;
                if (r.startsWith('ℹ')) return `<div class="n">${esc(r.slice(1).trim())}</div>`;
                if (r.startsWith('=')) return `<div class="r">${esc(r.slice(1).trim())}</div>`;
                return `<div>${esc(r)}</div>`;
            }).join('');
            tipEl.style.display = 'block';
            const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
            const x = Math.min(e.clientX + 16, window.innerWidth - w - 10);
            const y = e.clientY + 18 + h > window.innerHeight ? e.clientY - h - 12 : e.clientY + 18;
            tipEl.style.left = `${Math.max(8, x)}px`; tipEl.style.top = `${Math.max(8, y)}px`;
        };
        root.addEventListener('mousemove', (e) => { const el = e.target.closest('[data-tip]'); if (el && root.contains(el)) mostra(el, e); else tipEl.style.display = 'none'; });
        root.addEventListener('mouseleave', () => { tipEl.style.display = 'none'; });
    }

    window.CapacitaUI = { g, classeCarico, classeFabbisogno, meseIt, formAllocazione, attivaTooltip };
})();
