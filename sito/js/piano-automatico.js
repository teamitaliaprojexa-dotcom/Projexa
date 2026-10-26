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
        .pa-stato { font-size: 0.76rem; color: #6B7280; display: inline-flex; align-items: center; gap: 0.35rem; }
        .pa-stato .fa-circle-check { color: #059669; } .pa-stato .fa-triangle-exclamation { color: #B45309; }
        .pa-btn:disabled { opacity: .55; cursor: default; }
        .pa-badge { display: inline-flex; align-items: center; gap: 0.3rem; font-weight: 700; font-size: 0.76rem; padding: 0.15rem 0.55rem; border-radius: 999px; white-space: nowrap; }
        .pa-badge.ok { background: #DCFCE7; color: #166534; } .pa-badge.ko { background: #FEE2E2; color: #991B1B; } .pa-badge.att { background: #FEF3C7; color: #92400E; }
        .pa-ruolo { border: 1px solid #EEF0F4; border-radius: 12px; margin-top: 0.6rem; overflow: hidden; }
        .pa-rt { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.8rem; padding: 0.55rem 0.8rem; background: #FAFAFC; border-bottom: 1px solid #EEF0F4; }
        .pa-rt h3 { margin: 0; font-size: 0.92rem; }
        .pa-rt .num { color: #4B5563; }
        .pa-rt .num b { color: #111827; }
        .pa-rt .num .sep { color: #D1D5DB; margin: 0 0.15rem; }
        .pa-avz { padding: 0.55rem 0.8rem 0.5rem; border-bottom: 1px solid #EEF0F4; }
        .pa-avz-barra { position: relative; height: 10px; border-radius: 999px; background: #EEF0F4; }
        .pa-avz-barra i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #34D399, #059669); }
        .pa-avz-barra b { position: absolute; top: -4px; width: 3px; height: 18px; margin-left: -1.5px; border-radius: 2px; background: #0F766E; box-shadow: 0 0 0 2px #fff; }
        .pa-avz-leg { display: flex; flex-wrap: wrap; gap: 0.3rem 1rem; margin-top: 0.4rem; font-size: 0.74rem; color: #6B7280; }
        .pa-avz-leg b { color: #111827; }
        .pa-avz-leg i { display: inline-block; vertical-align: -1px; margin-right: 0.3rem; }
        .pa-avz-leg i.f { width: 10px; height: 10px; border-radius: 3px; background: #10B981; }
        .pa-avz-leg i.c { width: 3px; height: 11px; border-radius: 2px; background: #0F766E; }
        .pa-avz-leg .nota { color: #059669; } .pa-avz-leg .nota.att { color: #B45309; }
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
        .pa-griglia td.c1 { background: #EDE9FE; } .pa-griglia td.c2 { background: #DDD6FE; } .pa-griglia td.c3 { background: #FDE68A; } .pa-griglia td.c4 { background: #FECACA; }
        .pa-griglia td.c4 b { color: #991B1B; }
        .pa-griglia td.chi .fuori { color: #D97706; font-weight: 600; }
        /* Piano dal Gantt: timeline per persona (fasi nelle date + ore della settimana) */
        .tl-wrap { overflow-x: auto; padding: 0.5rem 0.8rem 0.3rem; }
        .tl { min-width: 760px; }
        .tl-riga { display: grid; grid-template-columns: 140px 1fr; gap: 0.6rem; padding: 0.6rem 0; border-bottom: 1px solid #F1F2F6; }
        .tl-testa { padding: 0 0 0.3rem; border-bottom: 1px solid #E9EAF0; align-items: end; }
        .tl-chi-t { font-size: 0.64rem; text-transform: uppercase; letter-spacing: .06em; color: #9CA3AF; font-weight: 700; }
        .tl-mesi { position: relative; height: 1rem; }
        .tl-mesi span { position: absolute; top: 0; font-size: 0.66rem; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: #6D28D9; padding-left: 3px; border-left: 2px solid #DDD6FE; line-height: 1rem; }
        .tl-sett, .tl-ore { display: flex; }
        .tl-sett span { flex: 1; text-align: center; font-size: 0.68rem; color: #9CA3AF; }
        .tl-sett span.fest { color: #D97706; font-weight: 700; }
        .tl-chi { display: flex; align-items: flex-start; gap: 0.4rem; min-width: 0; }
        .tl-chi > div { min-width: 0; line-height: 1.3; }
        .tl-chi b { font-size: 0.8rem; color: #111827; display: block; line-height: 1.2; }
        .tl-chi small { display: block; font-size: 0.66rem; color: #6B7280; }
        .tl-chi small b { display: inline; font-size: inherit; font-weight: 700; }
        .tl-chi .tl-cons { color: #0F766E; } .tl-chi .tl-da { color: #4C1D95; }
        .tl-chi .pa-av { width: 26px; height: 26px; border-radius: 50%; font-size: 0.58rem; }
        .tl-chi .fuori { color: #D97706; font-weight: 600; font-size: 0.68rem; }
        .tl-picco { font-weight: 700; } .tl-picco.ok { color: #6D28D9; } .tl-picco.alto { color: #B45309; } .tl-picco.oltre { color: #DC2626; }
        .tl-somma { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: #EDE9FE; color: #6D28D9; font-size: 0.8rem; flex: none; }
        .tl-track { position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0;
            background-image: repeating-linear-gradient(90deg, transparent 0, transparent calc(100% / var(--n, 16) - 1px), #F3F4F6 calc(100% / var(--n, 16) - 1px), #F3F4F6 calc(100% / var(--n, 16))); }
        .tl-testa .tl-track { background: none; }
        .tl-oggi { position: absolute; top: -4px; bottom: -4px; width: 2px; background: #7C3AED; border-radius: 2px; opacity: .5; z-index: 0; pointer-events: none; }
        .tl-lane { position: relative; height: 24px; }
        .tl-bar { position: absolute; top: 0; height: 24px; border-radius: 7px; background: color-mix(in srgb, var(--c) 14%, #fff); border: 1px solid color-mix(in srgb, var(--c) 35%, #fff); border-left: 4px solid var(--c);
            display: flex; align-items: center; gap: 0.4rem; padding: 0 0.45rem; box-sizing: border-box; overflow: hidden; font-size: 0.72rem; color: color-mix(in srgb, var(--c) 80%, #000); white-space: nowrap; }
        .tl-bar span { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; font-weight: 600; }
        .tl-bar b { font-weight: 800; flex: none; }
        .tl-bar.senzaDate { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--c) 10%, #fff) 0 6px, #fff 6px 12px); border-style: dashed; border-left-style: solid; }
        .tl-bar.inRitardo { border-color: #DC2626; }
        .tl-ore { margin-top: 4px; gap: 2px; }
        .tl-ore span { flex: 1; height: 22px; display: grid; place-items: center; border-radius: 6px; font-size: 0.7rem; font-weight: 700; color: #4C1D95; background: #EDE9FE; }
        .tl-ore span.zero { background: transparent; }
        .tl-ore span.alto { background: #FDE68A; color: #92400E; }
        .tl-ore span.oltre { background: #FCA5A5; color: #7F1D1D; }
        .tl-ore span.tot { background: #E0E7FF; color: #3730A3; }
        .tl-totale { background: #FAF8FF; border-radius: 12px; padding: 0.5rem 0.5rem 0.5rem 0; border-bottom: 0; margin-top: 0.3rem; align-items: center; }
        .tl-totale .tl-chi { padding-left: 0.5rem; align-items: center; }
        .tl-totale .tl-track { background: none; }
        .tl-totale .tl-ore { margin-top: 0; }
        .tl-leg-tratt { background: repeating-linear-gradient(135deg, #DDD6FE 0 3px, #fff 3px 6px) !important; border: 1px dashed #A78BFA; }
        /* Licenze nel piano: linea della licenza, fasi dentro, chi e % di impiego */
        .lc { overflow-x: auto; padding: 0.5rem 0.8rem 0.4rem; }
        .lc-riga { display: grid; grid-template-columns: 170px minmax(640px, 1fr); gap: 0.8rem; padding: 0.55rem 0; border-bottom: 1px solid #F1F2F6; align-items: start; }
        .lc-testa { padding: 0 0 0.2rem; border-bottom: 1px solid #E9EAF0; }
        .lc-mesi { position: relative; height: 1rem; }
        .lc-mesi span { position: absolute; top: 0; font-size: 0.66rem; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: #6D28D9; padding-left: 3px; border-left: 2px solid #DDD6FE; line-height: 1rem; }
        .lc-nome b { display: block; font-size: 0.86rem; color: #111827; line-height: 1.25; }
        .lc-nome small { display: block; font-size: 0.71rem; color: #6B7280; margin-top: 2px; }
        .lc-avz { height: 4px; border-radius: 999px; background: #EEF0F4; margin-top: 5px; overflow: hidden; }
        .lc-avz i { display: block; height: 100%; background: #10B981; }
        .lc-nome .lc-lav b { color: #0F766E; display: inline; font-size: inherit; }
        .lc-consegna { margin-top: 6px; font-size: 0.72rem; color: #4B5563; display: flex; align-items: center; gap: 0.3rem; }
        .lc-consegna i { color: #6D28D9; font-size: 0.68rem; } .lc-consegna b { color: #111827; }
        .lc-consegna.ko b, .lc-consegna.ko i { color: #DC2626; }
        .lc-consegna.nd { color: #9CA3AF; } .lc-consegna.nd i { color: #D1D5DB; }
        .lc-dx { min-width: 0; }
        .lc-track { position: relative; padding-top: 2px; }
        .lc-oggi { position: absolute; top: -2px; bottom: -2px; width: 2px; background: #7C3AED; opacity: .4; border-radius: 2px; z-index: 0; pointer-events: none; }
        .lc-oggi-tacca { position: absolute; top: 1px; width: 2px; height: 13px; margin-left: -1px; background: #7C3AED; border-radius: 2px; z-index: 1; }
        .lc-oggi-tacca span { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); font-size: 0.58rem; font-weight: 800; color: #7C3AED; text-transform: uppercase; letter-spacing: .04em; font-style: normal; }
        .tl-mesi .pa-oggi-t, .lc-mesi .pa-oggi-t { border-left: 0; position: absolute; top: -1px; transform: translateX(-50%); font-size: 0.6rem; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; color: #fff; background: #7C3AED; border-radius: 999px; padding: 0 0.4rem; line-height: 1rem; z-index: 4; white-space: nowrap; }
        .lc-corsia { position: relative; height: 32px; }
        .lc-corsia.su { height: 50px; }
        .lc-barra { position: absolute; top: 11px; height: 10px; border-radius: 999px; background: linear-gradient(90deg, color-mix(in srgb, var(--c) 70%, #fff), var(--c)); box-shadow: 0 1px 3px color-mix(in srgb, var(--c) 35%, transparent); }
        .lc-corsia.su .lc-barra { top: 34px; }
        .lc-filo { position: absolute; top: 15px; width: 18px; height: 0; border-top: 1.5px solid color-mix(in srgb, var(--c) 55%, #fff); }
        .lc-corsia.su .lc-filo { top: 24px; width: 0; height: 10px; border-top: 0; border-left: 1.5px solid color-mix(in srgb, var(--c) 55%, #fff); }
        .lc-etich { position: absolute; top: 3px; display: inline-flex; align-items: center; gap: 0.35rem; white-space: nowrap; height: 24px; padding: 0 0.5rem 0 0.4rem; border-radius: 8px;
            background: #fff; border: 1px solid color-mix(in srgb, var(--c) 30%, #E5E7EB); box-shadow: 0 1px 2px rgba(17, 24, 39, .05); font-size: 0.72rem; color: #374151; z-index: 2; }
        .lc-corsia.su .lc-etich { top: 0; }
        .lc-pallino { width: 8px; height: 8px; border-radius: 50%; background: var(--c); flex: none; }
        .lc-fn { font-weight: 700; color: color-mix(in srgb, var(--c) 80%, #000); }
        .lc-num { color: #6B7280; font-size: 0.69rem; white-space: nowrap; } .lc-num b { color: #111827; font-weight: 800; }
        .lc-num.cons b, .lc-num.cons sup { color: #0F766E; font-weight: 800; }
        .lc-num.da b { color: color-mix(in srgb, var(--c) 85%, #000); } .lc-num.ok { color: #059669; font-weight: 700; }
        .lc-barra i { display: block; height: 100%; border-radius: 999px; background: repeating-linear-gradient(135deg, rgba(255,255,255,.6) 0 3px, rgba(255,255,255,.2) 3px 6px); }
        .lc-date { color: #9CA3AF; font-size: 0.66rem; }
        .lc-corsia.fatto .lc-barra { background: #CBD5E1; box-shadow: none; }
        .lc-corsia.fatto .lc-etich { opacity: .75; }
        .lc-corsia.fatto .lc-etich > b { color: #059669; }
        .lc-corsia.ritardo .lc-barra { outline: 2px solid #FCA5A5; }
        .lc-base { position: relative; height: 26px; }
        .lc-linea { position: absolute; top: 6px; height: 3px; background: #CBD5E1; border-radius: 999px; }
        .lc-linea::before, .lc-linea::after { content: ''; position: absolute; top: -3px; width: 9px; height: 9px; border-radius: 50%; background: #fff; border: 2px solid #94A3B8; box-sizing: border-box; }
        .lc-linea::before { left: -4px; } .lc-linea::after { right: -4px; }
        .lc-d1, .lc-d2 { position: absolute; top: 6px; font-size: 0.62rem; color: #94A3B8; white-space: nowrap; }
        .lc-d1 { left: 0; } .lc-d2 { right: 0; }
        .lc-chi { font-size: 0.64rem; font-weight: 700; color: #374151; background: #fff; border: 1px solid #E5E7EB; border-radius: 999px; padding: 0 0.35rem; line-height: 1.35; flex: none; }
        .lc-chi b { color: #6D28D9; }
        .lc-chi.alto b { color: #B45309; } .lc-chi.oltre { border-color: #FCA5A5; } .lc-chi.oltre b { color: #DC2626; }
        .lc-senza { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; margin-top: 0.3rem; font-size: 0.74rem; }
        .lc-pill { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.15rem 0.5rem; border-radius: 999px; background: color-mix(in srgb, var(--c) 10%, #fff); border: 1px dashed color-mix(in srgb, var(--c) 45%, #fff); color: color-mix(in srgb, var(--c) 80%, #000); font-weight: 600; }
        .lc-pill b { font-weight: 800; }
        .lc-senza .tag { font-size: 0.68rem; font-weight: 700; padding: 0.05rem 0.4rem; border-radius: 999px; background: #FEF3C7; color: #92400E; }
        .pa-avvisi { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.4rem; }
        .pa-segnalazioni { border: 1px solid #FDE68A; border-radius: 10px; background: #FFFBEB; margin-bottom: 0.6rem; }
        .pa-segnalazioni summary { color: #92400E; font-weight: 600; }
        .pa-segnalazioni .pa-avvisi { padding: 0 0.6rem 0.4rem; }
        .pa-avvisi .pa-nota-r { border: 0; border-radius: 8px; }
        .pa-avvisi ul { margin: 0.2rem 0 0; padding-left: 1.1rem; }
        .pa-fasi { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
        .pa-fasi th { text-align: left; font-size: 0.66rem; text-transform: uppercase; letter-spacing: .05em; color: #9CA3AF; padding: 0.3rem 0.6rem; font-weight: 600; border-bottom: 1px solid #F1F5F9; }
        .pa-fasi td { padding: 0.3rem 0.6rem; border-bottom: 1px solid #F5F6F8; vertical-align: top; }
        .pa-fasi td.n { text-align: right; white-space: nowrap; }
        .pa-fasi .fatto { color: #9CA3AF; }
        .pa-fasi .tag { font-size: 0.68rem; font-weight: 700; padding: 0.05rem 0.4rem; border-radius: 999px; background: #F1F5F9; color: #475569; white-space: nowrap; }
        .pa-fasi .tag.att { background: #FEF3C7; color: #92400E; }
        .pa-legenda { display: flex; flex-wrap: wrap; gap: 0.7rem; font-size: 0.7rem; color: #6B7280; padding: 0 0.8rem 0.6rem; }
        .pa-legenda i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 0.25rem; vertical-align: -1px; }
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

    const ultimoAllineo = new Map(); // projectId -> ultimo allineamento automatico (ms)
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
                if (dati.modo === 'gantt') { disegnaGantt(); allineaGantt(); } else disegna();
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
                    nota = `<div class="pa-nota-r ko">${r.persone.length ? 'Accendi «Nel piano» per almeno una persona nelle Persone sul progetto qui sotto.' : 'Nel team del progetto non c\'è nessuno con questo ruolo: aggiungilo nel Team di progetto della scheda progetto.'}</div>`;
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
        // ===== Piano dal Gantt (dati.modo === 'gantt') =====
        // Le ore che restano per ruolo (Costi Progetto) seguono le fasi del Gantt: date,
        // avanzamento e Nominativo. Qui niente % da scrivere: il piano si corregge nel Gantt
        // (date e persone delle attività) e si salva con «Applica il piano» a periodi.
        const FASE_NOME = { analisi: 'Analisi', configurazione: 'Configurazione', formazione: 'Formazione', programmazione: 'Programmazione' };
        // Giornate disponibili della persona in una settimana (ore settimanali, giorni lavorativi).
        const capSett = (p, s) => (p.oreSett / 8) * (s.giorni / 5);
        // Carico della settimana: questo progetto + altri progetti, rispetto alle ore della persona.
        const caricoSett = (p, s) => { const c = capSett(p, s); return c > 0 ? ((p.perSett[s.lun] || 0) + p.altriGgSett * (s.giorni / 5)) / c : 0; };
        function personeUniche(d) { // stessa persona in più ruoli: una riga sola per «Applica»
            const m = new Map();
            for (const r of d.ruoli) for (const p of r.persone) {
                const k = (p.email || p.nominativo).toLowerCase();
                const x = m.get(k) || { ...p, perSett: {} };
                for (const [l, v] of Object.entries(p.perSett)) x.perSett[l] = (x.perSett[l] || 0) + v;
                if (x !== p && x.lavori !== p.lavori) x.lavori = [...(x.lavori || []), ...(p.lavori || [])];
                m.set(k, x);
            }
            return [...m.values()];
        }
        // Periodi di allocazione: % della settimana arrotondata al 5 superiore, settimane
        // consecutive con la stessa % unite in un periodo (dal lunedì, o da oggi, al venerdì).
        function periodiDi(p, d) {
            const out = [];
            for (const s of d.settimane) {
                const gg = p.perSett[s.lun] || 0;
                const perc = gg > 0.001 ? Math.min(100, Math.max(5, Math.ceil(((gg / capSett(p, s)) * 100) / 5) * 5)) : 0;
                const dal = s.lun < d.oggi ? d.oggi : s.lun;
                const al = iso(T(s.lun) + 4 * 86400000);
                const ult = out[out.length - 1];
                if (perc && ult && ult.perc === perc && ult.fineSett === s.lun) { ult.al = al; ult.fineSett = iso(T(s.lun) + 7 * 86400000); }
                else if (perc) out.push({ dal, al, perc, fineSett: iso(T(s.lun) + 7 * 86400000) });
            }
            // Attività della persona che cadono nel periodo: diventano la nota dell'allocazione.
            return out.map(({ dal, al, perc }) => {
                const att = [...new Set((p.lavori || []).filter((l) => l.gg > 0.001 && l.dal && l.al && l.dal <= al && l.al >= dal).map((l) => `${l.nome.replace(/^Modulos+/i, '')} (${FASE_NOME[l.fase] || l.fase})`))];
                return { dal, al, perc, note: `Piano dal Gantt${att.length ? `: ${att.join(', ')}` : ''}`.slice(0, 500) };
            });
        }
        // ===== Licenze nel piano: linea della licenza con le fasi e chi le fa =====
        const COL_FASE = { analisi: '#2563EB', configurazione: '#7C3AED', formazione: '#059669', programmazione: '#D97706' };
        function giorniLav(dal, al) {
            let n = 0;
            for (let t = T(dal), fine = T(al); t <= fine; t += 86400000) { const w = new Date(t).getUTCDay(); if (w && w !== 6 && !festa(iso(t))) n++; }
            return n;
        }
        function licenzeHtml(d) {
            const unita = (v) => (d.aOre ? h1(v) : `${g1(v)} gg`);
            const iniziali = (n) => String(n || '?').split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
            // Ore di ogni persona per fase (dal piano per persona): «nome attività|fase».
            const perFase = new Map();
            for (const r of d.ruoli) for (const p of r.persone) for (const l of (p.lavori || [])) {
                const k = `${l.nome}|${l.fase}`;
                if (!perFase.has(k)) perFase.set(k, new Map());
                const m = perFase.get(k);
                const x = m.get(p.nominativo) || { nominativo: p.nominativo, oreSett: p.oreSett, gg: 0, dal: l.dal, al: l.al };
                x.gg += l.gg;
                m.set(p.nominativo, x);
            }
            // Licenze (modulo del Gantt) con le loro fasi, unendo i ruoli della stessa fase.
            const licenze = new Map();
            for (const f of d.fasi) {
                const lic = f.modulo || f.attivita;
                if (!licenze.has(lic)) licenze.set(lic, { nome: lic, fasi: new Map() });
                const nome = `${f.modulo ? `${f.modulo} › ` : ''}${f.attivita}`;
                const k = `${nome}|${f.fase}`;
                const L = licenze.get(lic);
                const x = L.fasi.get(k) || { chiave: k, attivita: f.attivita, fase: f.fase, inizio: f.inizio, fine: f.fine, avanzamento: f.avanzamento, avviso: f.avviso, daFare: 0, stima: 0, consuntivo: 0, daEffettivo: false, ruoli: [], fonte: f.fonte, persone: new Set() };
                x.daFare += f.daFare; x.stima += f.stima; x.consuntivo += f.consuntivo || 0;
                if (f.consFonte === 'effettivo') x.daEffettivo = true;
                if (f.daFare > 0.001) x.ruoli.push(f.ruolo);
                f.persone.forEach((n) => x.persone.add(n));
                L.fasi.set(k, x);
            }
            if (!licenze.size) return '';
            // Asse comune: dalla prima data delle fasi (o oggi) all'ultima (o alla consegna).
            const date = d.fasi.flatMap((f) => [f.inizio, f.fine]).filter(Boolean);
            let da = [d.oggi, ...date].reduce((m, x) => (x < m ? x : m));
            let a = [d.consegna || d.oggi, ...date].reduce((m, x) => (x > m ? x : m));
            da = iso(T(da) - (((new Date(T(da)).getUTCDay() + 6) % 7) * 86400000)); // dal lunedì
            const giorni = Math.max(7, (T(a) - T(da)) / 86400000 + 1);
            const x = (data) => Math.max(0, Math.min(100, ((T(data) - T(da)) / 86400000 / giorni) * 100));
            const xFine = (data) => Math.max(0, Math.min(100, (((T(data) - T(da)) / 86400000 + 1) / giorni) * 100));
            const mesi = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
            const tacche = [];
            for (let t = T(`${da.slice(0, 7)}-01`); t <= T(a); ) {
                const m = new Date(t); const s = iso(t);
                if (s >= da) tacche.push(`<span style="left:${x(s)}%">${mesi[m.getUTCMonth()]}</span>`);
                t = Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1, 12);
            }
            const oggiX = x(d.oggi);
            const righe = [...licenze.values()].map((L) => {
                const fs = [...L.fasi.values()];
                const datate = fs.filter((f) => f.inizio && f.fine);
                const senza = fs.filter((f) => !(f.inizio && f.fine));
                const daFare = fs.reduce((t, f) => t + f.daFare, 0);
                const stima = fs.reduce((t, f) => t + f.stima, 0);
                const avz = stima > 0 ? Math.min(100, Math.round((fs.reduce((t, f) => t + (f.consuntivo || 0), 0) / stima) * 100)) : 0; // lavorate / stima
                const ini = datate.length ? datate.reduce((m, f) => (f.inizio < m ? f.inizio : m), datate[0].inizio) : null;
                const fin = datate.length ? datate.reduce((m, f) => (f.fine > m ? f.fine : m), datate[0].fine) : null;
                // Una corsia per fase (in ordine di inizio): barra sottile nelle date della fase e
                // etichetta esterna collegata da una linea (a destra della barra, o a sinistra se
                // la barra arriva in fondo, o sopra se la barra occupa quasi tutta la riga).
                const ordinate = [...datate].sort((p, q) => p.inizio.localeCompare(q.inizio) || p.fine.localeCompare(q.fine));
                const chi = (f) => {
                    const m = perFase.get(f.chiave);
                    if (f.daFare <= 0.001 || !m) return [...f.persone].map((n) => `<span class="lc-chi" title="${esc(n)}">${esc(iniziali(n))}</span>`).join('');
                    return [...m.values()].map((p) => {
                        const cap = giorniLav(p.dal, p.al) * (p.oreSett / 8 / 5);
                        const perc = cap > 0 ? Math.round((p.gg / cap) * 100) : 0;
                        return `<span class="lc-chi${perc > 100 ? ' oltre' : perc > 80 ? ' alto' : ''}" title="${esc(`${p.nominativo}: ${unita(p.gg)} dal ${dataIt(p.dal)} al ${dataIt(p.al)} = ${perc}% delle sue ore (${g1(p.oreSett)} h/sett)`)}">${esc(iniziali(p.nominativo))} <b>${perc}%</b></span>`;
                    }).join('');
                };
                // Totale della fase (stima), consuntivo (Effettivo del Gantt o stimato «~») e da fare.
                const numeri = (f) => {
                    const titCons = f.daEffettivo ? 'Ore lavorate = Effettivo scritto nel Gantt'
                        : "Ore lavorate = stima della fase × avanzamento % dell'attività nel Gantt (scrivi l'Effettivo nel Gantt per usare le ore reali)";
                    return `<span class="lc-num" title="Stima della fase (Licenze da attivare)">Tot <b>${esc(unita(f.stima))}</b></span>`
                        + `<span class="lc-num cons" title="${esc(titCons)}">Lavorate <b>${esc(unita(f.consuntivo))}</b></span>`
                        + (f.daFare <= 0.001 ? '<span class="lc-num ok"><i class="fas fa-check"></i> fatto</span>' : `<span class="lc-num da">Da fare <b>${esc(unita(f.daFare))}</b></span>`);
                };
                const corsia = (f) => {
                    const fatto = f.daFare <= 0.001;
                    const tip = `${L.nome} › ${FASE_NOME[f.fase] || f.fase}\n${dataIt(f.inizio)} → ${dataIt(f.fine)} · avanzamento ${f.avanzamento}%\nTotale ${unita(f.stima)} · lavorate ${unita(f.consuntivo)}${f.daEffettivo ? ' (Effettivo del Gantt)' : ' (stima × avanzamento)'} · ${fatto ? 'fatto' : `da fare ${unita(f.daFare)}`}${f.ruoli.length ? ` (${[...new Set(f.ruoli)].join(', ')})` : ''}\nChi: ${[...f.persone].join(', ') || 'nessuno'}${f.fonte === 'team' ? ' (dal team: Nominativo vuoto)' : ''}${f.avviso === 'inRitardo' ? '\nScaduta e non finita' : ''}`;
                    const x1 = x(f.inizio), x2 = Math.max(x1 + 0.8, xFine(f.fine));
                    const lato = x2 <= 62 ? 'dx' : x1 >= 34 ? 'sx' : 'su';
                    const pos = lato === 'dx' ? `left:calc(${x2}% + 18px)` : lato === 'sx' ? `right:calc(${100 - x1}% + 18px)` : `left:${x1}%`;
                    const filo = lato === 'dx' ? `left:${x2}%` : lato === 'sx' ? `right:${100 - x1}%` : `left:calc(${x1}% + 10px)`;
                    return `<div class="lc-corsia ${lato}${fatto ? ' fatto' : ''}${f.avviso === 'inRitardo' ? ' ritardo' : ''}" style="--c:${COL_FASE[f.fase] || '#6B7280'}" title="${esc(tip)}">
                        <div class="lc-barra" style="left:${x1}%;width:${x2 - x1}%" title="${esc(`Lavorate ${unita(f.consuntivo)} su ${unita(f.stima)} di stima`)}"><i style="width:${f.stima > 0 ? Math.min(100, (f.consuntivo / f.stima) * 100) : 0}%"></i></div>
                        <i class="lc-filo" style="${filo}"></i>
                        <div class="lc-etich" style="${pos}"><i class="lc-pallino"></i><span class="lc-fn">${esc(FASE_NOME[f.fase] || f.fase)}</span>${numeri(f)}<span class="lc-date">${dataIt(f.inizio).slice(0, 5)} → ${dataIt(f.fine).slice(0, 5)}</span>${chi(f)}</div>
                    </div>`;
                };
                const traccia = datate.length ? `<div class="lc-track">
                        ${ordinate.map(corsia).join('')}
                        <div class="lc-base"><i class="lc-oggi-tacca" style="left:${oggiX}%" title="Oggi ${dataIt(d.oggi)}"><span>oggi</span></i><div class="lc-linea" style="left:${x(ini)}%;width:${Math.max(1, xFine(fin) - x(ini))}%"><span class="lc-d1">${dataIt(ini).slice(0, 5)}</span><span class="lc-d2">${dataIt(fin).slice(0, 5)}</span></div></div>
                    </div>` : '';
                const senzaHtml = senza.length ? `<div class="lc-senza"><span class="tag att">senza date</span>${senza.map((f) => `<span class="lc-pill" style="--c:${COL_FASE[f.fase] || '#6B7280'}" title="${esc(`${FASE_NOME[f.fase] || f.fase}: ${f.daFare > 0.001 ? `da fare ${unita(f.daFare)}, spalmate fino alla consegna` : 'fatto'}\nChi: ${[...f.persone].join(', ') || 'nessuno'}`)}">${esc(FASE_NOME[f.fase] || f.fase)} ${numeri(f)}${f.daFare > 0.001 ? chi(f) : ''}</span>`).join('')}</div>` : '';
                return `<div class="lc-riga">
                    <div class="lc-nome"><b>${esc(String(L.nome).replace(/^Modulo\s+/i, ''))}</b>
                        <small>${daFare > 0.001 ? `${esc(unita(daFare))} da fare` : 'completata'} · ${avz}%</small>
                        <small class="lc-lav" title="Ore lavorate sulla licenza: per ogni fase l'Effettivo del Gantt se scritto, altrimenti stima × avanzamento % dell'attività nel Gantt">lavorate <b>${esc(unita(fs.reduce((t, f) => t + (f.consuntivo || 0), 0)))}</b> su ${esc(unita(stima))}</small>
                        <div class="lc-avz"><i style="width:${avz}%"></i></div>
                        ${(() => { const c = (d.consegneLicenze || {})[L.nome]; return c ? `<div class="lc-consegna${c.data < d.oggi && avz < 100 ? ' ko' : ''}" title="${c.golive ? 'Data del Go-live della licenza nel Gantt' : 'Ultima data di fine delle attività della licenza nel Gantt (nessun Go-live con data)'}"><i class="fas fa-flag-checkered"></i> Consegna <b>${dataIt(c.data)}</b></div>` : '<div class="lc-consegna nd" title="Nel Gantt la licenza non ha date di fine né Go-live"><i class="fas fa-flag-checkered"></i> Consegna da definire</div>'; })()}</div>
                    <div class="lc-dx">${traccia}${senzaHtml}</div>
                </div>`;
            }).join('');
            return `<div class="lc">
                <div class="lc-riga lc-testa"><div></div><div class="lc-mesi">${tacche.join('')}</div></div>
                ${righe}
                <div class="pa-legenda">${Object.entries(COL_FASE).map(([k, c]) => `<span><i style="background:${c}"></i>${FASE_NOME[k]}</span>`).join('')}<span><i style="background:#7C3AED;width:2px;border-radius:0"></i>oggi</span><span>CP 45% = iniziali della persona e % delle sue ore nel periodo della fase</span></div>
            </div>`;
        }
        function disegnaGantt() {
            const d = dati;
            // Una sola unità in tutta la vista: ore se il progetto è gestito a ore, altrimenti giornate.
            const U = (v) => (d.aOre ? h1(v) : `${g1(v)} gg`);
            // Avanzamento del ruolo = ore lavorate / stima (dal Gantt, il dato giusto). La tacca è il
            // consuntivo Qlik dei Costi Progetto sulla stima venduta, solo per confronto.
            const barraAvanzamento = (r) => {
                if (!(r.stima > 0)) return '';
                const avz = Math.min(100, Math.round(((r.lavorate || 0) / r.stima) * 100));
                const cons = r.stimaCosti > 0 ? Math.min(100, Math.round((r.consuntivo / r.stimaCosti) * 100)) : 0;
                return `<div class="pa-avz" title="Lavorate: ${U(r.lavorate || 0)} su ${U(r.stima)} di stima delle fasi del Gantt. Consuntivo Qlik (Costi Progetto): ${U(r.consuntivo)} su ${U(r.stimaCosti)} venduti">
                    <div class="pa-avz-barra"><i style="width:${avz}%"></i><b style="left:${cons}%"></b></div>
                    <div class="pa-avz-leg"><span><i class="f"></i>Lavorate <b>${avz}%</b></span><span><i class="c"></i>Consuntivo Qlik <b>${cons}%</b> <small>(${U(r.consuntivo)})</small></span>${avz - cons >= 10 ? '<span class="nota">in Qlik ci sono meno ore di quelle lavorate secondo il Gantt</span>' : cons - avz >= 10 ? '<span class="nota att">in Qlik ci sono più ore di quelle lavorate secondo il Gantt</span>' : ''}</div>
                </div>`;
            };
            const av = d.avvisi || {};
            const tot = d.ruoli.reduce((s, r) => s + r.resto, 0);
            let sovra = 0;
            const sezioni = d.ruoli.map((r, ir) => {
                const pers = r.persone;
                const pieni = pers.filter((p) => d.settimane.some((s) => caricoSett(p, s) > 1.001));
                sovra += pieni.length;
                const nonCoperte = Math.max(0, r.resto - r.distribuito);
                let badge = '<span class="pa-badge ok"><i class="fas fa-check"></i> Fattibile</span>';
                let nota = '';
                if (r.resto <= 0.05) badge = '<span class="pa-badge ok"><i class="fas fa-check"></i> Niente da fare</span>';
                else if (!pers.length) badge = '<span class="pa-badge ko"><i class="fas fa-xmark"></i> Nessuno assegnato</span>';
                else if (pieni.length) {
                    badge = '<span class="pa-badge att"><i class="fas fa-triangle-exclamation"></i> Troppo carico</span>';
                    nota = `<div class="pa-nota-r att">${pieni.map((p) => {
                        const sett = d.settimane.filter((s) => caricoSett(p, s) > 1.001);
                        return `${esc(p.nominativo)} supera le sue ore in ${sett.length} settiman${sett.length === 1 ? 'a' : 'e'} (dal ${dataIt(sett[0].lun)}, fino al <b>${Math.round(Math.max(...sett.map((s) => caricoSett(p, s))) * 100)}%</b>)`;
                    }).join('; ')}: sposta le date delle fasi nel Gantt o aggiungi una persona nel Nominativo.</div>`;
                }
                if (r.senzaAttivita) nota += `<div class="pa-nota-r att">Restano ${U(r.resto)} ma tutte le fasi di questo ruolo nel Gantt sono al 100%: aggiorna l'avanzamento o la stima.</div>`;
                else if (nonCoperte > 0.05 && pers.length) nota += `<div class="pa-nota-r info"><i class="fas fa-circle-info"></i> ${U(nonCoperte)} non sono assegnate a nessuno: vedi gli avvisi sopra.</div>`;
                // Timeline per persona: le fasi che fa (barre nelle date usate dal piano, una per
                // riga) e sotto la striscia delle ore settimana per settimana, colorata sul carico
                // (questo progetto + altri progetti rispetto alle sue ore). Ore se il progetto è a ore.
                const unita = (v) => (d.aOre ? h1(v) : `${g1(v)} gg`);
                const oreSettTxt = (v) => { const n = d.aOre ? v * 8 : v; return n < 0.05 ? '<0,1' : (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('it-IT'); };
                const mesi = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
                const nS = d.settimane.length;
                const t0 = T(d.settimane[0].lun);
                const giorniTot = nS * 7;
                const pos = (data) => Math.max(0, Math.min(100, ((T(data) - t0) / 86400000 / giorniTot) * 100));
                const fineX = (data) => Math.max(0, Math.min(100, (((T(data) - t0) / 86400000 + 1) / giorniTot) * 100));
                const oggiX = pos(d.oggi);
                const COL_MOD = ['#6D28D9', '#2563EB', '#0891B2', '#059669', '#DB2777', '#D97706', '#4F46E5', '#0D9488'];
                const moduli = [...new Set(pers.flatMap((p) => (p.lavori || []).map((l) => l.modulo || l.attivita)))];
                const coloreMod = (l) => COL_MOD[Math.max(0, moduli.indexOf(l.modulo || l.attivita)) % COL_MOD.length];
                const livello = (c) => (c > 1.001 ? 'oltre' : c > 0.8 ? 'alto' : c > 0.001 ? 'ok' : 'zero');
                const corto = (s) => String(s || '').replace(/^Modulo\s+/i, '');
                const testa = `<div class="tl-mesi"><span class="pa-oggi-t" style="left:${oggiX}%">oggi ${dataIt(d.oggi).slice(0, 5)}</span>${d.settimane.map((s, i) => (i === 0 || s.lun.slice(5, 7) !== d.settimane[i - 1].lun.slice(5, 7))
                    ? `<span style="left:${(i / nS) * 100}%">${mesi[Number(s.lun.slice(5, 7)) - 1]}</span>` : '').join('')}</div>
                    <div class="tl-sett">${d.settimane.map((s) => `<span class="${s.giorni < 5 ? 'fest' : ''}" title="Settimana dal ${dataIt(s.lun)}: ${s.giorni} giorni lavorativi">${Number(s.lun.slice(8, 10))}</span>`).join('')}</div>`;
                const striscia = (p) => `<div class="tl-ore">${d.settimane.map((s) => {
                    const v = p.perSett[s.lun] || 0;
                    const c = caricoSett(p, s);
                    const tip = `${p.nominativo} · settimana dal ${dataIt(s.lun)}\nQuesto progetto: ${unita(v)}${p.altriGgSett ? `\nAltri progetti: ${unita(p.altriGgSett * (s.giorni / 5))}` : ''}\nDisponibili: ${unita(capSett(p, s))} · occupata al ${Math.round(c * 100)}%`;
                    return `<span class="${v > 0.001 ? livello(c) : 'zero'}" title="${esc(tip)}">${v > 0.001 ? oreSettTxt(v) : ''}</span>`;
                }).join('')}</div>`;
                const righePers = pers.map((p, i) => {
                    const carichi = d.settimane.map((s) => caricoSett(p, s));
                    const picco = Math.max(0, ...carichi);
                    const sPicco = d.settimane[carichi.indexOf(picco)];
                    const tutti = (p.lavori || []).filter((l) => l.dal && l.al && l.gg > 0.001);
                    // Le fasi senza date non hanno barra: sono già nelle Segnalazioni (le ore restano nella striscia).
                    const lavori = tutti.filter((l) => l.avviso !== 'senzaDate');
                    // Una corsia per fase: barra sottile nelle date e etichetta esterna collegata da
                    // una linea (a destra, a sinistra se la barra arriva in fondo, sopra se è lunga).
                    const barre = [...lavori].sort((a2, b2) => a2.dal.localeCompare(b2.dal) || a2.al.localeCompare(b2.al)).map((l) => {
                        const x1 = pos(l.dal), x2 = Math.max(x1 + 0.8, fineX(l.al));
                        const nota = l.avviso === 'inRitardo' ? ' (scaduta: nei prossimi giorni)' : '';
                        const tip = `${l.nome} · ${FASE_NOME[l.fase] || l.fase}\n${dataIt(l.dal)} → ${dataIt(l.al)}${nota}\n${unita(l.gg)} a carico di ${p.nominativo}`;
                        const lato = x2 <= 62 ? 'dx' : x1 >= 34 ? 'sx' : 'su';
                        const posE = lato === 'dx' ? `left:calc(${x2}% + 18px)` : lato === 'sx' ? `right:calc(${100 - x1}% + 18px)` : `left:${x1}%`;
                        const filo = lato === 'dx' ? `left:${x2}%` : lato === 'sx' ? `right:${100 - x1}%` : `left:calc(${x1}% + 10px)`;
                        return `<div class="lc-corsia ${lato}${l.avviso === 'inRitardo' ? ' ritardo' : ''}" style="--c:${coloreMod(l)}" title="${esc(tip)}">
                            <div class="lc-barra" style="left:${x1}%;width:${x2 - x1}%"></div>
                            <i class="lc-filo" style="${filo}"></i>
                            <div class="lc-etich" style="${posE}"><i class="lc-pallino"></i><span class="lc-fn">${esc(corto(l.modulo) || l.attivita)}${l.modulo ? ` › ${esc(l.attivita)}` : ''}</span><span class="lc-num"><b>${esc(unita(l.gg))}</b></span><span class="lc-date">${dataIt(l.dal).slice(0, 5)} → ${dataIt(l.al).slice(0, 5)}</span></div>
                        </div>`;
                    }).join('');
                    const info = `${p.nominativo}: ${g1(p.oreSett)} h/sett${p.altriGgSett ? ` · altrove ${U(p.altriGgSett)}/sett (${p.altriDett || 'altri progetti'})` : ''}`;
                    return `<div class="tl-riga">
                        <div class="tl-chi" title="${esc(info)}">${avatar(p.nominativo, ir * 3 + i)}<div><b>${esc(p.nominativo)}</b>${p.fuoriTeam ? ' <span class="fuori" title="Scritto nel Nominativo del Gantt ma non nel team del progetto: ore settimanali di default">fuori team</span>' : ''}
                            <small>${g1(p.oreSett)} h/sett</small>
                            <small title="Ore già consuntivate da ${esc(p.nominativo)} su questo progetto (team del progetto, ore Qlik)">consuntivo <b class="tl-cons">${unita(p.fatte || 0)}</b></small>
                            <small title="Ore da fare a suo carico nel piano">da fare <b class="tl-da">${unita(p.totale)}</b></small>
                            ${picco > 0 ? `<small>picco <span class="tl-picco ${livello(picco)}">${Math.round(picco * 100)}%</span>${sPicco ? ` sett. ${dataIt(sPicco.lun).slice(0, 5)}` : ''}</small>` : ''}</div></div>
                        <div class="tl-track"><i class="tl-oggi" style="left:${oggiX}%"></i>${barre || '<div class="tl-lane"></div>'}${striscia(p)}</div>
                    </div>`;
                }).join('');
                const totSett = d.settimane.map((s) => pers.reduce((t, p) => t + (p.perSett[s.lun] || 0), 0));
                const rigaTot = `<div class="tl-riga tl-totale">
                    <div class="tl-chi"><span class="tl-somma"><i class="fas fa-layer-group"></i></span><div><b>Totale ruolo</b><small>${unita(r.distribuito)} · ${pers.length} person${pers.length === 1 ? 'a' : 'e'}</small></div></div>
                    <div class="tl-track"><div class="tl-ore">${totSett.map((v, i) => `<span class="${v > 0.001 ? 'tot' : 'zero'}" title="Settimana dal ${dataIt(d.settimane[i].lun)}: ${unita(v)}">${v > 0.001 ? oreSettTxt(v) : ''}</span>`).join('')}</div></div>
                </div>`;
                const griglia = pers.length ? `<div class="tl-wrap"><div class="tl" style="--n:${nS}">
                    <div class="tl-riga tl-testa"><div class="tl-chi-t">Persona</div><div class="tl-track">${testa}</div></div>
                    ${righePers}${rigaTot}
                    </div></div>
                    <div class="pa-legenda"><span><i style="background:#7C3AED"></i>fase del Gantt (un colore per modulo)</span><span><i style="background:#EDE9FE"></i>${d.aOre ? 'ore' : 'giornate'} della settimana</span><span><i style="background:#FDE68A"></i>oltre l'80% delle sue ore</span><span><i style="background:#FCA5A5"></i>oltre le sue ore (con gli altri progetti)</span><span><i style="background:#7C3AED;width:2px;border-radius:0"></i>oggi</span></div>` : '';
                return `<section class="pa-ruolo">
                    <div class="pa-rt">
                        <h3>${esc(r.ruolo)}</h3>
                        <span class="num" title="Dalle fasi del Gantt: lavorate = Effettivo o stima × avanzamento %, da fare = stima − lavorate">Stima <b>${U(r.stima)}</b> <span class="sep">·</span> Lavorate <b>${U(r.lavorate || 0)}</b> <span class="sep">·</span> <b>${U(r.resto)}</b> da fare</span>
                        <span class="spazio"></span>${badge}
                    </div>
                    ${barraAvanzamento(r)}
                    ${nota}${griglia}
                </section>`;
            }).join('');
            // Avvisi sul Gantt: cosa sistemare perché il piano sia preciso.
            const elenco = (l) => `<ul>${l.slice(0, 12).map((x) => `<li>${esc(x)}</li>`).join('')}${l.length > 12 ? `<li>… e altre ${l.length - 12}</li>` : ''}</ul>`;
            const avvisi = [
                av.senzaDate?.length ? `<div class="pa-nota-r att"><i class="fas fa-calendar-xmark"></i> <b>${av.senzaDate.length} fasi senza date</b>: le loro ore sono spalmate da oggi alla consegna. Metti Data inizio e Data fine nel Gantt.${elenco(av.senzaDate)}</div>` : '',
                av.inRitardo?.length ? `<div class="pa-nota-r ko"><i class="fas fa-clock"></i> <b>${av.inRitardo.length} fasi scadute e non finite</b>: le loro ore sono nei prossimi 5 giorni lavorativi. Aggiorna date o avanzamento nel Gantt.${elenco(av.inRitardo)}</div>` : '',
                av.senzaPersone?.length ? `<div class="pa-nota-r ko"><i class="fas fa-user-slash"></i> <b>Nessuno per queste fasi</b>: compila il Nominativo nel Gantt o aggiungi al team una persona con quel ruolo.${elenco(av.senzaPersone)}</div>` : '',
                av.fuoriTeam?.length ? `<div class="pa-nota-r att"><i class="fas fa-user-plus"></i> Nel Nominativo del Gantt ma non nel team del progetto: ${esc(av.fuoriTeam.join(', '))}. Aggiungile al team per usare le loro ore settimanali.</div>` : '',
                av.senzaRuolo?.length ? `<div class="pa-nota-r att"><i class="fas fa-circle-question"></i> Fasi che nei Costi Progetto nessun ruolo fa (colonna della fase vuota): non entrano nel piano.${elenco(av.senzaRuolo)}</div>` : '',
                (d.chiusi || []).length ? `<div class="pa-nota-r info"><i class="fas fa-lock"></i> Fuori dal piano perché già tutto consuntivato in Qlik: ${d.chiusi.map((x) => `${esc(x.ruolo)} (${U(x.consuntivo)} su ${U(x.stima)} vendute)`).join(', ')}. Le loro fasi vanno agli altri ruoli.</div>` : '',
                (d.esclusi || []).length ? `<div class="pa-nota-r info"><i class="fas fa-circle-info"></i> Fuori dal piano (nei Costi Progetto non hanno Analisi, Configurazione, Formazione o Programmazione): ${d.esclusi.map((x) => `${esc(x.ruolo)} ${U(x.resto)}`).join(', ')}.</div>` : ''
            ].filter(Boolean);
            // Fasi del Gantt usate dal piano, per licenza: una linea con le date della licenza
            // (dalla prima all'ultima fase), dentro le fasi (Analisi, Configurazione…) nelle loro
            // date e dentro ogni fase chi la fa con la % di impiego (ore a suo carico rispetto
            // alle sue ore nel periodo della fase, da oggi in poi).
            const fasi = licenzeHtml(d);
            const diversa = d.consegnaProgetto && d.consegna !== d.consegnaProgetto;
            box.innerHTML = `<div class="pa-card">
                <div class="pa-testa">
                    <h2><i class="fas fa-wand-magic-sparkles"></i> Piano dal Gantt</h2>
                    <span class="pa-info">Consegna <input type="date" data-pa-consegna value="${esc(d.consegna || '')}" min="${esc(d.oggi)}" title="Vale per le fasi senza date: prova un'altra data, non modifica il progetto">
                        ${diversa ? `<button type="button" class="pa-btn" data-pa-ripristina title="Torna alla data di fine del progetto (${dataIt(d.consegnaProgetto)})"><i class="fas fa-rotate-left"></i></button>` : ''}
                        <span class="sep">·</span> <b>${U(tot)}</b> da fare</span>
                    ${sovra ? `<span class="pa-badge att"><i class="fas fa-triangle-exclamation"></i> ${sovra} person${sovra === 1 ? 'a' : 'e'} oltre le ore</span>` : (tot > 0.05 ? '<span class="pa-badge ok"><i class="fas fa-check"></i> Fattibile</span>' : '')}
                    <span class="spazio"></span>
                    <span class="pa-stato" data-pa-stato title="Le allocazioni delle persone su questo progetto si aggiornano da sole quando il piano cambia"><i class="fas fa-spinner fa-spin"></i> Controllo le allocazioni…</span>
                </div>
                ${avvisi.length ? `<details class="pa-sett pa-segnalazioni"><summary><i class="fas fa-chevron-right"></i> Segnalazioni (${avvisi.length})</summary><div class="pa-avvisi">${avvisi.join('')}</div></details>` : ''}
                ${d.ruoli.length ? sezioni : '<div class="pm-vuoto">Niente da pianificare: il consuntivo ha già raggiunto la stima.</div>'}
                ${fasi ? `<details class="pa-sett" open><summary><i class="fas fa-chevron-right"></i> Licenze e fasi del Gantt nel piano</summary>${fasi}</details>` : ''}
                <p class="pa-nota">Ore da fare per ruolo = Stima − Consuntivo dei Costi Progetto, ripartite sulle fasi del Gantt (Analisi, Configurazione, Formazione, Programmazione di ogni licenza) in base all'effort e alla parte non ancora fatta (avanzamento), nelle date di ogni fase. Le fanno le persone del Nominativo dell'attività (Responsabile Interno), altrimenti il team del progetto con quel ruolo, divise in base alle ore settimanali della Rubrica. Per cambiare il piano modifica date, avanzamento e Nominativo nel Gantt. Le assenze non sono ancora considerate.</p>
            </div>`;
            box.querySelector('[data-pa-consegna]').addEventListener('change', (e) => { consegnaScelta = e.target.value || null; carica(); });
            box.querySelector('[data-pa-ripristina]')?.addEventListener('click', () => { consegnaScelta = null; carica(); });
        }
        // Piano dal Gantt: niente pulsante, le allocazioni del progetto si allineano da sole al
        // piano ogni volta che si apre la scheda Risorse. Si scrive solo per le persone le cui
        // allocazioni (da oggi in poi) sono diverse dai periodi del piano; al massimo una volta al
        // minuto per progetto, così un ricaricamento non entra in ciclo.
        async function allineaGantt() {
            const d = dati;
            const stato = (html) => { const el = box.querySelector('[data-pa-stato]'); if (el) el.innerHTML = html; };
            const chiave = (l) => l.map((x) => `${x.dal}|${x.al}|${x.perc}|${x.note || ''}`).sort().join(';');
            const persone = personeUniche(d).map((p) => {
                const periodi = periodiDi(p, d);
                return { email: p.email, nominativo: p.nominativo, ruolo: p.ruolo, perc: periodi.reduce((m, x) => Math.max(m, x.perc), 0), periodi, salvate: (p.allocazioni || []).filter((a) => a.al >= d.oggi) };
            }).filter((p) => p.periodi.length);
            const diverse = persone.filter((p) => chiave(p.periodi) !== chiave(p.salvate.map((a) => ({ dal: a.dal < d.oggi ? d.oggi : a.dal, al: a.al, perc: a.perc, note: a.note }))));
            if (!diverse.length) { stato('<i class="fas fa-circle-check"></i> Allocazioni allineate al piano'); return; }
            const ultimo = ultimoAllineo.get(projectId) || 0;
            if (Date.now() - ultimo < 60000) { stato('<i class="fas fa-circle-info"></i> Allocazioni da riallineare: riapri la scheda tra poco'); return; }
            ultimoAllineo.set(projectId, Date.now());
            stato('<i class="fas fa-spinner fa-spin"></i> Aggiorno le allocazioni…');
            try {
                await api('/capacita/piano', { metodo: 'POST', corpo: { projectId, consegna: d.consegna || d.oggi, persone: diverse.map(({ salvate, ...p }) => p) } });
                toast(`Allocazioni aggiornate dal piano: ${diverse.map((p) => p.nominativo).join(', ')}`);
                if (onApplicato) onApplicato(); else carica();
            } catch (err) {
                stato(`<i class="fas fa-triangle-exclamation"></i> Allocazioni non aggiornate: ${esc(err.message)}`);
            }
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
