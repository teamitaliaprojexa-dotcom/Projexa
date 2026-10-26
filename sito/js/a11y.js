// Accessibilità della dashboard (WCAG 2.2 AA): comportamenti comuni a tutta la pagina,
// applicati anche agli elementi creati dinamicamente (MutationObserver).
// - finestre modali: focus iniziale, focus intrappolato, Esc, ritorno del focus al pulsante
// - annunci per gli screen reader (window.a11yAnnuncia, usato da showNotification)
// - nomi accessibili: icone decorative nascoste, pulsanti solo icona, etichette dei campi
// - voci cliccabili dei flyout raggiungibili da tastiera, dock con aria-expanded
// - riordino dei campi anche da tastiera (Alt+frecce) in alternativa al trascinamento
// - grafici Chart.js con aria-label e tabella dei dati
(function () {
    'use strict';

    // === ANNUNCI ===
    // Svuota e riscrive la regione live (con un attimo di pausa) così lo stesso testo
    // ripetuto viene annunciato di nuovo.
    function annuncia(testo, urgente) {
        const el = document.getElementById(urgente ? 'srAvvisi' : 'srAnnunci');
        if (!el || !testo) return;
        el.textContent = '';
        setTimeout(() => { el.textContent = String(testo); }, 60);
    }
    window.a11yAnnuncia = annuncia;

    // === UTILITÀ ===
    const FOCUSABILI = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

    function visibile(el) {
        if (!el || !el.isConnected || !el.getClientRects().length) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
    }

    function focusabiliIn(box) {
        return [...box.querySelectorAll(FOCUSABILI)].filter(el => visibile(el) && !el.closest('[inert]'));
    }

    function haNome(el) {
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
        if (el.labels && el.labels.length) return true;
        return false;
    }

    // Testo fatto solo di simboli (‹ ✕ × ✎ ⟲…): non è un nome comprensibile.
    function soloSimboli(testo) {
        return testo.length > 0 && testo.length <= 3 && !/[\p{L}\p{N}]/u.test(testo);
    }

    // Elementi che corrispondono al selettore: la radice stessa (nodo appena aggiunto) e i discendenti.
    function trova(root, sel) {
        const lista = [...root.querySelectorAll(sel)];
        if (root.matches && root.matches(sel)) lista.unshift(root);
        return lista;
    }

    // === NOMI ACCESSIBILI ED ETICHETTE ===
    function sistemaNomi(root) {
        if (!root || !root.querySelectorAll) return;

        // Icone Font Awesome: decorative (il testo o l'aria-label del pulsante danno il nome).
        trova(root,'i[class*="fa-"]:not([aria-hidden])').forEach(i => i.setAttribute('aria-hidden', 'true'));

        // Pulsanti e link solo icona (o con un simbolo): il title diventa il nome.
        trova(root,'button[title], a[title], [role="button"][title]').forEach(b => {
            if (b.getAttribute('aria-label') || b.getAttribute('aria-labelledby')) return;
            const testo = (b.textContent || '').trim();
            if (!testo || soloSimboli(testo)) b.setAttribute('aria-label', b.getAttribute('title'));
        });

        // <label> senza "for" seguita dal campo: la collega al campo.
        trova(root,'label:not([for])').forEach(label => {
            if (label.querySelector('input, select, textarea')) return;
            const campo = label.nextElementSibling;
            if (!campo || !campo.matches('input, select, textarea')) return;
            if (campo.labels && campo.labels.length) return;
            if (!campo.id) campo.id = 'a11yCampo' + (++contatoreId);
            label.htmlFor = campo.id;
        });

        // Campi senza etichetta: nome dal placeholder o dal title.
        trova(root,'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), select, textarea').forEach(campo => {
            if (haNome(campo)) return;
            const nome = campo.getAttribute('placeholder') || campo.getAttribute('title');
            if (nome) campo.setAttribute('aria-label', nome);
        });

        // Voci cliccabili dei flyout (Clienti, Progetti clienti, Impostazioni) e comandi a
        // forma di <span>: diventano raggiungibili con Tab e attivabili con Invio/Spazio.
        trova(root,'.settings-flyout li[data-client-id], .settings-flyout li[data-argument]:not(.arg-inline), .settings-flyout li.flyout-group-head, .settings-detail-flyout .settings-detail-link, .arg-del, .arg-ren').forEach(el => {
            if (el.hasAttribute('tabindex')) return;
            el.tabIndex = 0;
            el.setAttribute('role', 'button');
            el.dataset.a11yClick = '1';
            if (el.classList.contains('arg-del')) el.setAttribute('aria-label', 'Elimina ' + (el.dataset.argument || ''));
            if (el.classList.contains('arg-ren')) el.setAttribute('aria-label', 'Rinomina ' + (el.dataset.argument || ''));
        });

        // Righe da riordinare (trascinamento): anche con Alt+frecce.
        trova(root,'.linked-reorder-row, #settingsDetailList [data-row-id][draggable="true"]').forEach(el => {
            if (el.dataset.a11yRiordina) return;
            el.dataset.a11yRiordina = '1';
            if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
            el.setAttribute('aria-roledescription', 'elemento riordinabile');
            el.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
            if (!el.title) el.title = 'Alt+freccia su/giù per spostare';
        });
    }
    let contatoreId = 0;

    // Invio/Spazio sulle voci rese focusabili qui sopra; Spazio sui link usati come pulsanti.
    document.addEventListener('keydown', (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if ((e.key === 'Enter' || e.key === ' ') && t.dataset.a11yClick === '1') {
            e.preventDefault();
            t.click();
            return;
        }
        if (e.key === ' ' && t.matches('a[role="button"]')) {
            e.preventDefault();
            t.click();
        }
    });

    // === RIORDINO DA TASTIERA (WCAG 2.5.7) ===
    document.addEventListener('keydown', (e) => {
        const el = e.target;
        if (!(el instanceof Element) || el.dataset.a11yRiordina !== '1' || !e.altKey) return;
        const su = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
        const giu = e.key === 'ArrowDown' || e.key === 'ArrowRight';
        if (!su && !giu) return;
        e.preventDefault();
        const linked = el.classList.contains('linked-reorder-row');
        const box = linked ? el.parentElement : document.getElementById('settingsDetailList');
        if (!box) return;
        const elenco = [...box.querySelectorAll(linked ? '.linked-reorder-row' : '[data-row-id][draggable="true"]')];
        const i = elenco.indexOf(el);
        const vicino = elenco[su ? i - 1 : i + 1];
        if (!vicino) return;
        if (su) vicino.before(el); else vicino.after(el);
        el.focus();
        if (!linked) {
            // Stesso effetto della fine di un trascinamento: disposizione da salvare.
            try { detailLayoutDirty = true; } catch (_) { /* variabile non presente */ }
            const sb = document.getElementById('settingsDetailSaveBar');
            if (sb) sb.style.display = 'block';
        }
        annuncia(`Spostato in posizione ${elenco.indexOf(vicino) + 1} di ${elenco.length}`);
    });

    // === FINESTRE MODALI ===
    const SEL_DIALOG = '[role="dialog"][aria-modal="true"]';
    const aperte = new Map(); // dialog -> elemento che aveva il focus prima dell'apertura

    function dialogAperte() {
        // pointer-events: none = overlay non ancora aperto (es. il form centrale durante la misura).
        return [...document.querySelectorAll(SEL_DIALOG)].filter(d => visibile(d) && getComputedStyle(d).pointerEvents !== 'none');
    }

    // La finestra in primo piano: z-index più alto, a parità l'ultima nel documento.
    function inPrimoPiano() {
        const lista = dialogAperte();
        if (!lista.length) return null;
        const z = el => parseInt(getComputedStyle(el).zIndex, 10) || 0;
        return lista.reduce((a, b) => (z(b) >= z(a) ? b : a));
    }

    function aggiornaDialog() {
        const ora = new Set(dialogAperte());
        // Appena aperte: ricordano chi aveva il focus e lo spostano dentro.
        ora.forEach(d => {
            if (aperte.has(d)) return;
            const prima = document.activeElement;
            aperte.set(d, prima && prima !== document.body ? prima : null);
            // Dopo il codice che l'ha aperta (che a volte mette già il focus su un campo).
            setTimeout(() => {
                if (!visibile(d) || d.contains(document.activeElement)) return;
                const campi = focusabiliIn(d);
                const primo = campi.find(el => el.matches('input, select, textarea, [contenteditable="true"]')) || campi[0];
                if (primo) primo.focus();
                else { d.tabIndex = -1; d.focus(); }
            }, 50);
        });
        // Appena chiuse: il focus torna dove era.
        [...aperte.keys()].forEach(d => {
            if (ora.has(d)) return;
            const prima = aperte.get(d);
            aperte.delete(d);
            const perso = !document.activeElement || document.activeElement === document.body || d.contains(document.activeElement);
            if (perso && prima && visibile(prima)) prima.focus();
        });
    }

    // Tab e Maiusc+Tab restano dentro la finestra in primo piano.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const d = inPrimoPiano();
        if (!d) return;
        const campi = focusabiliIn(d);
        if (!campi.length) { e.preventDefault(); return; }
        const primo = campi[0], ultimo = campi[campi.length - 1];
        const att = document.activeElement;
        if (!d.contains(att)) { e.preventDefault(); (e.shiftKey ? ultimo : primo).focus(); }
        else if (e.shiftKey && att === primo) { e.preventDefault(); ultimo.focus(); }
        else if (!e.shiftKey && att === ultimo) { e.preventDefault(); primo.focus(); }
    }, true);

    // Esc: se la finestra in primo piano non ha già un suo gestore, la chiude con il suo
    // pulsante Chiudi/Annulla (così passa dalla logica della pagina, conferme comprese).
    let dialogEsc = null;
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') dialogEsc = inPrimoPiano(); }, true);
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        const d = dialogEsc;
        dialogEsc = null;
        if (!d || !visibile(d)) return; // chiusa dal gestore della pagina
        const chiudi = d.querySelector('[aria-label="Chiudi"], [id$="Close"], [id$="Cancel"], [id$="Annulla"], [id$="No"], [data-outlook-method=""]')
            || [...d.querySelectorAll('button')].find(b => /^(annulla|chiudi)$/i.test((b.textContent || '').trim()));
        if (chiudi && visibile(chiudi)) chiudi.click();
    });

    // === DOCK, FLYOUT E PANNELLI A COMPARSA ===
    function preparaDock() {
        const menu = document.querySelector('.sidebar-menu');
        if (!menu) return;
        menu.querySelectorAll(':scope > li > a[href="#"]').forEach(a => a.setAttribute('role', 'button'));
        [['nav-clients', 'flyoutClienti'], ['nav-projects', 'flyoutProgetti'], ['nav-settings', 'flyoutImpostazioni']].forEach(([cls, id]) => {
            const li = menu.querySelector(':scope > li.' + cls);
            const fly = li && li.querySelector(':scope > .settings-flyout');
            const a = li && li.querySelector(':scope > a');
            if (!fly || !a) return;
            fly.id = fly.id || id;
            a.setAttribute('aria-haspopup', 'true');
            a.setAttribute('aria-controls', fly.id);
            a.setAttribute('aria-expanded', 'false');
        });
    }

    // aria-expanded segue la visibilità del pannello controllato; i flyout del dock
    // spostano il focus dentro all'apertura e lo restituiscono alla chiusura.
    function aggiornaEspansi() {
        document.querySelectorAll('[aria-expanded][aria-controls]').forEach(btn => {
            const target = document.getElementById(btn.getAttribute('aria-controls'));
            if (!target) return;
            const li = btn.closest('.sidebar-menu > li');
            const aperto = li && li.querySelector(':scope > .settings-flyout') === target
                ? li.classList.contains('open')
                : visibile(target) && (!target.classList.contains('todo-multiselect-panel') || !!target.closest('.todo-multiselect.open'))
                    && (!target.classList.contains('ai-chat-dl-menu') || target.classList.contains('open'));
            const prima = btn.getAttribute('aria-expanded') === 'true';
            if (prima === aperto) return;
            btn.setAttribute('aria-expanded', String(aperto));
            if (!li) return;
            if (aperto && document.activeElement === btn) {
                setTimeout(() => {
                    const campo = target.querySelector('.flyout-search') || focusabiliIn(target)[0];
                    if (campo && visibile(campo)) campo.focus();
                }, 80);
            } else if (!aperto && (target.contains(document.activeElement) || document.activeElement === document.body)) {
                btn.focus();
            }
        });
    }

    // === GRAFICI ===
    function descriviGrafico(chart) {
        const canvas = chart.canvas;
        if (!canvas) return;
        const labels = (chart.data && chart.data.labels) || [];
        const dataset = ((chart.data && chart.data.datasets) || []).filter(ds => !ds.hidden);
        const titolo = canvas.getAttribute('data-a11y-titolo') || canvas.getAttribute('aria-label') || 'Grafico';
        if (!canvas.hasAttribute('data-a11y-titolo')) canvas.setAttribute('data-a11y-titolo', titolo);
        canvas.setAttribute('role', 'img');
        let tab = canvas.nextElementSibling;
        if (!tab || !tab.classList.contains('a11y-dati-grafico')) {
            tab = document.createElement('table');
            tab.className = 'sr-only a11y-dati-grafico';
            canvas.after(tab);
        }
        if (!tab.id) tab.id = 'a11yDati' + (++contatoreId);
        const fmt = v => (v && typeof v === 'object' ? (v.y ?? v.x ?? '') : (v ?? ''));
        const cella = (tag, testo) => { const c = document.createElement(tag); c.textContent = String(testo); return c; };
        tab.replaceChildren();
        tab.appendChild(cella('caption', titolo));
        const head = document.createElement('tr');
        head.appendChild(cella('th', ''));
        dataset.forEach(ds => head.appendChild(cella('th', ds.label || 'Valore')));
        tab.appendChild(head);
        labels.forEach((lab, i) => {
            const tr = document.createElement('tr');
            tr.appendChild(cella('th', Array.isArray(lab) ? lab.join(' ') : lab));
            dataset.forEach(ds => tr.appendChild(cella('td', fmt((ds.data || [])[i]))));
            tab.appendChild(tr);
        });
        canvas.setAttribute('aria-label', titolo + (labels.length ? ': i valori sono nella tabella che segue' : ''));
        canvas.setAttribute('aria-describedby', tab.id);
    }

    function preparaGrafici() {
        if (!window.Chart || window.Chart.__a11y) return;
        window.Chart.__a11y = true;
        try {
            window.Chart.register({ id: 'a11yDati', afterUpdate: descriviGrafico });
            Object.values(window.Chart.instances || {}).forEach(descriviGrafico);
        } catch (e) { console.warn('[a11y] grafici', e.message); }
    }

    // Anelli MBO: l'etichetta riporta la percentuale mostrata al centro.
    function aggiornaMbo() {
        const svg = document.getElementById('mboRings');
        const perc = document.getElementById('mboPercent');
        if (!svg || !perc) return;
        const v = (perc.textContent || '').trim();
        const label = 'Avanzamento del fatturato rispetto all\'obiettivo MBO' + (v && v !== '-' ? ': ' + v + ' dell\'obiettivo' : '');
        if (svg.getAttribute('aria-label') !== label) svg.setAttribute('aria-label', label);
    }

    // === OSSERVATORE ===
    let inCoda = false;
    const nuovi = new Set();
    function pianifica() {
        if (inCoda) return;
        inCoda = true;
        // setTimeout e non requestAnimationFrame: funziona anche con la scheda in secondo piano.
        setTimeout(() => {
            inCoda = false;
            nuovi.forEach(sistemaNomi);
            nuovi.clear();
            aggiornaDialog();
            aggiornaEspansi();
            aggiornaMbo();
        }, 16);
    }

    function avvia() {
        preparaDock();
        sistemaNomi(document.body);
        aggiornaDialog();
        aggiornaEspansi();
        new MutationObserver((mutazioni) => {
            for (const m of mutazioni) {
                if (m.type === 'childList') m.addedNodes.forEach(n => { if (n.nodeType === 1) nuovi.add(n); });
            }
            pianifica();
        }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
        preparaGrafici();
        document.addEventListener('DOMContentLoaded', preparaGrafici);
        window.addEventListener('load', preparaGrafici);
    }

    if (document.body) avvia(); else document.addEventListener('DOMContentLoaded', avvia);
})();
