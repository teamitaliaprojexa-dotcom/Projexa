// AZIONI A CARICO DEL CLIENTE (2026-10-16): registro letto in automatico dalla sezione
// «AZIONI IN CARICO AL CLIENTE» del recap cliente, più le azioni aggiunte a mano.
// Usato dal Cruscotto PM (scheda «Azioni cliente», un progetto) e dal Portfolio (tutte).
// Nessuna email al cliente: i promemoria arrivano al PM in campanella (job della mattina).
// API: /api/pm/azioni-cliente (backend/routes/pm.js, backend/config/azioniCliente.js).
//   AzioniCliente.monta(contenitore, { projectId, evidenzia, onCambio })
(function () {
    const { esc, api, dataIt, toast, modale, valori } = PM;
    const STATI = { aperta: 'Aperta', fatta: 'Fatta', annullata: 'Annullata' };

    const stile = document.createElement('style');
    stile.textContent = `
        .azc-tab td.chk { width: 28px; }
        .azc-tab input[type=checkbox] { width: 17px; height: 17px; cursor: pointer; }
        .azc-tab tr.fatta td { color: #9CA3AF; } .azc-tab tr.fatta td b { text-decoration: line-through; }
        .azc-tab tr.evidenzia td { background: #EEF2FF !important; }
        .azc-scad { font-weight: 600; white-space: nowrap; }
        .azc-scad.ko { color: var(--pm-rosso); } .azc-scad.att { color: var(--pm-giallo); } .azc-scad.nd { color: var(--pm-tenue); font-weight: 400; }
        .azc-barra { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; margin-bottom: 0.8rem; }
        .azc-barra .pm-input { max-width: 260px; }
        .pill.fatta { background: var(--pm-verde-bg); color: var(--pm-verde); } .pill.annullata { background: #F3F4F6; color: #6B7280; } .pill.aperta { background: #EEF2FF; color: #3730A3; }
        .azc-del { border: none; background: none; cursor: pointer; color: #9CA3AF; padding: 0.15rem 0.3rem; border-radius: 6px; }
        .azc-del:hover { color: var(--pm-rosso); background: var(--pm-rosso-bg); }
        .azc-tri { border: none; background: none; padding: 0 0.25rem 0 0; cursor: pointer; color: #D97706; font-size: 0.95rem; vertical-align: -1px; }
        .azc-tri:hover { color: #B45309; transform: scale(1.12); }
        .azc-ref-campo { position: relative; }
        .azc-ref-menu { position: absolute; left: 0; right: 0; top: 100%; z-index: 20; margin-top: 2px; max-height: 240px; overflow-y: auto; background: #fff; border: 1px solid var(--pm-bordo); border-radius: 8px; box-shadow: 0 8px 24px rgba(15,23,42,0.12); }
        .azc-ref-menu button { display: flex; flex-direction: column; align-items: flex-start; width: 100%; border: 0; border-bottom: 1px solid #F3F4F6; background: none; padding: 0.4rem 0.7rem; cursor: pointer; text-align: left; font: inherit; font-size: 0.86rem; font-weight: 400; }
        .azc-ref-menu button small { color: var(--pm-tenue); font-size: 0.76rem; }
        .azc-ref-menu button:hover, .azc-ref-menu button.on { background: #EEF2FF; }
        .azc-ref-menu .vuoto { padding: 0.5rem 0.7rem; color: var(--pm-tenue); font-size: 0.82rem; font-weight: 400; }
        .azc-ref-info { display: block; min-height: 1em; color: var(--pm-tenue); font-size: 0.76rem; font-weight: 400; margin-top: 0.2rem; }
        .azc-rub { max-height: 320px; overflow-y: auto; border: 1px solid var(--pm-bordo); border-radius: 8px; margin-top: 0.5rem; }
        .azc-rub label { display: flex; gap: 0.55rem; align-items: center; padding: 0.4rem 0.6rem; border-bottom: 1px solid #F3F4F6; cursor: pointer; font-size: 0.86rem; }
        .azc-rub label:hover { background: #F9FAFB; }
        .azc-rub small { color: var(--pm-tenue); margin-left: auto; }`;
    document.head.appendChild(stile);

    // Gmail o programma di posta (come l'email della To-Do): dal provider del calendario.
    let provider = null;
    async function tipoEmail() {
        if (provider) return provider;
        try {
            const r = await fetch(`${PM.API_URL}/calendar/status`, { headers: PM.auth() });
            const d = r.ok ? await r.json() : {};
            provider = d.defaultProvider === 'google' ? 'google' : 'mailto';
        } catch (e) { provider = 'mailto'; }
        return provider;
    }
    const EMAIL_URL_MAX = { google: 7000, mailto: 8000 };
    function apriEmail(kind, tab, testo, to) {
        let body = String(testo || '').replace(/\r\n?/g, '\n').trim();
        let subject = 'Promemoria attività a vostro carico';
        const subj = /^oggetto\s*:\s*(.+)\n+/i.exec(body);
        if (subj) { subject = subj[1].trim() || subject; body = body.slice(subj[0].length).trim(); }
        const build = (b) => kind === 'google'
            ? `https://mail.google.com/mail/?view=cm&fs=1${to.length ? `&to=${encodeURIComponent(to.join(','))}` : ''}&su=${encodeURIComponent(subject)}${b ? `&body=${encodeURIComponent(b)}` : ''}`
            : `mailto:${to.map(encodeURIComponent).join(';')}?subject=${encodeURIComponent(subject)}${b ? `&body=${encodeURIComponent(b.replace(/\n/g, '\r\n'))}` : ''}`;
        let url = build(body);
        if (url.length > EMAIL_URL_MAX[kind]) {
            url = build('');
            if (navigator.clipboard) navigator.clipboard.writeText(body).catch(() => {});
            toast('Testo lungo: è stato copiato negli appunti, incollalo nell\'email con Ctrl+V');
        }
        if (kind === 'mailto') window.location.href = url;
        else if (tab && !tab.closed) tab.location.href = url;
        else window.open(url, '_blank', 'noopener');
    }
    // Testo senza AI (AI non disponibile): azioni aperte per referente.
    function testoStandard(azioni, cliente) {
        const gruppi = new Map();
        for (const a of azioni) {
            const nome = (a.contatto && a.contatto.nominativo) || a.referente || 'Referente da definire';
            if (!gruppi.has(nome)) gruppi.set(nome, []);
            gruppi.get(nome).push(a);
        }
        return [`Oggetto: ${cliente} – Promemoria attività a vostro carico`, '', 'Buongiorno a tutti,', '',
            'riepiloghiamo le attività emerse nelle ultime riunioni che restano in carico a voi.', '',
            ...[...gruppi.entries()].flatMap(([nome, l]) => [nome, ...l.map((a) => `- ${a.descrizione} – entro il ${a.data_scadenza ? dataIt(a.data_scadenza) : 'da definire'}`), '']),
            'Vi chiediamo un riscontro sullo stato delle attività.', '', 'Grazie per la collaborazione'].join('\n');
    }

    function scadenzaHtml(a) {
        if (!a.data_scadenza) return '<span class="azc-scad nd">da definire</span>';
        if (a.stato !== 'aperta') return `<span class="azc-scad nd">${dataIt(a.data_scadenza)}</span>`;
        if (a.giorni < 0) return `<span class="azc-scad ko" title="Scaduta">${dataIt(a.data_scadenza)}<div class="pm-nota" style="color:inherit">scaduta da ${-a.giorni} gg</div></span>`;
        if (a.giorni === 0) return `<span class="azc-scad att">${dataIt(a.data_scadenza)}<div class="pm-nota" style="color:inherit">oggi</div></span>`;
        return `<span class="azc-scad ${a.giorni <= 7 ? 'att' : ''}">${dataIt(a.data_scadenza)}<div class="pm-nota">tra ${a.giorni} gg</div></span>`;
    }

    function monta(box, { projectId = null, evidenzia = null, onCambio = null } = {}) {
        let dati = null;
        let mostraTutte = false;
        let cerca = '';
        let daEvidenziare = evidenzia;

        async function carica() {
            box.innerHTML = '<div class="pm-attesa"><i class="fas fa-spinner fa-spin"></i> Leggo le azioni del cliente dai recap…</div>';
            try {
                const q = new URLSearchParams();
                if (projectId) q.set('projectId', projectId);
                if (mostraTutte) q.set('tutte', '1');
                dati = await api(`/azioni-cliente?${q.toString()}`);
                render();
                if (onCambio) onCambio(dati.azioni.filter((a) => a.stato === 'aperta').length);
            } catch (e) { box.innerHTML = `<div class="pm-errore"><i class="fas fa-triangle-exclamation"></i> ${esc(e.message)}</div>`; }
        }

        function render() {
            const tutte = dati.azioni;
            const aperte = tutte.filter((a) => a.stato === 'aperta');
            const q = cerca.trim().toLowerCase();
            const l = q ? tutte.filter((a) => [a.descrizione, a.referente, a.cliente, a.progetto, a.note, a.riunione].some((v) => String(v || '').toLowerCase().includes(q))) : tutte;
            const rg = dati.regole || {};
            const kpi = [
                ['Aperte', aperte.length],
                ['Scadute', `<span style="color:${aperte.some((a) => a.scaduta) ? 'var(--pm-rosso)' : 'inherit'}">${aperte.filter((a) => a.scaduta).length}</span>`],
                ['In scadenza (7 gg)', aperte.filter((a) => a.inScadenza).length],
                ['Senza scadenza', aperte.filter((a) => !a.data_scadenza).length]
            ];
            const globale = !projectId;
            box.innerHTML = `${dati.tabelle ? '' : '<div class="pm-avviso"><i class="fas fa-database"></i> Funzione non ancora attiva: va eseguito lo script <b>Supporto/CreaDB/azioni_cliente.sql</b> sul database.</div>'}
                <div class="pm-card" id="azioni-cliente">
                    <h2><i class="fas fa-handshake"></i> Azioni a carico del cliente
                        <span class="azioni">${aperte.length ? `<button class="pm-btn piccolo" data-azc-email title="Prepara con l'AI l'email ai referenti del cliente con le azioni aperte, raggruppate per referente (destinatari dai Contatti del cliente)"><i class="fas fa-envelope"></i> Email</button>` : ''}${projectId ? '<button class="pm-btn piccolo primario" data-azc-nuova><i class="fas fa-plus"></i> Nuova azione</button>' : ''}</span></h2>
                    <p class="pm-nota" style="margin-top:0">Le azioni che hai scelto con «Crea To-Do» nel recap cliente delle riunioni${projectId ? ' del progetto' : ''}, più quelle aggiunte a mano. Al cliente non parte nessuna email: ricevi tu i promemoria in campanella${rg.az_notifiche === false ? ' (<b>spenti</b> nel Portfolio)' : ` (${rg.az_giorni_prima} giorni prima della scadenza, poi il giorno dopo e ogni ${rg.az_ogni_giorni} giorni lavorativi, al massimo ${rg.az_max_solleciti} volte)`}.</p>
                    <div class="pm-kpi" style="margin-bottom:0.9rem">${kpi.map(([t, v]) => `<div><small>${t}</small><b>${v}</b></div>`).join('')}</div>
                    <div class="azc-barra">
                        <input class="pm-input" data-azc-cerca placeholder="Cerca azione, referente, cliente…" value="${esc(cerca)}">
                        <label class="pm-filtro${mostraTutte ? ' attivo' : ''}"><input type="checkbox" data-azc-tutte ${mostraTutte ? 'checked' : ''}> anche fatte e annullate</label>
                    </div>
                    ${l.length ? `<div class="pm-scroll"><table class="pm-t azc-tab"><thead><tr><th title="Fatta">✓</th><th>Azione</th><th>Referente</th>${globale ? '<th>Cliente · progetto</th>' : ''}<th>Scadenza</th><th class="n" title="Promemoria «da sollecitare» già ricevuti">Promem.</th><th>Riunione</th><th></th></tr></thead><tbody>
                        ${l.map((a) => `<tr class="click ${a.stato !== 'aperta' ? 'fatta' : ''}${a.id === daEvidenziare ? ' evidenzia' : ''}" data-id="${esc(a.id)}">
                            <td class="chk"><input type="checkbox" data-azc-fatto="${esc(a.id)}" ${a.stato === 'fatta' ? 'checked' : ''} ${a.puoModificare === false || a.stato === 'annullata' ? 'disabled' : ''} title="Fatta"></td>
                            <td><b>${esc(a.descrizione)}</b>${a.stato !== 'aperta' ? ` <span class="pill ${a.stato}">${STATI[a.stato]}${a.fatta_il ? ` il ${dataIt(a.fatta_il)}` : ''}</span>` : ''}${a.note ? `<div class="pm-nota">${esc(a.note)}</div>` : ''}</td>
                            <td>${referenteHtml(a)}</td>
                            ${globale ? `<td>${esc(a.cliente || '–')}${a.progetto ? `<div class="pm-nota">${a.project_id ? `<a href="pm.html?projectId=${encodeURIComponent(a.project_id)}&tab=azioni" data-azc-link>${esc(a.progetto)}</a>` : esc(a.progetto)}</div>` : ''}</td>` : ''}
                            <td>${scadenzaHtml(a)}</td>
                            <td class="n">${a.solleciti ? `${a.solleciti}/${rg.az_max_solleciti ?? 3}` : '–'}</td>
                            <td>${a.riunione_data ? dataIt(a.riunione_data) : ''}${a.riunione ? `<div class="pm-nota">${esc(a.riunione)}</div>` : (a.origine === 'manuale' ? '<span class="pm-nota">aggiunta a mano</span>' : '')}</td>
                            <td>${a.puoModificare === false ? '' : `<button type="button" class="azc-del" data-azc-del="${esc(a.id)}" title="Elimina: azione da non considerare (non torna rileggendo il recap)"><i class="fas fa-trash"></i></button>`}</td>
                        </tr>`).join('')}
                    </tbody></table></div>` : `<div class="pm-vuoto">${tutte.length ? 'Nessuna azione trovata con questa ricerca.' : `Nessuna azione aperta del cliente${projectId ? ' per questo progetto' : ''}. Le azioni arrivano dai recap cliente che hanno la sezione «AZIONI IN CARICO AL CLIENTE»${projectId ? ', oppure aggiungile con «Nuova azione»' : ''}.`}</div>`}
                </div>`;

            box.querySelector('[data-azc-nuova]')?.addEventListener('click', () => form({}));
            box.querySelector('[data-azc-email]')?.addEventListener('click', () => email(aperte));
            box.querySelectorAll('[data-azc-del]').forEach((b) => b.addEventListener('click', async (e) => {
                e.stopPropagation();
                const x = tutte.find((a) => a.id === b.dataset.azcDel);
                if (!x || !confirm(`Eliminare l'azione «${String(x.descrizione).slice(0, 120)}»?\nViene cancellata definitivamente.`)) return;
                b.disabled = true;
                try { await eliminaAzione(x.id); } catch (err) { b.disabled = false; toast(err.message, 'errore'); }
            }));
            box.querySelectorAll('[data-azc-ref]').forEach((b) => b.addEventListener('click', (e) => {
                e.stopPropagation();
                const x = tutte.find((a) => a.id === b.dataset.azcRef);
                if (x) scegliReferente(x);
            }));
            box.querySelector('[data-azc-tutte]').addEventListener('change', (e) => { mostraTutte = e.target.checked; carica(); });
            const ce = box.querySelector('[data-azc-cerca]');
            ce.addEventListener('input', () => { cerca = ce.value; const pos = ce.selectionStart; render(); const n = box.querySelector('[data-azc-cerca]'); n.focus(); n.setSelectionRange(pos, pos); });
            box.querySelectorAll('[data-azc-fatto]').forEach((c) => c.addEventListener('click', (e) => e.stopPropagation()));
            box.querySelectorAll('[data-azc-fatto]').forEach((c) => c.addEventListener('change', async () => {
                c.disabled = true;
                try {
                    await api(`/azioni-cliente/${encodeURIComponent(c.dataset.azcFatto)}/fatto`, { metodo: 'POST', corpo: { fatto: c.checked } });
                    toast(c.checked ? 'Azione segnata come fatta' : 'Azione di nuovo aperta');
                    carica();
                } catch (err) { c.checked = !c.checked; c.disabled = false; toast(err.message, 'errore'); }
            }));
            box.querySelectorAll('a[data-azc-link]').forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
            box.querySelectorAll('tr.click').forEach((tr) => tr.addEventListener('click', () => form(l.find((x) => x.id === tr.dataset.id))));

            if (daEvidenziare) {
                const tr = box.querySelector(`tr[data-id="${CSS.escape(daEvidenziare)}"]`);
                const x = l.find((a) => a.id === daEvidenziare);
                daEvidenziare = null;
                if (tr) { tr.scrollIntoView({ block: 'center' }); if (x) form(x); }
                else if (!mostraTutte) { toast('L\'azione del promemoria non è più aperta: mostro anche quelle fatte'); mostraTutte = true; daEvidenziare = evidenzia; carica(); }
            }
        }

        // Elimina = azione da non considerare: sparisce da tutte le viste e dai promemoria e la
        // rilettura del recap non la ricrea (il server la riconosce dalla sua impronta).
        async function eliminaAzione(id) {
            await api(`/azioni-cliente/${encodeURIComponent(id)}`, { metodo: 'DELETE' });
            toast('Azione eliminata');
            carica();
        }

        // Referente: nome del contatto di rubrica (con l'email) oppure triangolo giallo se il nome
        // del recap non corrisponde a nessun contatto (clic = scelta dalla rubrica).
        function referenteHtml(a) {
            const dove = (c) => (c.fonte === 'cliente' ? 'Contatti del cliente' : 'Rubrica');
            if (a.contatto && a.contatto.email) {
                return `<span title="${esc(`${dove(a.contatto)}${a.contatto.auto ? ' (abbinato dal nome)' : ''}: ${a.contatto.email}`)}">${esc(a.contatto.nominativo)}</span>`;
            }
            const motivo = a.contatto ? `Il contatto (${dove(a.contatto)}) non ha email` : (a.referente ? 'Referente non trovato tra i Contatti del cliente' : 'Referente non indicato');
            const tri = dati.sceltaReferente && a.puoModificare !== false
                ? `<button type="button" class="azc-tri" data-azc-ref="${esc(a.id)}" title="${motivo}: clicca per sceglierlo dalla rubrica"><i class="fas fa-triangle-exclamation"></i></button>`
                : `<i class="fas fa-triangle-exclamation" style="color:#D97706" title="${motivo}"></i> `;
            return `${tri}${esc((a.contatto && a.contatto.nominativo) || a.referente || 'da indicare')}`;
        }

        // Scelta del referente dalla rubrica (anche per le altre azioni aperte con lo stesso nome).
        // Persone: solo i Contatti del cliente (la Rubrica ha i colleghi interni, scelta dell'utente).
        async function scegliReferente(x) {
            let contatti;
            try { contatti = await api(`/rubrica-contatti${x.client_id ? `?clientId=${encodeURIComponent(x.client_id)}` : ''}`); } catch (e) { toast(e.message, 'errore'); return; }
            const altre = dati.azioni.filter((a) => a.id !== x.id && a.stato === 'aperta' && !a.rubrica_id && !a.contatto_id && a.client_id === x.client_id && x.referente && String(a.referente || '').trim().toLowerCase() === String(x.referente).trim().toLowerCase()).length;
            const voce = (c) => `<label><input type="radio" name="azcRub" value="${esc(`${c.fonte}|${c.id}`)}"> ${esc(c.nominativo)}<small>${esc(c.email || 'senza email')}</small></label>`;
            const lista = (q) => {
                const f = (c) => !q || `${c.nominativo} ${c.email}`.toLowerCase().includes(q.toLowerCase());
                const cli = contatti.filter((c) => c.fonte === 'cliente' && f(c));
                return (cli.length ? `<div class="pm-nota" style="padding:0.35rem 0.6rem; font-weight:700">Contatti del cliente</div>${cli.map(voce).join('')}` : '')
                    || '<div class="pm-vuoto">Nessun contatto trovato.</div>';
            };
            const m = modale({
                titolo: '<i class="fas fa-address-book"></i> Referente del cliente',
                corpo: `<p class="pm-nota" style="margin-top:0">Nel recap il referente è <b>${esc(x.referente || '(non indicato)')}</b>${x.cliente ? ` (${esc(x.cliente)})` : ''}: scegli la persona a cui scrivere tra i Contatti del cliente.</p>
                    <input class="pm-input" data-azc-rcerca placeholder="Cerca nome o email…" value="${esc(String(x.referente || '').replace(/\(.*?\)/g, '').split(/\s+[-–]\s+/)[0].trim().split(/\s+/)[0] || '')}">
                    <div class="azc-rub" data-azc-rlista></div>
                    ${altre ? `<label style="display:flex; gap:0.5rem; align-items:center; margin-top:0.7rem; font-size:0.85rem"><input type="checkbox" data-azc-rtutte checked> Applica anche alle altre ${altre} azioni aperte con referente «${esc(x.referente)}»</label>` : ''}
                    <p class="pm-nota">Manca la persona o l'email? Aggiungila nei Contatti della scheda del cliente e riapri questa finestra.</p>`,
                pulsanti: [{ testo: 'Annulla' }, { testo: '<i class="fas fa-check"></i> Usa questo contatto', classe: 'primario', azione: async (mm) => {
                    const scelto = mm.querySelector('input[name="azcRub"]:checked');
                    if (!scelto) throw new Error('Scegli un contatto');
                    const [fonte, id] = scelto.value.split('|');
                    const tutteBox = mm.querySelector('[data-azc-rtutte]');
                    const r = await api(`/azioni-cliente/${encodeURIComponent(x.id)}/referente`, { metodo: 'PUT', corpo: { fonte, id, tutte: tutteBox ? tutteBox.checked : false } });
                    toast(r.aggiornate > 1 ? `Referente aggiornato su ${r.aggiornate} azioni` : 'Referente aggiornato');
                    carica();
                } }]
            });
            const ce = m.querySelector('[data-azc-rcerca]');
            const el = m.querySelector('[data-azc-rlista]');
            const aggiorna = () => { el.innerHTML = lista(ce.value.trim()); };
            ce.addEventListener('input', aggiorna);
            aggiorna();
            if (!el.querySelector('input')) { ce.value = ''; aggiorna(); }
        }

        // «Email»: un'email per cliente con le azioni aperte per referente (AI dell'email della To-Do).
        async function email(aperte) {
            if (!aperte.length) { toast('Nessuna azione aperta', 'errore'); return; }
            let corpo;
            if (projectId) corpo = { projectId };
            else {
                // Portfolio: un cliente alla volta.
                const clienti = new Map();
                aperte.forEach((a) => { if (a.client_id) clienti.set(a.client_id, { nome: a.cliente || 'Cliente', n: (clienti.get(a.client_id)?.n || 0) + 1 }); });
                if (!clienti.size) { toast('Le azioni aperte non hanno un cliente: collega le riunioni a un cliente', 'errore'); return; }
                const scelto = clienti.size === 1 ? [...clienti.keys()][0] : await new Promise((ok) => {
                    modale({
                        titolo: '<i class="fas fa-envelope"></i> Email al cliente',
                        corpo: `<p class="pm-nota" style="margin-top:0">Scegli il cliente: l'email conterrà tutte le sue azioni aperte, di tutti i progetti, raggruppate per referente.</p>
                            <div class="azc-rub">${[...clienti.entries()].sort((a, b) => a[1].nome.localeCompare(b[1].nome, 'it')).map(([id, c], i) => `<label><input type="radio" name="azcCli" value="${esc(id)}" ${i === 0 ? 'checked' : ''}> ${esc(c.nome)}<small>${c.n} azion${c.n === 1 ? 'e' : 'i'}</small></label>`).join('')}</div>`,
                        pulsanti: [{ testo: 'Annulla', azione: () => { ok(null); } }, { testo: '<i class="fas fa-wand-magic-sparkles"></i> Prepara email', classe: 'primario', azione: (mm) => { ok(mm.querySelector('input[name="azcCli"]:checked')?.value || null); } }]
                    }).querySelector('.pm-x').addEventListener('click', () => ok(null));
                });
                if (!scelto) return;
                corpo = { clientId: scelto };
            }
            const azioni = aperte.filter((a) => (corpo.projectId ? true : a.client_id === corpo.clientId));
            const cliente = azioni.find((a) => a.cliente)?.cliente || 'Cliente';
            const kind = await tipoEmail();
            // Gmail: la scheda si apre subito (dentro il clic), altrimenti il browser la bloccherebbe.
            const tab = kind === 'google' ? window.open('', '_blank') : null;
            if (tab) tab.document.write('<p style="font-family: sans-serif; color: #475569;">Preparo l\'email…</p>');
            const btn = box.querySelector('[data-azc-email]');
            const html = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> L\'AI scrive l\'email…'; }
            const toPrevisti = [...new Set(azioni.map((a) => a.contatto && a.contatto.email).filter(Boolean))];
            let testo = '', to = toPrevisti, senzaEmail = [];
            try {
                const r = await api('/azioni-cliente/email', { metodo: 'POST', corpo: { ...corpo, _extra: { to: toPrevisti } }, ai: 'email_azioni_cliente', titolo: cliente });
                if (r.batch) { if (tab && !tab.closed) tab.close(); toast(r.messaggio || 'Email inviata all\'AI in modalità Batch: la trovi in «Risultati AI»'); return; }
                testo = r.testo; to = r.to || to; senzaEmail = r.senzaEmail || [];
            } catch (e) {
                if (e.annullata) { if (tab && !tab.closed) tab.close(); return; }
                toast(`Testo dall'AI non disponibile (${e.message}): uso il testo standard`, 'errore');
                testo = testoStandard(azioni, cliente);
                senzaEmail = [...new Set(azioni.filter((a) => !a.contatto || !a.contatto.email).map((a) => a.referente || 'referente da definire'))];
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = html; }
            }
            if (senzaEmail.length) toast(`Senza email nei Contatti del cliente: ${senzaEmail.join(', ')}. Aggiungi tu il destinatario (o sceglilo con il triangolo giallo).`, 'errore');
            apriEmail(kind, tab, testo, to);
        }

        function form(x) {
            const nuovo = !x.id;
            const sola = !nuovo && x.puoModificare === false;
            const m = modale({
                titolo: `<i class="fas fa-handshake"></i> ${nuovo ? 'Nuova azione del cliente' : 'Azione del cliente'}`,
                corpo: `${sola ? '<div class="pm-avviso">Sola lettura: il tuo ruolo non può modificare questa azione.</div>' : ''}
                    ${!nuovo && (x.cliente || x.progetto) ? `<p class="pm-nota" style="margin-top:0">${esc([x.cliente, x.progetto].filter(Boolean).join(' · '))}${x.riunione ? ` — dalla riunione «${esc(x.riunione)}» del ${dataIt(x.riunione_data)}` : ''}</p>` : ''}
                    <div class="pm-form">
                    <label class="largo">Che cosa deve fare il cliente<textarea name="descrizione">${esc(x.descrizione || '')}</textarea></label>
                    <label class="azc-ref-campo">Referente del cliente<input name="referente" value="${esc((x.contatto && x.contatto.nominativo) || x.referente || '')}" maxlength="300" autocomplete="off" placeholder="Scrivi per cercare tra i Contatti del cliente">
                        <div class="azc-ref-menu" data-azc-refmenu hidden></div><small class="azc-ref-info" data-azc-refinfo></small></label>
                    <label>Entro il<input type="date" name="data_scadenza" value="${esc(x.data_scadenza || '')}"></label>
                    ${nuovo ? '' : `<label>Stato<select name="stato">${Object.entries(STATI).map(([k, v]) => `<option value="${k}" ${k === x.stato ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
                    <label>Promemoria già ricevuti<input value="${x.solleciti || 0}${x.ultimo_sollecito ? ` (ultimo il ${dataIt(x.ultimo_sollecito)})` : ''}" disabled></label>`}
                    <label class="largo">Note (es. risposta del cliente, sollecito fatto a voce)<textarea name="note" style="min-height:50px">${esc(x.note || '')}</textarea></label></div>
                    <p class="pm-nota">Cambiando la data di scadenza i promemoria ripartono da capo. Le azioni modificate a mano non vengono più toccate se il recap della riunione viene rigenerato.</p>`,
                pulsanti: [
                    ...(!nuovo && !sola ? [{ testo: '<i class="fas fa-trash"></i> Elimina', classe: 'pericolo', azione: async () => {
                        if (!confirm('Eliminare definitivamente questa azione?')) return false;
                        await eliminaAzione(x.id);
                    } }] : []),
                    { testo: 'Annulla' },
                    ...(!sola ? [{ testo: '<i class="fas fa-floppy-disk"></i> Salva', classe: 'primario', azione: async (mm) => {
                        const v = valori(mm);
                        if (!String(v.descrizione || '').trim()) throw new Error('Scrivi che cosa deve fare il cliente');
                        if (contattoId) v.contatto_id = contattoId;
                        if (nuovo) await api('/azioni-cliente', { metodo: 'POST', corpo: { ...v, projectId } });
                        else await api(`/azioni-cliente/${encodeURIComponent(x.id)}`, { metodo: 'PUT', corpo: v });
                        toast('Azione salvata'); carica();
                    } }] : [])
                ]
            });
            if (sola) m.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
            // Referente: elenco dinamico dei Contatti del cliente mentre scrivi (testo libero ammesso).
            let contattoId = null;
            const inp = m.querySelector('input[name="referente"]');
            const menu = m.querySelector('[data-azc-refmenu]');
            const info = m.querySelector('[data-azc-refinfo]');
            const mostraInfo = () => {
                const c = contattoId && contatti.find((k) => k.id === contattoId);
                const att = !contattoId && x.contatto && x.contatto.nominativo === inp.value.trim() ? x.contatto : null;
                const k = c || att;
                info.innerHTML = k ? `<i class="fas fa-address-book"></i> ${esc(k.email || 'contatto senza email')}` : (inp.value.trim() && contatti.length ? '<i class="fas fa-triangle-exclamation" style="color:#D97706"></i> non è tra i Contatti del cliente' : '');
            };
            let contatti = [];
            const qCli = x.client_id ? `?clientId=${encodeURIComponent(x.client_id)}` : (projectId ? `?projectId=${encodeURIComponent(projectId)}` : '');
            if (!sola && qCli) api(`/rubrica-contatti${qCli}`).then((l) => { contatti = l || []; mostraInfo(); }).catch(() => {});
            let attivo = -1;
            const disegna = () => {
                const q = inp.value.trim().toLowerCase();
                const l = contatti.filter((c) => !q || `${c.nominativo} ${c.email}`.toLowerCase().includes(q)).slice(0, 30);
                if (!contatti.length) { menu.hidden = true; return; }
                menu.innerHTML = l.length ? l.map((c, i) => `<button type="button" class="${i === attivo ? 'on' : ''}" data-id="${esc(c.id)}"><b>${esc(c.nominativo)}</b><small>${esc(c.email || 'senza email')}</small></button>`).join('')
                    : '<div class="vuoto">Nessun contatto: resta il testo scritto. Per aggiungerlo usa i Contatti della scheda del cliente.</div>';
                menu.hidden = false;
            };
            const scegli = (id) => {
                const c = contatti.find((k) => k.id === id);
                if (!c) return;
                inp.value = c.nominativo; contattoId = c.id; menu.hidden = true; attivo = -1; mostraInfo();
            };
            inp.addEventListener('focus', () => { attivo = -1; disegna(); });
            inp.addEventListener('input', () => { contattoId = null; attivo = -1; disegna(); mostraInfo(); });
            inp.addEventListener('keydown', (e) => {
                const n = menu.querySelectorAll('button').length;
                if (menu.hidden || !n) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); attivo = (attivo + 1) % n; disegna(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); attivo = (attivo - 1 + n) % n; disegna(); }
                else if (e.key === 'Enter') { e.preventDefault(); scegli(menu.querySelectorAll('button')[Math.max(0, attivo)].dataset.id); }
                else if (e.key === 'Escape') { e.stopPropagation(); menu.hidden = true; }
            });
            menu.addEventListener('mousedown', (e) => { const b = e.target.closest('button[data-id]'); if (b) { e.preventDefault(); scegli(b.dataset.id); } });
            inp.addEventListener('blur', () => { setTimeout(() => { menu.hidden = true; }, 150); });
        }

        tipoEmail(); // letto subito: all'«Email» la scheda di Gmail deve aprirsi dentro il clic
        carica();
        return { ricarica: carica };
    }

    window.AzioniCliente = { monta };
})();
