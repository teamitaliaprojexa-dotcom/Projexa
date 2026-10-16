// Piano automatico del progetto (Cruscotto PM › Risorse, 2026-10-16), dal prototipo approvato
// Supporto/Prototipi/piano-automatico.html.
// Per ogni ruolo: giornate che restano (Stima − Consuntivo dei Costi Progetto), ritmo a
// settimana per consegnare in tempo, divisione tra le persone del team con quel ruolo in base
// alle ore settimanali (Rubrica), esito (fattibile / non basta / qualcuno troppo carico),
// confronto con le allocazioni di oggi e striscia settimana per settimana.
// Si può cambiare la data di consegna (prova, non si salva); chi partecipa lo decide l'interruttore
// «Nel piano» delle Persone sul progetto (salvato sul team, proj_componenti.nel_piano);
// «Applica il piano» sostituisce le allocazioni del progetto (POST /api/pm/capacita/piano).
// Dati: GET /api/pm/capacita/piano (backend/config/capacita.js › pianoProgetto).
(function () {
    const { esc, api, toast } = PM;

    const stile = document.createElement('style');
    stile.textContent = `
        .pa-card { background: #fff; border: 1px solid var(--pm-bordo, #E5E7EB); border-radius: 14px; padding: 0.9rem 1.1rem 1rem; margin-bottom: 1.1rem; font-size: 0.86rem; }
        .pa-testa { display: flex; flex-wrap: wrap; gap: 0.6rem 1rem; align-items: center; margin-bottom: 0.7rem; }
        .pa-testa h2 { margin: 0; font-size: 1rem; display: flex; align-items: center; gap: 0.45rem; }
        .pa-testa h2 i { color: #6D28D9; }
        .pa-info { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; color: #4B5563; }
        .pa-info .sep { color: #D1D5DB; }
        .pa-info b { color: #111827; }
        .pa-testa .spazio { flex: 1; }
        .pa-testa input[type=date] { font: inherit; font-size: 0.82rem; padding: 0.22rem 0.4rem; border: 1px solid #E5E7EB; border-radius: 8px; }
        .pa-btn { font: inherit; font-weight: 600; border-radius: 8px; padding: 0.35rem 0.75rem; border: 1px solid #E5E7EB; background: #fff; cursor: pointer; display: inline-flex; gap: 0.4rem; align-items: center; font-size: 0.82rem; }
        .pa-btn.primario { background: linear-gradient(120deg, #4F46E5, #6D28D9); color: #fff; border: 0; }
        .pa-btn:disabled { opacity: .55; cursor: default; }
        .pa-badge { display: inline-flex; align-items: center; gap: 0.3rem; font-weight: 700; font-size: 0.76rem; padding: 0.15rem 0.55rem; border-radius: 999px; white-space: nowrap; }
        .pa-badge.ok { background: #DCFCE7; color: #166534; } .pa-badge.ko { background: #FEE2E2; color: #991B1B; } .pa-badge.att { background: #FEF3C7; color: #92400E; }
        .pa-ruolo { border: 1px solid #EEF0F4; border-radius: 12px; margin-top: 0.6rem; overflow: hidden; }
        .pa-rt { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.8rem; padding: 0.55rem 0.8rem; background: #FAFAFC; border-bottom: 1px solid #EEF0F4; }
        .pa-rt h3 { margin: 0; font-size: 0.92rem; }
        .pa-rt .num { color: #4B5563; }
        .pa-rt .num b { color: #111827; }
        .pa-rt .ritmo { color: #6D28D9; font-weight: 700; }
        .pa-rt .ritmo small { color: #8B5CF6; font-weight: 600; }
        .pa-rt .spazio { flex: 1; }
        .pa-nota-r { padding: 0.4rem 0.8rem; font-size: 0.8rem; line-height: 1.45; border-bottom: 1px solid #EEF0F4; }
        .pa-nota-r.ko { background: #FEF2F2; color: #991B1B; } .pa-nota-r.att { background: #FFFBEB; color: #92400E; } .pa-nota-r.info { background: #F8FAFC; color: #475569; }
        .pa-t { width: 100%; border-collapse: collapse; }
        .pa-t th { text-align: left; font-size: 0.66rem; text-transform: uppercase; letter-spacing: .05em; color: #9CA3AF; padding: 0.35rem 0.8rem; font-weight: 600; border-bottom: 1px solid #F1F5F9; }
        .pa-t td { padding: 0.4rem 0.8rem; border-bottom: 1px solid #F5F6F8; vertical-align: middle; }
        .pa-t tr:last-child td { border-bottom: 0; }
        .pa-t .n { text-align: right; white-space: nowrap; }
        .pa-pers { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; color: #111827; }
        .pa-av { width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; color: #fff; font-size: 0.6rem; font-weight: 800; flex: none; }
        .pa-pers small { font-weight: 400; color: #9CA3AF; font-size: 0.72rem; margin-left: 0.15rem; }
        .pa-op { display: inline-flex; align-items: center; gap: 0.35rem; justify-content: flex-end; }
        .pa-op .oggi { color: #6B7280; }
        .pa-op .freccia { color: #C4B5FD; font-size: 0.7rem; }
        .pa-perc { display: inline-flex; align-items: center; gap: 0.1rem; font-weight: 700; color: #6D28D9; }
        .pa-perc input { width: 46px; text-align: right; font: inherit; font-weight: 700; color: #6D28D9; border: 1px solid #E9E5FF; border-radius: 6px; padding: 0.08rem 0.25rem; background: #FAF8FF; font-size: 0.86rem; }
        .pa-perc input:focus { outline: 2px solid #A78BFA; outline-offset: 1px; background: #fff; }
        .pa-perc.man input { border-color: #F59E0B; background: #FFFBEB; color: #92400E; }
        .pa-auto { border: 0; background: none; color: #9CA3AF; font-size: 0.72rem; cursor: pointer; padding: 0 0.15rem; }
        .pa-auto:hover { color: #4B5563; }
        .pa-sett-c { color: #4B5563; }
        .pa-sett-c small { color: #9CA3AF; }
        .pa-carico { display: flex; align-items: center; gap: 0.45rem; justify-content: flex-end; }
        .pa-barra { width: 90px; height: 6px; border-radius: 999px; background: #EEF2F7; overflow: hidden; display: flex; }
        .pa-barra i { display: block; height: 100%; }
        .pa-barra .altri { background: #CBD5E1; } .pa-barra .questo { background: #7C3AED; } .pa-barra .oltre { background: #DC2626; }
        .pa-carico span { font-weight: 600; min-width: 34px; text-align: right; color: #374151; }
        .pa-carico span.ko { color: #DC2626; }
        .pa-sett { border-top: 1px solid #EEF0F4; }
        .pa-sett summary { cursor: pointer; padding: 0.4rem 0.8rem; font-size: 0.76rem; color: #6B7280; list-style: none; user-select: none; }
        .pa-sett summary::-webkit-details-marker { display: none; }
        .pa-sett summary i { transition: transform .15s; margin-right: 0.3rem; }
        .pa-sett[open] summary i { transform: rotate(90deg); }
        .pa-strip { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(52px, 1fr); gap: 4px; overflow-x: auto; padding: 0 0.8rem 0.7rem; }
        .pa-s { background: #F8FAFC; border-radius: 8px; padding: 0.3rem 0.2rem; text-align: center; font-size: 0.68rem; color: #6B7280; }
        .pa-s b { color: #111827; font-size: 0.74rem; display: block; }
        .pa-s.fest { background: #FFF7ED; }
        .pa-griglia { overflow-x: auto; padding: 0 0.8rem 0.7rem; }
        .pa-griglia table { border-collapse: separate; border-spacing: 3px; width: 100%; }
        .pa-griglia th { font-size: 0.66rem; color: #9CA3AF; font-weight: 600; padding: 0.15rem 0.3rem; text-align: right; white-space: nowrap; }
        .pa-griglia th.fest { color: #D97706; }
        .pa-griglia td { background: #F8FAFC; border-radius: 6px; padding: 0.22rem 0.35rem; font-size: 0.72rem; text-align: right; white-space: nowrap; }
        .pa-griglia td b { display: block; color: #4C1D95; font-size: 0.76rem; }
        .pa-griglia td small { color: #9CA3AF; font-size: 0.64rem; }
        .pa-griglia td.chi { background: none; text-align: left; font-weight: 600; color: #111827; display: flex; align-items: center; gap: 0.35rem; }
        .pa-griglia td.chi .pa-av { width: 20px; height: 20px; font-size: 0.55rem; border-radius: 6px; }
        .pa-griglia td.chi small { color: #8B5CF6; font-weight: 700; }
        .pa-griglia tr.tot td { background: #EDE9FE; } .pa-griglia tr.tot td.chi { background: none; color: #5B21B6; }
        .pa-griglia tr.serve td { background: none; border-top: 1px dashed #E5E7EB; } .pa-griglia tr.serve td b { color: #6B7280; } .pa-griglia tr.serve td.chi { color: #6B7280; }
        .pa-nota { font-size: 0.74rem; color: #9CA3AF; margin: 0.7rem 0 0; line-height: 1.45; }
        @media (max-width: 760px) { .pa-barra { width: 50px; } .pa-testa .spazio { display: none; } }
    `;
    document.head.appendChild(stile);

    // Festività italiane (come il server: fisse + Pasquetta) per le date «finiresti il …».
    function pasqua(y) {
        const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
        const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
        const mese = Math.floor((h + l - 7 * m + 114) / 31), giorno = ((h + l - 7 * m + 114) % 31) + 1;
        return Date.UTC(y, mese - 1, giorno, 12);
    }
    const festeCache = new Map();
    function festa(d) {
        const y = Number(d.slice(0, 4));
        if (!festeCache.has(y)) {
            const s = new Set(['01-01', '01-06', '04-25', '05-01', '06-02', '08-15', '11-01', '12-08', '12-25', '12-26'].map((x) => `${y}-${x}`));
            s.add(new Date(pasqua(y) + 86400000).toISOString().slice(0, 10));
            festeCache.set(y, s);
        }
        return festeCache.get(y).has(d);
    }
    const T = (d) => Date.parse(`${d}T12:00:00Z`);
    const iso = (t) => new Date(t).toISOString().slice(0, 10);
    function dopoGiorni(dal, n) { // n-esimo giorno lavorativo a partire da «dal» (compreso)
        let t = T(dal), c = 0;
        for (let guard = 0; guard < 4000; guard++, t += 86400000) {
            const d = iso(t), w = new Date(t).getUTCDay();
            if (w && w !== 6 && !festa(d) && ++c >= n) return d;
        }
        return null;
    }
    const g1 = (v) => (Math.round(v * 10) / 10).toLocaleString('it-IT');
    const h1 = (gg) => `${g1(gg * 8)} h`; // giornate -> ore (8 h = 1 giornata)
    const dataIt = (d) => (d ? d.split('-').reverse().join('/') : '');
    const COLORI = ['#4F46E5', '#7C3AED', '#DB2777', '#0891B2', '#059669', '#D97706'];
    const avatar = (n, i) => `<span class="pa-av" style="background:${COLORI[i % COLORI.length]}">${esc(String(n || '?').split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase())}</span>`;

    // Calcolo del piano di un ruolo (stesse regole del prototipo approvato).
    // manuali: chiave persona -> % fissata a mano. Le persone con la % fissata coprono
    // giorni × % × ore; il lavoro che resta si divide tra le altre in base alle ore settimanali.
    function calcolaRuolo(r, nG, fuori, manuali = new Map()) {
        const resto = r.resto;
        const gg = (p) => p.oreSett / 8 / 5;                                   // giornate al giorno della persona
        const chiaveDi = (p) => p.email || p.nominativo;
        const attive = r.persone.filter((p) => !fuori.has(chiaveDi(p)));
        const fisse = attive.filter((p) => manuali.has(chiaveDi(p)));
        const libere = attive.filter((p) => !manuali.has(chiaveDi(p)));
        const ggFisse = fisse.reduce((s, p) => s + (manuali.get(chiaveDi(p)) / 100) * nG * gg(p), 0);
        const restoLibere = Math.max(0, resto - ggFisse);
        const capLibere = libere.reduce((s, p) => s + gg(p), 0);
        const capTot = attive.reduce((s, p) => s + gg(p), 0);
        const piano = r.persone.map((p) => {
            const chiave = chiaveDi(p);
            if (fuori.has(chiave) || !nG || resto <= 0) return { ...p, chiave, perc: 0, gg: 0, ggSett: 0, manuale: false };
            if (manuali.has(chiave)) {
                const perc = manuali.get(chiave);
                const giornate = (perc / 100) * nG * gg(p);
                return { ...p, chiave, gg: giornate, perc, ggSett: (giornate / nG) * 5, manuale: true };
            }
            if (!capLibere || restoLibere <= 0) return { ...p, chiave, perc: 0, gg: 0, ggSett: 0, manuale: false };
            const giornate = restoLibere * (gg(p) / capLibere);                // divisione per ore settimanali
            const perc = Math.ceil(((giornate / (nG * gg(p))) * 100) / 5) * 5;  // arrotondata al 5% superiore
            return { ...p, chiave, gg: giornate, perc, ggSett: (giornate / nG) * 5, manuale: false };
        });
        // Valori dalla % mostrata (arrotondata o scritta a mano): giornate a settimana piena e
        // giornate in tutto fino alla consegna.
        piano.forEach((p) => { if (p.perc > 0 && nG) { p.ggSett = (p.perc / 100) * (p.oreSett / 8); p.gg = (p.perc / 100) * nG * gg(p); } });
        const coperte = piano.reduce((s, p) => s + p.gg, 0);
        const ritmoOggi = r.persone.reduce((s, p) => s + (p.oggiPerc / 100) * gg(p), 0);
        return {
            resto, attive, capTot, piano, coperte,
            ritmoSett: nG ? (resto / nG) * 5 : 0,
            ritmoOggi,
            manuali: fisse.length,
            mancano: Math.max(0, resto - coperte),                              // solo con % fissate troppo basse
            inPiu: Math.max(0, ggFisse - resto),                               // % fissate oltre il necessario
            sovra: piano.filter((p) => p.perc > 0 && (p.ggSett + p.altriGgSett) / (p.oreSett / 8) > 1),
            impossibile: resto > 0.05 && (!attive.length || piano.some((p) => p.perc > 100) || Math.max(0, resto - coperte) > 0.05)
        };
    }

    async function monta(box, { projectId, onApplicato }) {
        let fuori = new Set();
        let dati = null, consegnaScelta = null;
        const manuali = new Map(); // chiave ruolo -> Map(chiave persona -> %)
        const autoScelte = new Set(); // «ruolo|persona» rimesse in automatico: non riprendono la % di oggi
        const manRuolo = (r) => { if (!manuali.has(r.chiave)) manuali.set(r.chiave, new Map()); return manuali.get(r.chiave); };
        async function carica() {
            box.innerHTML = '<div class="pa-card"><div class="pm-attesa"><i class="fas fa-spinner fa-spin"></i> Calcolo il piano…</div></div>';
            try {
                dati = await api(`/capacita/piano?projectId=${encodeURIComponent(projectId)}${consegnaScelta ? `&consegna=${encodeURIComponent(consegnaScelta)}` : ''}`);
                fuori = new Set(dati.ruoli.flatMap((r) => r.persone.filter((p) => p.nelPiano === false).map((p) => p.email || p.nominativo)));
                // Partenza = percentuali già inserite (allocazioni di oggi su questo progetto), scelta
                // dell'utente; chi non è allocato riceve la quota calcolata. Le % già scritte o tolte
                // con «auto» in questa pagina restano (es. cambiando la data di consegna).
                for (const r of dati.ruoli) {
                    const m = manRuolo(r);
                    for (const p of r.persone) {
                        const k = p.email || p.nominativo;
                        if (p.oggiPerc > 0 && !m.has(k) && !autoScelte.has(`${r.chiave}|${k}`)) m.set(k, p.oggiPerc);
                    }
                }
                disegna();
            } catch (e) { box.innerHTML = `<div class="pa-card"><div class="pm-errore"><i class="fas fa-triangle-exclamation"></i> ${esc(e.message)}</div></div>`; }
        }
        function disegna() {
            const d = dati;
            const consegna = d.consegna;
            if (!consegna) {
                box.innerHTML = `<div class="pa-card"><div class="pa-testa"><h2><i class="fas fa-wand-magic-sparkles"></i> Piano automatico</h2></div>
                    <div class="pm-vuoto">Serve la data di consegna: compila il campo End del progetto (o la fine del Gantt)${d.motivo ? ` · ${esc(d.motivo)}` : ''}.</div></div>`;
                return;
            }
            const nG = d.giorni;
            let ok = 0, ko = 0, ggTot = 0;
            const sezioni = d.ruoli.map((r, ir) => {
                const c = calcolaRuolo(r, nG, fuori, manRuolo(r));
                ggTot += c.resto;
                const da = c.resto > 0.05;
                const fattibile = !c.impossibile && !c.sovra.length;
                if (da) { if (fattibile) ok++; else ko++; }
                // Esito in un badge; la spiegazione solo quando c'è qualcosa da fare.
                let badge, nota = '';
                if (!da) badge = '<span class="pa-badge ok"><i class="fas fa-check"></i> Niente da fare</span>';
                else if (!c.attive.length) {
                    badge = '<span class="pa-badge ko"><i class="fas fa-xmark"></i> Nessuno nel piano</span>';
                    nota = `<div class="pa-nota-r ko">${r.persone.length ? 'Accendi «Nel piano» per almeno una persona nelle Persone sul progetto qui sotto.' : 'Nel team del progetto non c\'è nessuno con questo ruolo: aggiungilo nel Team Work della scheda progetto.'}</div>`;
                } else if (c.impossibile && c.mancano > 0.05 && !c.piano.some((p) => p.perc > 100)) {
                    badge = `<span class="pa-badge ko"><i class="fas fa-xmark"></i> Mancano ${g1(c.mancano)} gg</span>`;
                    nota = `<div class="pa-nota-r ko">Con le percentuali che hai fissato copri ${g1(c.coperte)} gg su ${g1(c.resto)} (mancano ${h1(c.mancano)}): alza una percentuale o rimetti «auto».</div>`;
                } else if (c.impossibile) {
                    badge = '<span class="pa-badge ko"><i class="fas fa-xmark"></i> Non basta</span>';
                    nota = `<div class="pa-nota-r ko">Anche al 100% le persone del piano finiscono il <b>${dataIt(dopoGiorni(d.oggi, Math.ceil(c.resto / c.capTot)))}</b>: serve un'altra persona con questo ruolo o spostare la consegna.</div>`;
                } else if (c.sovra.length) {
                    badge = '<span class="pa-badge att"><i class="fas fa-triangle-exclamation"></i> Troppo carico</span>';
                    nota = `<div class="pa-nota-r att">${c.sovra.map((p) => `${esc(p.nominativo)} arriva al <b>${Math.round(((p.ggSett + p.altriGgSett) / (p.oreSett / 8)) * 100)}%</b> con gli altri progetti`).join('; ')}.</div>`;
                } else badge = '<span class="pa-badge ok"><i class="fas fa-check"></i> Fattibile</span>';
                // Allocazioni di oggi: si segnala solo se non bastano.
                if (da && c.attive.length) {
                    const fineOggi = c.ritmoOggi > 0 ? dopoGiorni(d.oggi, Math.ceil(c.resto / c.ritmoOggi)) : null;
                    if (!fineOggi) nota += '<div class="pa-nota-r info"><i class="fas fa-circle-info"></i> Oggi nessuno è allocato: applica il piano per coprire questo lavoro.</div>';
                    else if (fineOggi > consegna) nota += `<div class="pa-nota-r info"><i class="fas fa-circle-info"></i> Con le allocazioni di oggi finiresti il <b>${dataIt(fineOggi)}</b>, dopo la consegna: il piano corregge le percentuali.</div>`;
                }
                const righe = c.piano.filter((p) => !fuori.has(p.chiave)).map((p, i) => {
                    const pctAltri = Math.min(100, (p.altriGgSett / (p.oreSett / 8)) * 100);
                    const pctQui = (p.ggSett / (p.oreSett / 8)) * 100;
                    const tot = pctAltri + pctQui;
                    const tip = `${p.nominativo}: ${g1(p.oreSett)} h/sett · già fatte ${g1(p.fatte)} gg su questo progetto${p.altriGgSett ? ` · altrove ${g1(p.altriGgSett)} gg/sett (${p.altriDett || 'altri progetti'})` : ''}`;
                    return `<tr>
                        <td><div class="pa-pers" title="${esc(tip)}">${avatar(p.nominativo, ir * 3 + i)}${esc(p.nominativo)}<small>${g1(p.oreSett)} h</small></div></td>
                        <td class="n"><span class="pa-op"><span class="oggi" title="Allocazione di oggi">${p.oggiPerc ? `${p.oggiPerc}%` : '—'}</span><i class="fas fa-arrow-right freccia"></i>
                            <span class="pa-perc${p.manuale && p.perc !== p.oggiPerc ? ' man' : ''}"><input type="number" min="0" max="100" step="5" value="${p.perc}" data-pa-perc="${esc(r.chiave)}|${esc(p.chiave)}" title="Percentuale del piano (parte da quella già inserita): cambiala e chi è in automatico si ricalcola" aria-label="Percentuale di ${esc(p.nominativo)}">%</span>${p.manuale ? `<button type="button" class="pa-auto" data-pa-auto="${esc(r.chiave)}|${esc(p.chiave)}" title="Usa la percentuale calcolata da Projexa (divisione automatica del lavoro che resta)"><i class="fas fa-wand-magic-sparkles"></i></button>` : ''}</span></td>
                        <td class="n pa-sett-c">${g1(p.ggSett)} gg <small>· ${h1(p.ggSett)}</small></td>
                        <td><div class="pa-carico" title="Grigio: altri progetti · viola: questo progetto"><div class="pa-barra"><i class="altri" style="width:${pctAltri}%"></i><i class="questo" style="width:${Math.max(0, Math.min(100 - pctAltri, pctQui))}%"></i>${tot > 100 ? '<i class="oltre" style="width:4%"></i>' : ''}</div><span class="${tot > 100 ? 'ko' : ''}">${Math.round(tot)}%</span></div></td>
                    </tr>`;
                }).join('');
                // Settimana per settimana PER PERSONA: % del piano × ore settimanali × giorni
                // lavorativi della settimana (festività e settimane parziali più basse).
                const inPiano = c.piano.filter((p) => !fuori.has(p.chiave) && p.perc > 0);
                const ggPers = (p, s) => (p.perc / 100) * (p.oreSett / 8) * (s.giorni / 5);
                const cella = (v) => `<td class="n">${v > 0.001 ? `<b>${g1(v)}</b><small>${h1(v)}</small>` : '<span class="pa-tenue">—</span>'}</td>`;
                const strip = da && inPiano.length ? `<div class="pa-griglia"><table><thead><tr><th></th>${d.settimane.map((s) => `<th class="n${s.giorni < 5 ? ' fest' : ''}" title="Settimana dal ${dataIt(s.lun)}: ${s.giorni} giorni lavorativi${s.giorni < 5 ? ' (festività o settimana parziale)' : ''}">${dataIt(s.lun).slice(0, 5)}</th>`).join('')}<th class="n">Totale</th></tr></thead><tbody>
                    ${inPiano.map((p, i) => `<tr><td class="chi">${avatar(p.nominativo, ir * 3 + c.piano.indexOf(p))}${esc(p.nominativo)} <small>${p.perc}%</small></td>${d.settimane.map((s) => cella(ggPers(p, s))).join('')}${cella(p.gg)}</tr>`).join('')}
                    <tr class="tot"><td class="chi">Totale piano</td>${d.settimane.map((s) => cella(inPiano.reduce((t, p) => t + ggPers(p, s), 0))).join('')}${cella(c.coperte)}</tr>
                    <tr class="serve"><td class="chi" title="Giornate da pianificare distribuite sui giorni lavorativi fino alla consegna">Serve</td>${d.settimane.map((s) => cella((c.resto / nG) * s.giorni)).join('')}${cella(c.resto)}</tr>
                    </tbody></table></div>` : '';
                return `<section class="pa-ruolo">
                    <div class="pa-rt">
                        <h3>${esc(r.ruolo)}</h3>
                        <span class="num" title="Stima ${g1(r.stima)} − già fatte ${g1(r.consuntivo)}"><b>${g1(c.resto)} gg</b> da fare (${h1(c.resto)})</span>
                        ${da ? `<span class="ritmo" title="Giornate a settimana che servono per consegnare in tempo">${g1(c.ritmoSett)} gg/sett <small>· ${h1(c.ritmoSett)}</small></span>` : ''}
                        <span class="spazio"></span>${badge}
                    </div>
                    ${nota}
                    ${c.attive.length && da ? `<table class="pa-t"><thead><tr><th>Persona</th><th class="n">Oggi → piano</th><th class="n" title="Giornate e ore a settimana con la percentuale del piano">A settimana</th><th class="n" title="Quanto delle sue ore settimanali è occupato: questo progetto (viola) + altri progetti (grigio). Oltre 100% = sovraccarico">Occupata in tutto</th></tr></thead><tbody>${righe}</tbody></table>` : ''}
                    ${strip ? `<details class="pa-sett"><summary><i class="fas fa-chevron-right"></i> Settimana per settimana, per persona</summary>${strip}</details>` : ''}
                </section>`;
            }).join('');
            const diversa = d.consegnaProgetto && consegna !== d.consegnaProgetto;
            const esitoTot = ok + ko ? (ko ? `<span class="pa-badge ko"><i class="fas fa-xmark"></i> ${ko} ruol${ko === 1 ? 'o' : 'i'} da sistemare</span>` : '<span class="pa-badge ok"><i class="fas fa-check"></i> Fattibile</span>') : '';
            box.innerHTML = `<div class="pa-card">
                <div class="pa-testa">
                    <h2><i class="fas fa-wand-magic-sparkles"></i> Piano automatico</h2>
                    <span class="pa-info">Consegna <input type="date" data-pa-consegna value="${esc(consegna)}" min="${esc(d.oggi)}" title="Prova un'altra data: non modifica il progetto">
                        ${diversa ? `<button type="button" class="pa-btn" data-pa-ripristina title="Torna alla data di fine del progetto (${dataIt(d.consegnaProgetto)})"><i class="fas fa-rotate-left"></i></button>` : ''}
                        <span class="sep">·</span> ${nG} giorni lavorativi <span class="sep">·</span> <b>${g1(ggTot)} gg</b> da fare (${h1(ggTot)})</span>
                    ${esitoTot}
                    <span class="spazio"></span>
                    <button type="button" class="pa-btn primario" data-pa-applica ${ok + ko ? '' : 'disabled'} title="Sostituisce le allocazioni di questo progetto da oggi alla consegna con le percentuali del piano"><i class="fas fa-check"></i> Applica il piano</button>
                </div>
                ${d.ruoli.length ? sezioni : '<div class="pm-vuoto">Nessuna giornata da pianificare: mancano i Costi Progetto oppure il consuntivo ha già raggiunto la stima.</div>'}
                <p class="pa-nota">Da consegna, stima e ore già consuntivate (Costi Progetto); ore settimanali dalla Rubrica. Il piano parte dalle percentuali già inserite (allocazioni di oggi); chi non è allocato riceve la sua quota. Le percentuali si cambiano a mano, la bacchetta usa quella calcolata da Projexa; si salvano con «Applica il piano». Le assenze non sono ancora considerate.</p>
            </div>`;
            box.querySelectorAll('[data-pa-perc]').forEach((inp) => inp.addEventListener('change', () => {
                const [rk, pk] = inp.dataset.paPerc.split('|');
                const v = Math.max(0, Math.min(100, Math.round(Number(String(inp.value).replace(',', '.')) || 0)));
                const r = dati.ruoli.find((x) => x.chiave === rk);
                if (r) { manRuolo(r).set(pk, v); autoScelte.delete(`${rk}|${pk}`); }
                disegna();
            }));
            box.querySelectorAll('[data-pa-auto]').forEach((b) => b.addEventListener('click', () => {
                const [rk, pk] = b.dataset.paAuto.split('|');
                const r = dati.ruoli.find((x) => x.chiave === rk);
                if (r) { manRuolo(r).delete(pk); autoScelte.add(`${rk}|${pk}`); }
                disegna();
            }));
            box.querySelector('[data-pa-consegna]').addEventListener('change', (e) => { consegnaScelta = e.target.value || null; carica(); });
            box.querySelector('[data-pa-ripristina]')?.addEventListener('click', () => { consegnaScelta = null; carica(); });
            box.querySelector('[data-pa-applica]')?.addEventListener('click', applica);
        }
        async function applica(e) {
            const d = dati;
            const persone = [];
            for (const r of d.ruoli) {
                const c = calcolaRuolo(r, d.giorni, fuori, manRuolo(r));
                c.piano.forEach((p) => persone.push({ email: p.email, nominativo: p.nominativo, ruolo: p.ruolo, perc: Math.min(100, p.perc) }));
            }
            const conPerc = persone.filter((p) => p.perc > 0);
            if (!confirm(`Applicare il piano fino al ${dataIt(d.consegna)}?\n\n${conPerc.map((p) => `• ${p.nominativo}: ${p.perc}%`).join('\n')}${persone.length > conPerc.length ? `\n\nLe persone fuori dal piano perdono l'allocazione su questo progetto da oggi.` : ''}\n\nLe allocazioni di questo progetto da oggi in poi vengono sostituite.`)) return;
            const btn = e.currentTarget;
            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Applico…';
            try {
                const r = await api('/capacita/piano', { metodo: 'POST', corpo: { projectId, consegna: d.consegna, persone } });
                toast(`Piano applicato: ${r.allocate} allocazion${r.allocate === 1 ? 'e' : 'i'}${r.create ? ` · ${r.create} person${r.create === 1 ? 'a aggiunta' : 'e aggiunte'} alla pianificazione` : ''}`);
                if (onApplicato) onApplicato(); else carica();
            } catch (err) { toast(err.message, 'errore'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Applica il piano'; }
        }
        await carica();
    }

    window.PianoAutomatico = { monta };
})();
