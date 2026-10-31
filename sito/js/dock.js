/*
  DOCK DI NAVIGAZIONE CONDIVISA (stile macOS), per le pagine interne diverse dalla dashboard
  (Portfolio, Capacità, Reporting, Issue, Monitor, Gantt, Cruscotto PM…). Sostituisce i vecchi
  pulsanti «← Dashboard», diversi in ogni pagina. Basta includere lo script:
      <script src="js/dock.js" defer></script>
  - Stesso aspetto della dock di dashboard.html (icone, colori, ingrandimento, rimbalzo), ma
    con classi proprie (.pxdock) per non scontrarsi con il CSS delle pagine.
  - Le voci che sono pagine aprono la pagina; quelle che nella dashboard aprono un pannello
    (Clienti, Progetti clienti, Impostazioni, Registra, Risultati AI) aprono la dashboard con
    ?apri=<voce> e la dashboard apre il pannello (vedi apriDaParametro in dashboard.html).
  - Stesse regole di visibilità della dashboard: preferenze da /api/settings/dashboard-flags
    (data-dash-flag), Database solo admin in locale, Monitor admin PROJEXA o accesso dal server.
  - Le icone sono copiate da dashboard.html: se cambiano lì, vanno aggiornate anche qui.
*/
(function () {
    if (window.__pxDock || window.self !== window.top) return;
    window.__pxDock = true;

    const ICONE = {
        clienti: "<svg class=\"sidebar-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm6.5-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20v-2.5C2 14.5 5.1 12 9 12s7 2.5 7 5.5V20H2Zm15.5 0v-2.5c0-1.7-.7-3.2-1.9-4.4 3.3.1 6.4 1.8 6.4 4.4V20h-4.5Z\"/></svg>",
        reporting: "<svg class=\"sidebar-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M4 20V10h3v10H4Zm6.5 0V4h3v16h-3ZM17 20v-7h3v7h-3Z\"/></svg>",
        issue: "<svg class=\"sidebar-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1.1 15.5h-2.2v-2.2h2.2v2.2Zm0-4.2h-2.2V6.5h2.2v6.8Z\"/></svg>",
        portfolio: "<i class=\"fas fa-layer-group\"></i>",
        capacita: "<i class=\"fas fa-people-group\"></i>",
        progetti: "<svg class=\"sidebar-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M2 5.5C2 4.7 2.7 4 3.5 4h6l2 2h9c.8 0 1.5.7 1.5 1.5v11c0 .8-.7 1.5-1.5 1.5h-17C2.7 20 2 19.3 2 18.5v-13Z\"/></svg>",
        risultati: "<svg class=\"sidebar-icon brand-icon dock-ai-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><g fill=\"none\" stroke=\"#111827\" stroke-width=\"0.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M17.83 12.92L19.90 13.25L21.98 13.58\"/><circle cx=\"22.52\" cy=\"13.67\" r=\"0.55\"/><path d=\"M17.26 14.68L18.46 15.29L19.40 16.38\"/><circle cx=\"19.88\" cy=\"16.66\" r=\"0.55\"/><path d=\"M16.17 16.17L17.66 17.66L19.14 19.14\"/><circle cx=\"19.53\" cy=\"19.53\" r=\"0.55\"/><path d=\"M14.68 17.26L15.29 18.46L16.38 19.40\"/><circle cx=\"16.66\" cy=\"19.88\" r=\"0.55\"/><path d=\"M12.92 17.83L13.25 19.90L13.58 21.98\"/><circle cx=\"13.67\" cy=\"22.52\" r=\"0.55\"/><path d=\"M11.08 17.83L10.87 19.16L10.12 20.39\"/><circle cx=\"10.00\" cy=\"20.93\" r=\"0.55\"/><path d=\"M9.32 17.26L8.37 19.13L7.41 21.00\"/><circle cx=\"7.17\" cy=\"21.49\" r=\"0.55\"/><path d=\"M7.83 16.17L6.87 17.13L6.31 18.45\"/><circle cx=\"5.95\" cy=\"18.86\" r=\"0.55\"/><path d=\"M6.74 14.68L4.87 15.63L3.00 16.59\"/><circle cx=\"2.51\" cy=\"16.83\" r=\"0.55\"/><path d=\"M6.17 12.92L4.84 13.13L3.44 12.81\"/><circle cx=\"2.89\" cy=\"12.86\" r=\"0.55\"/><path d=\"M6.17 11.08L4.10 10.75L2.02 10.42\"/><circle cx=\"1.48\" cy=\"10.33\" r=\"0.55\"/><path d=\"M6.74 9.32L5.54 8.71L4.11 8.59\"/><circle cx=\"3.60\" cy=\"8.37\" r=\"0.55\"/><path d=\"M7.83 7.83L6.34 6.34L4.86 4.86\"/><circle cx=\"4.47\" cy=\"4.47\" r=\"0.55\"/><path d=\"M9.32 6.74L8.71 5.54L8.59 4.11\"/><circle cx=\"8.37\" cy=\"3.60\" r=\"0.55\"/><path d=\"M11.08 6.17L10.75 4.10L10.42 2.02\"/><circle cx=\"10.33\" cy=\"1.48\" r=\"0.55\"/><path d=\"M12.92 6.17L13.13 4.84L12.81 3.44\"/><circle cx=\"12.86\" cy=\"2.89\" r=\"0.55\"/><path d=\"M14.68 6.74L15.63 4.87L16.59 3.00\"/><circle cx=\"16.83\" cy=\"2.51\" r=\"0.55\"/><path d=\"M16.17 7.83L17.13 6.87L18.45 6.31\"/><circle cx=\"18.86\" cy=\"5.95\" r=\"0.55\"/><path d=\"M17.26 9.32L19.13 8.37L21.00 7.41\"/><circle cx=\"21.49\" cy=\"7.17\" r=\"0.55\"/><path d=\"M17.83 11.08L19.16 10.87L20.39 10.12\"/><circle cx=\"20.93\" cy=\"10.00\" r=\"0.55\"/></g><circle cx=\"12\" cy=\"12\" r=\"6.1\" fill=\"#111827\"/><text x=\"12\" y=\"14.35\" text-anchor=\"middle\" font-family=\"Arial, Helvetica, sans-serif\" font-weight=\"700\" font-size=\"6.4\" fill=\"#FFFFFF\">AI</text></svg>",
        database: "<svg class=\"sidebar-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M12 2C6.5 2 3 3.8 3 6v12c0 2.2 3.5 4 9 4s9-1.8 9-4V6c0-2.2-3.5-4-9-4Zm0 2c4.6 0 7 1.4 7 2s-2.4 2-7 2-7-1.4-7-2 2.4-2 7-2Zm0 16c-4.6 0-7-1.4-7-2v-2.7c1.6 1 4 1.7 7 1.7s5.4-.7 7-1.7V18c0 .6-2.4 2-7 2Zm0-5c-4.6 0-7-1.4-7-2v-2.7c1.6 1 4 1.7 7 1.7s5.4-.7 7-1.7V13c0 .6-2.4 2-7 2Z\"/></svg>",
        monitor: "<i class=\"fas fa-gauge-high\"></i>",
        registra: "<svg class=\"sidebar-icon nav-record-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"10.5\" fill=\"none\" stroke=\"#DC2626\" stroke-width=\"1.8\"/><rect x=\"9.6\" y=\"5.6\" width=\"4.8\" height=\"8.2\" rx=\"2.4\" fill=\"#DC2626\"/><path d=\"M7.4 11.4a4.6 4.6 0 0 0 9.2 0\" fill=\"none\" stroke=\"#DC2626\" stroke-width=\"1.6\" stroke-linecap=\"round\"/><path d=\"M12 16v2.4M9.6 18.4h4.8\" stroke=\"#DC2626\" stroke-width=\"1.6\" stroke-linecap=\"round\"/></svg>",
        impostazioni: "<svg class=\"sidebar-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"m19.4 13 .1-1-.1-1 2.1-1.6-2-3.5-2.6 1a8 8 0 0 0-1.7-1L14.8 3h-4l-.4 2.9a8 8 0 0 0-1.7 1l-2.6-1-2 3.5L6.2 11l-.1 1 .1 1-2.1 1.6 2 3.5 2.6-1a8 8 0 0 0 1.7 1l.4 2.9h4l.4-2.9a8 8 0 0 0 1.7-1l2.6 1 2-3.5L19.4 13ZM12.8 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z\"/></svg>"
    };
    const LOGO = '<img class="pxdock-logo" src="Logo_Projexa.png" alt="">';

    // flag: chiave di Impostazioni › Preferenze; spentaAllInizio: nascosta finché le preferenze
    // non dicono il contrario (come class="dash-flag-off" nella dashboard).
    const VOCI = [
        { id: 'dashboard', nome: 'Dashboard', href: 'dashboard.html', icona: LOGO, tile: '#FFFFFF, #E5E7EB' },
        { id: 'clienti', nome: 'Clienti', href: 'dashboard.html?apri=clienti', icona: ICONE.clienti, tile: '#60A5FA, #2563EB' },
        { id: 'reporting', nome: 'Reporting', href: 'reporting.html', icona: ICONE.reporting, tile: '#FDBA74, #EA580C', flag: 'reporting', spentaAllInizio: true },
        { id: 'issue', nome: 'Issue', href: 'issue.html', icona: ICONE.issue, tile: '#FCA5A5, #DC2626', flag: 'issue' },
        { id: 'portfolio', nome: 'Portfolio', href: 'portfolio.html', icona: ICONE.portfolio, tile: '#A5B4FC, #4F46E5' },
        { id: 'capacita', nome: 'Capacità', href: 'capacita.html', icona: ICONE.capacita, tile: '#99F6E4, #0D9488', flag: 'capacita', spentaAllInizio: true },
        { id: 'progetti', nome: 'Progetti clienti', href: 'dashboard.html?apri=progetti', icona: ICONE.progetti, tile: '#FCD34D, #F59E0B' },
        { id: 'risultati', nome: 'Risultati AI', href: 'dashboard.html?apri=risultati-ai', icona: ICONE.risultati, tile: '#FFFFFF, #EEF2F7', grande: true },
        { separatore: true },
        { id: 'database', nome: 'Database', href: 'database-viewer.html', icona: ICONE.database, tile: '#94A3B8, #334155', ruolo: 'database' },
        { id: 'monitor', nome: 'Monitor', href: 'monitor.html', icona: ICONE.monitor, tile: '#64748B, #0F172A', ruolo: 'monitor' },
        { id: 'registra', nome: 'Registra', href: 'dashboard.html?apri=registra', icona: ICONE.registra, tile: '#FFFFFF, #E5E7EB', flag: 'registra' },
        { id: 'impostazioni', nome: 'Impostazioni', href: 'dashboard.html?apri=impostazioni', icona: ICONE.impostazioni, tile: '#D1D5DB, #6B7280' }
    ];

    const CSS = `
        :root { --pxdock-size: 52px; --pxdock-h: 84px; }
        body.pxdock-on { padding-bottom: calc(var(--pxdock-h) + 12px) !important; }
        .pxdock {
            position: fixed; left: 0; right: 0; bottom: 10px; margin: 0 auto; z-index: 780;
            width: max-content; max-width: calc(100vw - 24px);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .pxdock::before {
            content: ''; position: absolute; inset: 0; z-index: -1; border-radius: 20px;
            background: rgba(255, 255, 255, 0.55);
            -webkit-backdrop-filter: blur(22px) saturate(180%); backdrop-filter: blur(22px) saturate(180%);
            border: 1px solid rgba(255, 255, 255, 0.7);
            box-shadow: 0 12px 40px rgba(15, 23, 42, 0.22), 0 1px 3px rgba(15, 23, 42, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.8);
        }
        .pxdock ul { list-style: none; margin: 0; display: flex; flex-direction: row; align-items: flex-end; gap: 6px; padding: 7px 10px 10px; }
        .pxdock li { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; margin: 0; padding: 0; }
        .pxdock li[hidden] { display: none; }
        .pxdock li.pxdock-sep { align-self: stretch; width: 1px; margin: 6px 4px 2px; background: rgba(15, 23, 42, 0.18); }
        .pxdock a {
            --s: 1;
            position: relative; display: flex; align-items: center; justify-content: center;
            width: calc(var(--pxdock-size) * var(--s)); height: calc(var(--pxdock-size) * var(--s));
            border-radius: 23%; text-decoration: none; color: #fff;
            background: linear-gradient(180deg, var(--tile));
            box-shadow: 0 3px 8px rgba(15, 23, 42, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.35);
            transition: width 0.14s ease-out, height 0.14s ease-out, filter 0.15s ease;
        }
        .pxdock a:active { filter: brightness(0.82); }
        .pxdock a:focus-visible { outline: 2px solid #0071e3; outline-offset: 3px; }
        .pxdock a > i, .pxdock a > .sidebar-icon {
            width: 52%; height: 52%; display: flex; align-items: center; justify-content: center;
            font-size: calc(var(--pxdock-size) * var(--s) * 0.46); line-height: 1; fill: currentColor;
            filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.18));
        }
        .pxdock a > .brand-icon { width: 58%; height: 58%; filter: none; }
        .pxdock a > .dock-ai-icon { width: 86%; height: 86%; }
        .pxdock a > .pxdock-logo { width: 74%; height: 74%; object-fit: contain; }
        .pxdock a > span {
            position: absolute; bottom: calc(100% + 12px); left: 50%; transform: translateX(-50%);
            padding: 3px 10px; border-radius: 7px; background: rgba(30, 30, 34, 0.86); color: #fff;
            font-size: 12.5px; font-weight: 500; line-height: 1.5; white-space: nowrap;
            pointer-events: none; opacity: 0; transition: opacity 0.15s ease;
        }
        .pxdock a:hover > span, .pxdock a:focus-visible > span { opacity: 1; }
        .pxdock li::after {
            content: ''; position: absolute; bottom: -7px; left: 50%; width: 4px; height: 4px; margin-left: -2px;
            border-radius: 50%; background: rgba(15, 23, 42, 0.6); opacity: 0;
        }
        .pxdock li.pxdock-sep::after { display: none; }
        .pxdock li.pxdock-attiva::after { opacity: 1; }
        @keyframes pxdockBounce { 0%, 100% { transform: translateY(0); } 30% { transform: translateY(-20px); } 55% { transform: translateY(0); } 75% { transform: translateY(-8px); } }
        .pxdock li.pxdock-bounce > a { animation: pxdockBounce 0.75s cubic-bezier(0.3, 0.7, 0.4, 1); }
        @media (max-width: 700px) { :root { --pxdock-size: 40px; --pxdock-h: 66px; } }
        @media print { .pxdock { display: none; } body.pxdock-on { padding-bottom: 0 !important; } }
        /* Pulsante di ritorno (← Progetto, ← Indietro…): uguale in tutte le pagine */
        .px-back {
            display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto;
            height: 38px; padding: 0 14px; box-sizing: border-box;
            border: 1px solid #e5e5ea; border-radius: 10px; background: #fff;
            color: #1d1d1f; font: inherit; font-size: 0.92rem; font-weight: 500; line-height: 1;
            text-decoration: none; white-space: nowrap; cursor: pointer;
            box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
            transition: background-color 0.15s, border-color 0.15s;
        }
        .px-back:hover { background: #f5f5f7; border-color: #d2d2d7; color: #1d1d1f; text-decoration: none; }
        .px-back:focus-visible { outline: 2px solid #0071e3; outline-offset: 2px; }
        .px-back > i { font-size: 0.85rem; }
    `;

    function claims() {
        const token = localStorage.getItem('authToken');
        if (!token) return {};
        try {
            const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            return JSON.parse(decodeURIComponent(escape(atob(part))));
        } catch (e) { return {}; }
    }
    const intestazioni = () => {
        const token = localStorage.getItem('authToken');
        return token ? { Authorization: `Bearer ${token}` } : {};
    };

    const stile = document.createElement('style');
    stile.textContent = CSS;
    document.head.appendChild(stile);

    function crea() {

        const pagina = (location.pathname.split('/').pop() || '').toLowerCase();
        const nav = document.createElement('nav');
        nav.className = 'pxdock';
        nav.setAttribute('aria-label', 'Navigazione principale');
        nav.innerHTML = '<ul>' + VOCI.map(v => {
            if (v.separatore) return '<li class="pxdock-sep" aria-hidden="true"></li>';
            const attiva = v.href.toLowerCase() === pagina;
            const nascosta = v.spentaAllInizio || v.ruolo;
            return `<li data-voce="${v.id}"${v.flag ? ` data-dash-flag="${v.flag}"` : ''}${attiva ? ' class="pxdock-attiva"' : ''}${nascosta ? ' hidden' : ''}>`
                + `<a href="${v.href}" style="--tile: ${v.tile}"${attiva ? ' aria-current="page"' : ''}>${v.icona}<span>${v.nome}</span></a></li>`;
        }).join('') + '</ul>';
        document.body.appendChild(nav);
        document.body.classList.add('pxdock-on');
        visibilita(nav);
        animazioni(nav);
    }

    // Stesse regole della dashboard (applyDashboardFlags e applyRoleVisibility).
    function visibilita(nav) {
        const voce = id => nav.querySelector(`li[data-voce="${id}"]`);
        fetch(`${location.origin}/api/settings/dashboard-flags`, { headers: intestazioni() })
            .then(r => (r.ok ? r.json() : null))
            .then(flags => {
                if (!flags) return;
                nav.querySelectorAll('li[data-dash-flag]').forEach(li => { li.hidden = flags[li.dataset.dashFlag] === false; });
            })
            .catch(() => {});
        const c = claims();
        const admin = Number(c.id_roles) === 1;
        const locale = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
        voce('database').hidden = !(admin && locale);
        const projexa = String(c.tenant_name || '').trim().toUpperCase() === 'PROJEXA';
        if (admin && projexa) voce('monitor').hidden = false;
        else {
            fetch(`${location.origin}/api/vm-monitor/accesso`, { headers: intestazioni() })
                .then(r => (r.ok ? r.json() : {}))
                .then(d => { if (d.accesso) voce('monitor').hidden = false; })
                .catch(() => {});
        }
    }

    // Ingrandimento "a onda" sotto il mouse e rimbalzo al clic, come in dashboard.html (initDock).
    function animazioni(nav) {
        const ul = nav.querySelector('ul');
        const MAX = 0.75, RAGGIO = 160;
        const riduci = window.matchMedia('(prefers-reduced-motion: reduce)');
        const tiles = () => [...ul.querySelectorAll(':scope > li:not([hidden]) > a')];
        const azzera = () => tiles().forEach(a => a.style.removeProperty('--s'));
        let raf = 0, x = 0;
        ul.addEventListener('mousemove', e => {
            x = e.clientX;
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                if (riduci.matches) return;
                tiles().forEach(a => {
                    const r = a.getBoundingClientRect();
                    const k = Math.max(0, 1 - Math.abs(x - (r.left + r.width / 2)) / RAGGIO);
                    a.style.setProperty('--s', (1 + MAX * Math.sin(k * Math.PI / 2) ** 2).toFixed(3));
                });
            });
        });
        ul.addEventListener('mouseleave', azzera);
        ul.addEventListener('click', e => {
            const a = e.target.closest('a');
            if (!a || riduci.matches) return;
            const li = a.parentElement;
            li.classList.remove('pxdock-bounce');
            void a.offsetWidth;
            li.classList.add('pxdock-bounce');
            azzera();
        });
        ul.addEventListener('animationend', e => e.target.parentElement?.classList.remove('pxdock-bounce'));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', crea);
    else crea();
})();
