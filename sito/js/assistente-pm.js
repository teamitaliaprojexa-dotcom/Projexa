// === Finestra «Assistente PM» durante la registrazione di una riunione ===
//
// Con Impostazioni › «Ai Assistente PM» acceso, all'avvio della registrazione (dashboard,
// startMeetingRecording) si apre questa finestra e l'audio della riunione va all'AI scelta
// (Gemini Live o ChatGPT Realtime) attraverso il server Projexa, che risponde solo con i
// suggerimenti da project manager senior (backend/routes/assistentePm.js). Nessuna trascrizione
// (2026-10-31, scelta utente: tolte la modalità Testo e la «Trascrizione live»).
// Un solo WebSocket con il server (/api/assistente-pm/live): il browser manda l'audio (PCM 16 bit
// mono 16 kHz, frame binari da ~0,5 s), il server spinge suggerimenti e stato. Se il WebSocket
// cade si riapre da solo e recupera i messaggi persi.
// La finestra si sposta trascinando la testata e si allarga/allunga dai bordi e dall'angolo
// (posizione e dimensioni restano nel browser). Fermando la registrazione la sessione si chiude.
(function () {
    'use strict';

    const API_URL = location.origin + '/api';
    const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/assistente-pm/live`;
    const GEOM_KEY = 'assistentePmGeom';
    const RICOLLEGA_MS = 2000;
    const MIN_W = 300, MIN_H = 220;

    const auth = () => {
        const t = localStorage.getItem('authToken');
        return t ? { Authorization: `Bearer ${t}` } : {};
    };
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const nomeAi = (ai) => ai || 'Gemini';
    const zoom = () => (window.uiZoom ? window.uiZoom() : 1) || 1;

    const css = `
    .apm-win {
        position: fixed; z-index: 790; right: 24px; top: 90px; width: 420px; height: 480px;
        display: none; flex-direction: column; background: #fff; border: 1px solid #C7D2FE;
        border-radius: 12px; box-shadow: 0 12px 32px rgba(30, 41, 59, .22); overflow: hidden;
        font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1F2937;
    }
    .apm-win.open { display: flex; }
    .apm-win.apm-dragging { user-select: none; opacity: .95; }
    .apm-head {
        display: flex; align-items: center; gap: 8px; padding: 9px 10px 9px 14px; cursor: move;
        background: linear-gradient(135deg, #2563EB, #7C3AED); color: #fff; flex: none; user-select: none;
    }
    .apm-head .apm-title { font-weight: 700; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .apm-head .apm-sub { font-weight: 400; opacity: .85; font-size: 12px; margin-left: 6px; }
    .apm-dot { width: 9px; height: 9px; border-radius: 50%; background: #FCD34D; flex: none; }
    .apm-dot.on { background: #4ADE80; box-shadow: 0 0 0 3px rgba(74, 222, 128, .3); }
    .apm-dot.off { background: #F87171; }
    .apm-head button { background: rgba(255,255,255,.15); border: none; color: #fff; width: 28px; height: 28px; border-radius: 6px; cursor: pointer; }
    .apm-head button:hover { background: rgba(255,255,255,.3); }
    .apm-head .apm-stop { display: none; }
    .apm-win.apm-attiva .apm-head .apm-stop { display: inline-block; }
    .apm-head .apm-stop:hover { background: #DC2626; }
    .apm-body { flex: 1; overflow-y: auto; padding: 10px 12px; background: #fff; min-height: 0; }
    .apm-msg { margin: 0 0 8px; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; }
    .apm-msg small { display: block; font-size: 11px; color: #94A3B8; margin-bottom: 2px; }
    .apm-msg.ai { background: #EEF2FF; border-left: 3px solid #6366F1; }
    .apm-voto { display: flex; gap: 4px; justify-content: flex-end; margin-top: 4px; }
    .apm-voto button { border: 1px solid transparent; background: transparent; border-radius: 6px; padding: 1px 6px; cursor: pointer; color: #94A3B8; font-size: 0.85em; }
    .apm-voto button:hover { background: #E0E7FF; color: #4F46E5; }
    .apm-voto button.on.su { color: #059669; border-color: #A7F3D0; background: #ECFDF5; }
    .apm-voto button.on.giu { color: #DC2626; border-color: #FECACA; background: #FEF2F2; }
    .apm-msg.utente { background: #F1F5F9; margin-left: 24px; }
    .apm-msg.info { color: #64748B; font-size: 12.5px; background: none; padding: 2px 0; }
    .apm-msg.avviso { background: #FFFBEB; color: #92400E; font-size: 12.5px; }
    .apm-msg.errore { background: #FEF2F2; color: #B91C1C; }
    .apm-attesa { color: #6366F1; font-size: 12.5px; padding: 2px 0 6px; }
    .apm-foot { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #E5E7EB; flex: none; background: #F8FAFC; }
    .apm-foot textarea { flex: 1; resize: none; height: 38px; border: 1px solid #CBD5E1; border-radius: 8px; padding: 8px; font: inherit; font-size: 13px; }
    .apm-foot button { border: none; border-radius: 8px; padding: 0 12px; cursor: pointer; font: inherit; font-size: 13px; font-weight: 600; }
    .apm-send { background: #4F46E5; color: #fff; }
    .apm-send:disabled { opacity: .5; cursor: default; }
    .apm-hint { background: #E0E7FF; color: #3730A3; }
    .apm-rs { position: absolute; z-index: 1; }
    .apm-rs-r { top: 0; right: 0; width: 6px; height: 100%; cursor: ew-resize; }
    .apm-rs-l { top: 0; left: 0; width: 6px; height: 100%; cursor: ew-resize; }
    .apm-rs-b { left: 0; bottom: 0; width: 100%; height: 6px; cursor: ns-resize; }
    .apm-rs-t { left: 0; top: 0; width: 100%; height: 4px; cursor: ns-resize; }
    .apm-rs-br { right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; z-index: 2;
        background: linear-gradient(135deg, transparent 50%, #A5B4FC 50%); border-bottom-right-radius: 12px; }
    .apm-rs-bl { left: 0; bottom: 0; width: 14px; height: 14px; cursor: nesw-resize; z-index: 2; }
    `;

    let win = null, bodyEl = null, dotEl = null, subEl = null, inputEl = null, sendEl = null;
    // { eventId, ai, title, ultimo, messaggi: [], avviata, attiva, terminata, collegata, ws, ricollega, audio }
    let stato = null;

    function crea() {
        if (win) return;
        const st = document.createElement('style');
        st.textContent = css;
        document.head.appendChild(st);
        win = document.createElement('section');
        win.className = 'apm-win';
        win.setAttribute('aria-label', 'Assistente PM');
        win.innerHTML = `
            <div class="apm-head" title="Trascina per spostare · doppio clic: posizione iniziale">
                <span class="apm-dot"></span>
                <span class="apm-title">Assistente PM<span class="apm-sub"></span></span>
                <button type="button" class="apm-word" title="Esporta in Word i suggerimenti"><i class="fas fa-file-word"></i></button>
                <button type="button" class="apm-stop" title="Chiudi definitivamente: ferma l'assistente anche sul server (la registrazione e la trascrizione della riunione continuano)"><i class="fas fa-power-off"></i></button>
                <button type="button" class="apm-close" title="Chiudi l'assistente (la registrazione continua)"><i class="fas fa-xmark"></i></button>
            </div>
            <div class="apm-body"></div>
            <div class="apm-foot">
                <textarea placeholder="Chiedi qualcosa all'assistente…" maxlength="2000"></textarea>
                <button type="button" class="apm-hint" title="Chiedi subito un suggerimento su quanto detto finora">Suggerisci</button>
                <button type="button" class="apm-send" title="Invia la domanda"><i class="fas fa-paper-plane"></i></button>
            </div>
            <div class="apm-rs apm-rs-t" data-rs="t"></div>
            <div class="apm-rs apm-rs-r" data-rs="r"></div>
            <div class="apm-rs apm-rs-l" data-rs="l"></div>
            <div class="apm-rs apm-rs-b" data-rs="b"></div>
            <div class="apm-rs apm-rs-bl" data-rs="bl"></div>
            <div class="apm-rs apm-rs-br" data-rs="br"></div>`;
        document.body.appendChild(win);
        bodyEl = win.querySelector('.apm-body');
        dotEl = win.querySelector('.apm-dot');
        subEl = win.querySelector('.apm-sub');
        inputEl = win.querySelector('textarea');
        sendEl = win.querySelector('.apm-send');

        // X: con la sessione avviata (o terminata) la finestra si NASCONDE soltanto: l'assistente
        // continua ad ascoltare fino a «Ferma» e la finestra si riapre con i messaggi dal pulsante
        // «Assistente PM» del riquadro della registrazione (riapri). Se l'avvio non è riuscito, la
        // X annulla.
        win.querySelector('.apm-close').addEventListener('click', () => {
            if (!stato) return;
            if (stato.avviata) win.classList.remove('open');
            else ferma(stato.eventId);
        });
        win.querySelector('.apm-word').addEventListener('click', esporta);
        win.querySelector('.apm-stop').addEventListener('click', chiudiDefinitivamente);
        sendEl.addEventListener('click', () => chiedi(inputEl.value));
        win.querySelector('.apm-hint').addEventListener('click', () =>
            chiedi('Su quanto detto finora: qual è la domanda più importante da fare adesso, e c\'è un rischio o una decisione da fissare?', 'Suggeriscimi qualcosa adesso'));
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chiedi(inputEl.value); }
        });
        bodyEl.addEventListener('click', (e) => {
            const b = e.target.closest('.apm-voto button');
            if (b) vota(Number(b.closest('.apm-voto').dataset.n), Number(b.dataset.voto));
        });
        spostaRidimensiona();
    }

    // --- Spostamento e ridimensionamento (coordinate divise per lo zoom della pagina) ---
    function spostaRidimensiona() {
        const vw = () => window.innerWidth / zoom();
        const vh = () => window.innerHeight / zoom();
        const apply = (g) => {
            const w = Math.min(Math.max(g.width, MIN_W), vw() - 16);
            const h = Math.min(Math.max(g.height, MIN_H), vh() - 16);
            const l = Math.min(Math.max(g.left, 8 - w + 120), vw() - 120); // almeno 120px visibili
            const t = Math.min(Math.max(g.top, 8), vh() - 50);
            Object.assign(win.style, { left: l + 'px', top: t + 'px', width: w + 'px', height: h + 'px', right: 'auto' });
        };
        const current = () => {
            const r = win.getBoundingClientRect(), z = zoom();
            return { left: r.left / z, top: r.top / z, width: r.width / z, height: r.height / z };
        };
        const save = () => { try { localStorage.setItem(GEOM_KEY, JSON.stringify(current())); } catch (e) { /* solo per questa sessione */ } };
        win._applyGeom = () => {
            try {
                const g = JSON.parse(localStorage.getItem(GEOM_KEY) || 'null');
                if (g && [g.left, g.top, g.width, g.height].every(Number.isFinite)) apply(g);
            } catch (e) { /* posizione predefinita */ }
        };
        const start = (e, mode) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const g0 = current();
            const x0 = e.clientX / zoom(), y0 = e.clientY / zoom();
            win.classList.add('apm-dragging');
            const onMove = (ev) => {
                const dx = ev.clientX / zoom() - x0, dy = ev.clientY / zoom() - y0;
                const g = { ...g0 };
                if (mode === 'move') { g.left += dx; g.top += dy; }
                if (mode.includes('r')) g.width = g0.width + dx;
                if (mode.includes('b')) g.height = g0.height + dy;
                if (mode.includes('l')) { g.width = Math.min(Math.max(g0.width - dx, MIN_W), vw() - 16); g.left = g0.left + g0.width - g.width; }
                if (mode === 't') { g.height = Math.min(Math.max(g0.height - dy, MIN_H), vh() - 16); g.top = g0.top + g0.height - g.height; }
                apply(g);
            };
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                win.classList.remove('apm-dragging');
                save();
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
        };
        const head = win.querySelector('.apm-head');
        head.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) start(e, 'move'); });
        head.addEventListener('dblclick', (e) => {
            if (e.target.closest('button')) return;
            ['left', 'top', 'width', 'height', 'right'].forEach((p) => win.style.removeProperty(p));
            try { localStorage.removeItem(GEOM_KEY); } catch (err) { /* niente */ }
        });
        win.querySelectorAll('[data-rs]').forEach((h) => h.addEventListener('pointerdown', (e) => start(e, h.dataset.rs)));
        window.addEventListener('resize', () => { if (win.style.left && win.classList.contains('open')) apply(current()); });
    }

    // --- Contenuto ---
    function disegna(forzaScroll) {
        if (!stato) return;
        const vicinoAlFondo = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 60;
        const ora = (iso) => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
        let html = stato.messaggi.map((m) => {
            if (m.tipo === 'info') return `<div class="apm-msg info">${esc(m.testo)}</div>`;
            const chi = m.tipo === 'ai' ? 'Assistente' : m.tipo === 'utente' ? 'Tu' : '';
            // 👍/👎: dal giorno dopo i suggerimenti votati diventano esempi per l'assistente.
            const voto = m.votabile ? `<div class="apm-voto" data-n="${m.n}">
                <button type="button" class="su${m.voto === 1 ? ' on' : ''}" data-voto="1" title="Utile: suggerimenti così vanno bene"><i class="fas fa-thumbs-up"></i></button>
                <button type="button" class="giu${m.voto === -1 ? ' on' : ''}" data-voto="-1" title="Inutile: suggerimenti così sono da evitare"><i class="fas fa-thumbs-down"></i></button></div>` : '';
            return `<div class="apm-msg ${m.tipo}"><small>${chi ? `${chi} · ` : ''}${ora(m.ora)}</small>${esc(m.testo)}${voto}</div>`;
        }).join('');
        if (!stato.messaggi.length) html = '<div class="apm-msg info">Collegamento in corso…</div>';
        if (stato.inAttesa && stato.attiva) html += '<div class="apm-attesa"><i class="fas fa-ellipsis fa-fade"></i> l\'assistente sta valutando…</div>';
        // Contatore: si vede che l'AI lavora anche quando non ha nulla da suggerire.
        if (stato.attiva && (stato.valutazioni || stato.turniChiesti)) {
            html += `<div class="apm-msg info"><i class="fas fa-chart-simple"></i> ${esc(nomeAi(stato.ai))} ha valutato la riunione ${stato.valutazioni} volt${stato.valutazioni === 1 ? 'a' : 'e'}${stato.silenzi ? `, ${stato.silenzi} senza suggerimenti` : ''}`
                + `${stato.senzaRisposta ? ` · ${stato.senzaRisposta} turni senza risposta` : ''}.</div>`;
        }
        bodyEl.innerHTML = html;
        if (forzaScroll || vicinoAlFondo) bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    function aggiornaStato() {
        const s = stato;
        dotEl.className = 'apm-dot' + (!s || !s.attiva ? ' off' : s.collegata && s.ws && s.ws.readyState === WebSocket.OPEN ? ' on' : '');
        win.classList.toggle('apm-attiva', !!(s && s.attiva && s.avviata));
        sendEl.disabled = !s || !s.attiva;
    }

    // Messaggi e stato arrivati dal server (WebSocket o GET /messaggi).
    function applica(s, d) {
        const nuovi = (Array.isArray(d.messaggi) ? d.messaggi : []).filter((m) => m.n > s.ultimo);
        if (nuovi.length) {
            s.messaggi.push(...nuovi);
            s.ultimo = nuovi[nuovi.length - 1].n;
        }
        const st = d.stato || d;
        if ('attiva' in st) {
            const eraAttiva = s.attiva;
            s.attiva = !!st.attiva && !s.terminata;
            s.collegata = !!st.collegata;
            s.inAttesa = !!st.inAttesa;
            s.valutazioni = Number(st.valutazioni) || 0;
            s.silenzi = Number(st.silenzi) || 0;
            s.turniChiesti = Number(st.turniChiesti) || 0;
            s.senzaRisposta = Number(st.senzaRisposta) || 0;
            if (eraAttiva && !st.attiva && !s.terminata) {
                s.terminata = true;
                if (!nuovi.some((m) => m.tipo === 'errore')) {
                    s.messaggi.push({ n: 0, tipo: 'errore', testo: 'Sessione dell\'assistente chiusa (server riavviato o errore): riavvia la registrazione per riaprirla.', ora: new Date().toISOString() });
                }
            }
        }
        aggiornaStato();
        disegna(false);
    }

    // --- WebSocket con il server ---
    function collegaWs(s) {
        if (s !== stato || !s.attiva || s.terminata) return;
        clearTimeout(s.ricollega);
        let ws;
        try { ws = new WebSocket(`${WS_URL}?id_calendar=${encodeURIComponent(s.eventId)}`); } catch (e) { s.ricollega = setTimeout(() => collegaWs(s), RICOLLEGA_MS); return; }
        ws.binaryType = 'arraybuffer';
        s.ws = ws;
        ws.onopen = () => {
            if (s.ws !== ws) return;
            // Messaggi arrivati mentre il WebSocket era giù.
            ws.send(JSON.stringify({ tipo: 'dopo', n: s.ultimo }));
            aggiornaStato();
        };
        ws.onmessage = (ev) => {
            if (s !== stato || s.ws !== ws) return;
            let d;
            try { d = JSON.parse(ev.data); } catch (e) { return; }
            applica(s, d);
        };
        ws.onclose = (ev) => {
            if (s.ws !== ws) return;
            s.ws = null;
            if (s !== stato) return;
            aggiornaStato();
            if (ev.code === 4401) { mostraErrore('Sessione di login scaduta: accedi di nuovo e riavvia la registrazione.'); return; }
            // 4404 / chiusura normale: la sessione dell'assistente è finita; l'ultimo stato lo dà il server.
            if (ev.code === 4404 || ev.code === 1000) { leggi(); return; }
            if (s.attiva && !s.terminata) s.ricollega = setTimeout(() => collegaWs(s), RICOLLEGA_MS);
        };
        ws.onerror = () => { /* segue onclose */ };
    }

    function scollegaWs(s) {
        if (!s) return;
        clearTimeout(s.ricollega);
        const ws = s.ws;
        s.ws = null;
        try { if (ws) ws.close(1000); } catch (e) { /* già chiuso */ }
    }

    // Lettura via REST: riapertura della finestra, fine della sessione.
    async function leggi() {
        const s = stato;
        if (!s) return;
        try {
            const r = await fetch(`${API_URL}/assistente-pm/messaggi?id_calendar=${encodeURIComponent(s.eventId)}&dopo=${s.ultimo}`, { headers: auth() });
            const d = await r.json().catch(() => ({}));
            if (s === stato && r.ok) applica(s, d);
        } catch (e) { /* rete momentaneamente assente */ }
    }

    // Voto a un suggerimento: stesso pulsante di nuovo = voto tolto. Funziona anche dopo «Ferma»
    // finché il server conserva i messaggi (2 ore).
    async function vota(n, voto) {
        if (!stato || !n) return;
        const s = stato;
        const m = s.messaggi.find((x) => x.n === n && x.votabile);
        if (!m) return;
        const prima = m.voto || 0;
        m.voto = prima === voto ? 0 : voto;
        disegna(false);
        try {
            const r = await fetch(`${API_URL}/assistente-pm/voto`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth() },
                body: JSON.stringify({ id_calendar: s.eventId, n, voto: m.voto })
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || `Errore ${r.status}`);
        } catch (e) {
            m.voto = prima;
            s.messaggi.push({ n: 0, tipo: 'errore', testo: `Voto non salvato: ${e.message}`, ora: new Date().toISOString() });
            disegna(true);
        }
    }

    async function chiedi(testo, mostra) {
        testo = String(testo || '').trim();
        if (!testo || !stato || !stato.attiva) return;
        const s = stato;
        inputEl.value = '';
        sendEl.disabled = true;
        try {
            const r = await fetch(`${API_URL}/assistente-pm/chiedi`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth() },
                body: JSON.stringify({ id_calendar: s.eventId, testo, mostra })
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || `Errore ${r.status}`);
            // La domanda e la risposta arrivano dal WebSocket; senza WebSocket si leggono qui.
            if (!s.ws || s.ws.readyState !== WebSocket.OPEN) leggi();
        } catch (e) {
            s.messaggi.push({ n: 0, tipo: 'errore', testo: e.message, ora: new Date().toISOString() });
            disegna(true);
        } finally {
            aggiornaStato();
        }
    }

    function mostraErrore(testo) {
        stato.attiva = false;
        stato.terminata = true;
        stato.messaggi.push({ n: 0, tipo: 'errore', testo, ora: new Date().toISOString() });
        aggiornaStato();
        disegna(true);
    }

    // Avvio con la registrazione. Se l'assistente è acceso apre la finestra, avvia la sessione e
    // il WebSocket e restituisce true (la dashboard inizia allora a passare l'audio con
    // inviaAudio); false se l'assistente è spento o non parte.
    async function avvia({ eventId, title }) {
        if (!eventId) return false;
        let d;
        try {
            const r = await fetch(`${API_URL}/assistente-pm/config`, { headers: auth() });
            d = await r.json().catch(() => ({}));
            if (!r.ok) {
                // Interruttore acceso ma qualcosa manca (chiave dell'AI, AI non supportata): si mostra.
                crea();
                apri(eventId, title);
                mostraErrore(d.error || `Errore ${r.status}`);
                return false;
            }
        } catch (e) {
            return false; // server non raggiungibile: la registrazione prosegue senza assistente
        }
        if (!d.attiva) return false; // interruttore spento
        crea();
        apri(eventId, title, d.ai);
        const s = stato;
        bodyEl.innerHTML = `<div class="apm-msg info">Collegamento a ${esc(nomeAi(d.ai))}…</div>`;
        try {
            const r = await fetch(`${API_URL}/assistente-pm/avvia`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth() },
                body: JSON.stringify({ id_calendar: eventId, titolo: title || '' })
            });
            const x = await r.json().catch(() => ({}));
            if (s !== stato) return false;
            if (!r.ok || !x.attiva) { mostraErrore(x.error || `Errore ${r.status}`); return false; }
        } catch (e) {
            if (s === stato) mostraErrore('Server non raggiungibile: assistente non avviato.');
            return false;
        }
        s.avviata = true;
        s.attiva = true;
        subEl.textContent = `· ${nomeAi(d.ai)} · ${s.title}`;
        collegaWs(s);
        aggiornaStato();
        return true;
    }

    function apri(eventId, title, ai) {
        if (stato) scollegaWs(stato);
        stato = { eventId, ai: ai || '', title: title || 'Riunione', ultimo: 0, messaggi: [], avviata: false, attiva: false, terminata: false, collegata: false, inAttesa: false, ws: null, ricollega: null, audio: null };
        subEl.textContent = `${ai ? `· ${nomeAi(ai)} ` : ''}· ${stato.title}`;
        win.classList.add('open');
        win._applyGeom();
        aggiornaStato();
        disegna(true);
    }

    const conMessaggi = (s) => !!(s && s.avviata && s.messaggi.some((m) => ['ai', 'utente'].includes(m.tipo)));

    // Fine registrazione (daRegistrazione) o X della finestra: chiude la sessione con l'AI.
    // A fine registrazione, se ci sono suggerimenti, la finestra RESTA APERTA per l'export in
    // Word (il server conserva i messaggi 2 ore); la si chiude con la X.
    async function ferma(eventId, { daRegistrazione = false } = {}) {
        const s = stato;
        if (!s || (eventId && s.eventId !== eventId)) return;
        if (s.terminata) { chiudiFinestra(); return; } // X dopo la fine: solo la finestra
        const tieni = daRegistrazione && conMessaggi(s);
        scollegaWs(s);
        // Risposta: scaricaWord = «Download automatico file Assistente PM» acceso.
        const chiusa = s.avviata ? fetch(`${API_URL}/assistente-pm/ferma`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...auth() },
            body: JSON.stringify({ id_calendar: s.eventId }),
            keepalive: true
        }).then((r) => r.json()).catch(() => ({})) : Promise.resolve({});
        if (!tieni) { chiudiFinestra(); return; }
        const esito = (await chiusa) || {};
        await leggi(); // ultimi messaggi arrivati prima della chiusura
        if (s !== stato) return;
        s.attiva = false;
        s.terminata = true;
        s.messaggi.push({ n: 0, tipo: 'info', ora: new Date().toISOString(),
            testo: esito.scaricaWord
                ? 'Registrazione fermata: l\'assistente è chiuso. Il file Word con i suggerimenti si sta scaricando (download automatico attivo); puoi riscaricarlo con il pulsante Word per 2 ore, poi chiudi la finestra con la X.'
                : 'Registrazione fermata: l\'assistente è chiuso. Usa il pulsante Word in alto per conservare i suggerimenti (disponibili per 2 ore), poi chiudi la finestra con la X.' });
        aggiornaStato();
        disegna(true);
        // Impostazioni › «Download automatico file Assistente PM»: export in Word senza clic.
        if (esito.scaricaWord) esporta();
    }

    // «Chiudi definitivamente» (2026-10-20): la X nasconde soltanto la finestra e l'assistente
    // continua a lavorare; questo pulsante chiude la sessione anche sul server. La registrazione e
    // la trascrizione della riunione proseguono; i messaggi restano 2 ore (pulsante «Assistente PM»).
    async function chiudiDefinitivamente() {
        const s = stato;
        if (!s || !s.attiva || !s.avviata) return;
        if (!confirm('Chiudere definitivamente l\'Assistente PM per questa riunione?\n\nLa registrazione e la trascrizione continuano; l\'assistente non si riapre fino alla prossima registrazione.')) return;
        if (s !== stato) return;
        s.attiva = false;
        s.terminata = true;
        scollegaWs(s);
        try {
            await fetch(`${API_URL}/assistente-pm/ferma`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth() },
                body: JSON.stringify({ id_calendar: s.eventId, definitiva: true }),
                keepalive: true
            });
        } catch (e) { /* server non raggiungibile: la sessione si chiude comunque da sola dopo 4 ore */ }
        if (s === stato) chiudiFinestra();
    }

    function chiudiFinestra() {
        if (stato) scollegaWs(stato);
        stato = null;
        if (win) win.classList.remove('open');
    }

    // Export in Word (GET /assistente-pm/export): suggerimenti, domande e risposte.
    async function esporta() {
        const s = stato;
        if (!s || !s.avviata) return;
        const btn = win.querySelector('.apm-word');
        btn.disabled = true;
        try {
            const r = await fetch(`${API_URL}/assistente-pm/export?id_calendar=${encodeURIComponent(s.eventId)}`, { headers: auth() });
            if (!r.ok) {
                const d = await r.json().catch(() => ({}));
                throw new Error(d.error || `Errore ${r.status}`);
            }
            const blob = await r.blob();
            const cd = r.headers.get('Content-Disposition') || '';
            const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
            const nome = m ? decodeURIComponent(m[1]) : 'Assistente PM.docx';
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = nome;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (e) {
            if (s === stato) {
                s.messaggi.push({ n: 0, tipo: 'errore', testo: `Export non riuscito: ${e.message}`, ora: new Date().toISOString() });
                disegna(true);
            }
        } finally {
            btn.disabled = false;
        }
    }

    const attivo = (eventId) => !!(stato && stato.attiva && stato.eventId === eventId);

    // Audio: campioni PCM 16 bit mono 16 kHz (già mixati dalla dashboard), raccolti in pezzi da
    // ~0,5 s e inviati come frame binari sul WebSocket. Se la rete rallenta (dati in uscita
    // accumulati) o il WebSocket è giù, i pezzi si scartano: per un assistente dal vivo conta il
    // presente.
    const AUDIO_PEZZO = 8000;                 // campioni = 0,5 s
    const AUDIO_MAX_IN_USCITA = 96 * 1024;    // byte non ancora partiti (~3 s)
    function inviaAudio(eventId, samples) {
        const s = stato;
        if (!s || !s.attiva || s.eventId !== eventId || !samples || !samples.length) return;
        if (!s.audio) s.audio = { parti: [], len: 0 };
        const a = s.audio;
        a.parti.push(samples);
        a.len += samples.length;
        if (a.len < AUDIO_PEZZO) return;
        const pcm = new Int16Array(a.len);
        let pos = 0;
        for (const p of a.parti) { pcm.set(p, pos); pos += p.length; }
        a.parti = []; a.len = 0;
        const ws = s.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > AUDIO_MAX_IN_USCITA) return;
        try { ws.send(pcm.buffer); } catch (e) { /* WebSocket in chiusura: il pezzo si perde */ }
    }

    // Riapre la finestra (chiusa con la X, o dopo un ricaricamento della pagina) con i messaggi
    // della sessione, attiva o terminata da meno di 2 ore. Se per la riunione non c'è nessuna
    // sessione e la registrazione è in corso, la avvia come all'inizio. Restituisce true se, con la
    // registrazione in corso, l'assistente è attivo (la dashboard gli passa l'audio), come avvia.
    async function riapri({ eventId, title, registrazioneInCorso = false }) {
        if (!eventId) return false;
        crea();
        if (stato && stato.eventId === eventId && stato.avviata) {
            win.classList.add('open');
            win._applyGeom();
            disegna(true);
            if (!stato.terminata && !stato.ws) collegaWs(stato);
            return !!stato.attiva && registrazioneInCorso;
        }
        let d = {};
        try {
            const r = await fetch(`${API_URL}/assistente-pm/messaggi?id_calendar=${encodeURIComponent(eventId)}&dopo=0`, { headers: auth() });
            d = await r.json().catch(() => ({}));
        } catch (e) { /* server non raggiungibile */ }
        if (!d.sessione) {
            // Nessuna sessione: con la registrazione in corso si avvia.
            if (registrazioneInCorso) return avvia({ eventId, title });
            apri(eventId, title);
            mostraErrore('Nessuna sessione dell\'assistente per questa riunione (i messaggi restano 2 ore dopo la fine della registrazione).');
            return false;
        }
        apri(eventId, d.titolo || title, d.ai || 'Gemini');
        const s = stato;
        s.avviata = true;
        s.terminata = !d.attiva;
        applica(s, d);
        s.attiva = !!d.attiva;
        subEl.textContent = `· ${nomeAi(s.ai)} · ${s.title}`;
        if (s.attiva) collegaWs(s);
        aggiornaStato();
        disegna(true);
        return s.attiva && registrazioneInCorso;
    }

    window.AssistentePm = { avvia, ferma, attivo, inviaAudio, riapri };
})();
