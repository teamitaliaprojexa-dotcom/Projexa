// === Finestra «Assistente PM» durante la registrazione di una riunione ===
//
// Con Impostazioni › «Ai Assistente PM» acceso, all'avvio della registrazione (dashboard,
// startMeetingRecording) si apre questa finestra, che chiede subito la modalità:
//  - Testo: il server Projexa trascrive con Whisper dei blocchi brevi (~10 s) inviati solo per
//    l'assistente e ne manda il testo a Gemini Live;
//  - Audio live: l'audio della riunione va a Gemini in tempo reale (pezzi da ~0,5 s).
// In entrambi i casi Gemini risponde in testo con suggerimenti da project manager senior
// (backend/routes/assistentePm.js).
// La finestra legge risposte e trascrizione ogni pochi secondi; si sposta trascinando la
// testata e si allarga/allunga dai bordi e dall'angolo (posizione e dimensioni restano nel
// browser). Fermando la registrazione la sessione si chiude.
(function () {
    'use strict';

    const API_URL = location.origin + '/api';
    const GEOM_KEY = 'assistentePmGeom';
    const MODO_KEY = 'assistentePmModo'; // ultima modalità scelta (solo evidenziata)
    const POLL_MS = 3000;
    const MIN_W = 300, MIN_H = 220;

    const auth = () => {
        const t = localStorage.getItem('authToken');
        return t ? { Authorization: `Bearer ${t}` } : {};
    };
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    .apm-tabs { display: flex; border-bottom: 1px solid #E5E7EB; flex: none; background: #F8FAFC; }
    .apm-tabs button { flex: 1; border: none; background: none; padding: 7px 4px; cursor: pointer; font: inherit; font-size: 13px; color: #64748B; border-bottom: 2px solid transparent; }
    .apm-tabs button.active { color: #4338CA; border-bottom-color: #6366F1; font-weight: 600; }
    .apm-body { flex: 1; overflow-y: auto; padding: 10px 12px; background: #fff; min-height: 0; }
    .apm-msg { margin: 0 0 8px; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; }
    .apm-msg small { display: block; font-size: 11px; color: #94A3B8; margin-bottom: 2px; }
    .apm-msg.ai { background: #EEF2FF; border-left: 3px solid #6366F1; }
    .apm-msg.utente { background: #F1F5F9; margin-left: 24px; }
    .apm-msg.info { color: #64748B; font-size: 12.5px; background: none; padding: 2px 0; }
    .apm-msg.avviso { background: #FFFBEB; color: #92400E; font-size: 12.5px; }
    .apm-msg.errore { background: #FEF2F2; color: #B91C1C; }
    .apm-msg.trascrizione { background: #F8FAFC; font-size: 12.5px; color: #334155; }
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
    .apm-win.apm-scegli .apm-tabs, .apm-win.apm-scegli .apm-foot { display: none; }
    .apm-chiedi { margin: 4px 0 10px; font-weight: 600; color: #312E81; }
    .apm-modo {
        display: flex; gap: 12px; align-items: flex-start; width: 100%; text-align: left; cursor: pointer;
        margin: 0 0 10px; padding: 12px; border: 1px solid #C7D2FE; border-radius: 10px; background: #fff; font: inherit; color: inherit;
    }
    .apm-modo:hover { background: #EEF2FF; border-color: #6366F1; }
    .apm-modo.preferita { border-width: 2px; border-color: #6366F1; }
    .apm-modo i { font-size: 22px; color: #4F46E5; margin-top: 2px; width: 26px; text-align: center; }
    .apm-modo b { display: block; margin-bottom: 2px; }
    .apm-modo em { display: block; font-style: normal; font-size: 12.5px; color: #475569; }
    .apm-nota { font-size: 12px; color: #64748B; margin: 4px 0 0; }
    .apm-rs-bl { left: 0; bottom: 0; width: 14px; height: 14px; cursor: nesw-resize; z-index: 2; }
    `;

    let win = null, bodyEl = null, dotEl = null, subEl = null, inputEl = null, sendEl = null;
    let stato = null; // { eventId, ultimo, timer, messaggi: [], tab, attiva }

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
                <button type="button" class="apm-word" title="Esporta in Word: suggerimenti e trascrizione live"><i class="fas fa-file-word"></i></button>
                <button type="button" class="apm-close" title="Chiudi l'assistente (la registrazione continua)"><i class="fas fa-xmark"></i></button>
            </div>
            <div class="apm-tabs">
                <button type="button" data-tab="ai" class="active"><i class="fas fa-lightbulb"></i> Suggerimenti</button>
                <button type="button" data-tab="trascrizione"><i class="fas fa-closed-captioning"></i> Trascrizione live</button>
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
        // «Assistente PM» del riquadro della registrazione (riapri). Durante la scelta della
        // modalità, o se l'avvio non è riuscito, la X annulla.
        win.querySelector('.apm-close').addEventListener('click', () => {
            if (!stato) return;
            if (stato.modalita) win.classList.remove('open');
            else ferma(stato.eventId);
        });
        win.querySelector('.apm-word').addEventListener('click', esporta);
        win.querySelectorAll('.apm-tabs button').forEach((b) => b.addEventListener('click', () => {
            if (!stato) return;
            stato.tab = b.dataset.tab;
            win.querySelectorAll('.apm-tabs button').forEach((x) => x.classList.toggle('active', x === b));
            disegna(true);
        }));
        sendEl.addEventListener('click', () => chiedi(inputEl.value));
        win.querySelector('.apm-hint').addEventListener('click', () =>
            chiedi('Su quanto detto finora: qual è la domanda più importante da fare adesso, e c\'è un rischio o una decisione da fissare?', 'Suggeriscimi qualcosa adesso'));
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chiedi(inputEl.value); }
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
        const voci = stato.messaggi.filter((m) => (stato.tab === 'trascrizione'
            ? (m.tipo === 'trascrizione' || m.tipo === 'avviso')
            : m.tipo !== 'trascrizione'));
        let html = voci.map((m) => {
            if (m.tipo === 'info') return `<div class="apm-msg info">${esc(m.testo)}</div>`;
            const chi = m.tipo === 'ai' ? 'Assistente' : m.tipo === 'utente' ? 'Tu' : '';
            return `<div class="apm-msg ${m.tipo}"><small>${chi ? `${chi} · ` : ''}${ora(m.ora)}</small>${esc(m.testo)}</div>`;
        }).join('');
        if (!voci.length) {
            html = stato.tab === 'trascrizione'
                ? (stato.modalita === 'audio'
                    ? '<div class="apm-msg info">Qui compare il testo di ciò che Gemini sente (solo in questa finestra, non viene salvato).</div>'
                    : '<div class="apm-msg info">La trascrizione per l\'assistente compare qui ogni 10 secondi circa.</div>')
                : '<div class="apm-msg info">Collegamento in corso…</div>';
        }
        if (stato.tab === 'ai' && stato.inAttesa && stato.attiva) html += '<div class="apm-attesa"><i class="fas fa-ellipsis fa-fade"></i> l\'assistente sta leggendo…</div>';
        // Contatore: si vede che Gemini lavora anche quando non ha nulla da suggerire.
        if (stato.tab === 'ai' && stato.attiva && (stato.valutazioni || stato.turniChiesti)) {
            html += `<div class="apm-msg info"><i class="fas fa-chart-simple"></i> Gemini ha valutato la riunione ${stato.valutazioni} volt${stato.valutazioni === 1 ? 'a' : 'e'}${stato.silenzi ? `, ${stato.silenzi} senza suggerimenti` : ''}`
                + (stato.modalita === 'audio' ? ` · turni chiesti ${stato.turniChiesti}${stato.senzaRisposta ? `, ${stato.senzaRisposta} senza risposta` : ''}` : '') + '.</div>';
        }
        bodyEl.innerHTML = html;
        if (forzaScroll || vicinoAlFondo) bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    function aggiornaStato(collegata) {
        dotEl.className = 'apm-dot' + (!stato || !stato.attiva ? ' off' : collegata ? ' on' : '');
        sendEl.disabled = !stato || !stato.attiva;
    }

    async function leggi() {
        if (!stato) return;
        const s = stato;
        try {
            const r = await fetch(`${API_URL}/assistente-pm/messaggi?id_calendar=${encodeURIComponent(s.eventId)}&dopo=${s.ultimo}`, { headers: auth() });
            const d = await r.json().catch(() => ({}));
            if (s !== stato) return;
            if (r.ok) {
                const nuovi = Array.isArray(d.messaggi) ? d.messaggi : [];
                if (nuovi.length) {
                    s.messaggi.push(...nuovi);
                    s.ultimo = nuovi[nuovi.length - 1].n;
                }
                const eraAttiva = s.attiva;
                s.attiva = !!d.attiva;
                s.inAttesa = !!d.inAttesa;
                s.valutazioni = Number(d.valutazioni) || 0;
                s.silenzi = Number(d.silenzi) || 0;
                s.turniChiesti = Number(d.turniChiesti) || 0;
                s.senzaRisposta = Number(d.senzaRisposta) || 0;
                if (eraAttiva && !s.attiva && !nuovi.some((m) => m.tipo === 'errore')) {
                    s.messaggi.push({ n: 0, tipo: 'errore', testo: 'Sessione dell\'assistente chiusa (server riavviato o errore): riavvia la registrazione per riaprirla.', ora: new Date().toISOString() });
                }
                aggiornaStato(d.collegata);
                disegna(false);
                if (!s.attiva) { clearInterval(s.timer); s.timer = null; s.terminata = true; }
            }
        } catch (e) { /* rete momentaneamente assente: si riprova al prossimo giro */ }
    }

    async function chiedi(testo, mostra) {
        testo = String(testo || '').trim();
        if (!testo || !stato || !stato.attiva) return;
        inputEl.value = '';
        sendEl.disabled = true;
        try {
            const r = await fetch(`${API_URL}/assistente-pm/chiedi`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth() },
                body: JSON.stringify({ id_calendar: stato.eventId, testo, mostra })
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || `Errore ${r.status}`);
            leggi();
        } catch (e) {
            stato.messaggi.push({ n: 0, tipo: 'errore', testo: e.message, ora: new Date().toISOString() });
            disegna(true);
        } finally {
            aggiornaStato(true);
        }
    }

    function mostraErrore(testo) {
        stato.attiva = false;
        stato.messaggi.push({ n: 0, tipo: 'errore', testo, ora: new Date().toISOString() });
        win.classList.remove('apm-scegli');
        aggiornaStato(false);
        disegna(true);
    }

    // Avvio con la registrazione. Se l'assistente è acceso apre la finestra con la scelta della
    // modalità e restituisce, a scelta fatta, 'testo' o 'audio' (la dashboard inizia allora a
    // mandare i blocchi brevi o l'audio live); null se l'assistente è spento o non parte.
    async function avvia({ eventId, title }) {
        if (!eventId) return null;
        let d;
        try {
            const r = await fetch(`${API_URL}/assistente-pm/config`, { headers: auth() });
            d = await r.json().catch(() => ({}));
            if (!r.ok) {
                // Interruttore acceso ma qualcosa manca (chiave Gemini, AI non supportata): si mostra.
                crea();
                apri(eventId, title);
                mostraErrore(d.error || `Errore ${r.status}`);
                return null;
            }
        } catch (e) {
            return null; // server non raggiungibile: la registrazione prosegue senza assistente
        }
        if (!d.attiva) return null; // interruttore spento
        crea();
        apri(eventId, title, d.ai);
        const s = stato;
        const modalita = await new Promise((resolve) => { s.scelta = resolve; disegnaScelta(); });
        if (!modalita || s !== stato) return null; // finestra chiusa o registrazione fermata
        try {
            const r = await fetch(`${API_URL}/assistente-pm/avvia`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth() },
                body: JSON.stringify({ id_calendar: eventId, titolo: title || '', modalita })
            });
            const x = await r.json().catch(() => ({}));
            if (s !== stato) return null;
            if (!r.ok || !x.attiva) { mostraErrore(x.error || `Errore ${r.status}`); return null; }
        } catch (e) {
            if (s === stato) mostraErrore('Server non raggiungibile: assistente non avviato.');
            return null;
        }
        s.modalita = modalita;
        s.attiva = true;
        win.classList.remove('apm-scegli');
        subEl.textContent = `· ${d.ai} · ${modalita === 'audio' ? 'Audio live' : 'Testo'} · ${s.title}`;
        s.timer = setInterval(leggi, POLL_MS);
        leggi();
        return modalita;
    }

    // Scelta della modalità, appena si apre la finestra. L'ultima scelta resta evidenziata.
    function disegnaScelta() {
        let ultima = 'testo';
        try { ultima = localStorage.getItem(MODO_KEY) === 'audio' ? 'audio' : 'testo'; } catch (e) { /* predefinita */ }
        const voce = (m, icona, titolo, testo) => `<button type="button" class="apm-modo${m === ultima ? ' preferita' : ''}" data-modo="${m}">
                <i class="fas ${icona}"></i><span><b>${titolo}</b><em>${testo}</em></span></button>`;
        win.classList.add('apm-scegli');
        bodyEl.innerHTML = `<p class="apm-chiedi">Come vuoi che l'assistente segua questa riunione?</p>`
            + voce('testo', 'fa-file-lines', 'Testo', 'Projexa trascrive la riunione ogni ~10 secondi e manda il testo a Gemini. Consuma meno e la riunione non esce dal server di Projexa come audio.')
            + voce('audio', 'fa-microphone-lines', 'Audio live', 'L\'audio della riunione va a Gemini in tempo reale: suggerimenti più rapidi, ma costa di più (Gemini fattura l\'audio ascoltato).')
            + '<p class="apm-nota">In entrambi i casi Gemini risponde in testo qui e la trascrizione della riunione resta quella di Projexa.</p>';
        bodyEl.querySelectorAll('.apm-modo').forEach((b) => b.addEventListener('click', () => {
            const m = b.dataset.modo;
            try { localStorage.setItem(MODO_KEY, m); } catch (e) { /* solo preferenza */ }
            bodyEl.innerHTML = '<div class="apm-msg info">Collegamento a Gemini Live…</div>';
            const r = stato && stato.scelta;
            if (stato) stato.scelta = null;
            if (r) r(m);
        }));
    }

    function apri(eventId, title, ai) {
        if (stato && stato.timer) clearInterval(stato.timer);
        if (stato && stato.scelta) stato.scelta(null);
        stato = { eventId, title: title || 'Riunione', ultimo: 0, timer: null, messaggi: [], tab: 'ai', attiva: false, inAttesa: false, scelta: null, audio: null };
        subEl.textContent = `${ai ? `· ${ai} ` : ''}· ${stato.title}`;
        win.querySelectorAll('.apm-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'ai'));
        win.classList.add('open');
        win._applyGeom();
        aggiornaStato(false);
        disegna(true);
    }

    const conMessaggi = (s) => !!(s && s.modalita && s.messaggi.some((m) => ['ai', 'utente', 'trascrizione'].includes(m.tipo)));

    // Fine registrazione (daRegistrazione) o X della finestra: chiude la sessione con Gemini.
    // A fine registrazione, se ci sono suggerimenti o trascrizione, la finestra RESTA APERTA
    // per l'export in Word (il server conserva i messaggi 2 ore); la si chiude con la X.
    async function ferma(eventId, { daRegistrazione = false } = {}) {
        const s = stato;
        if (!s || (eventId && s.eventId !== eventId)) return;
        if (s.terminata) { chiudiFinestra(); return; } // X dopo la fine: solo la finestra
        if (s.timer) clearInterval(s.timer);
        s.timer = null;
        if (s.scelta) s.scelta(null);
        const tieni = daRegistrazione && conMessaggi(s);
        const chiusa = fetch(`${API_URL}/assistente-pm/ferma`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...auth() },
            body: JSON.stringify({ id_calendar: s.eventId }),
            keepalive: true
        }).catch(() => {});
        if (!tieni) { chiudiFinestra(); return; }
        s.attiva = false;
        s.terminata = true;
        await chiusa;
        await leggi(); // ultimi messaggi arrivati prima della chiusura
        if (s !== stato) return;
        s.messaggi.push({ n: 0, tipo: 'info', ora: new Date().toISOString(),
            testo: 'Registrazione fermata: l\'assistente è chiuso. Usa il pulsante Word in alto per conservare suggerimenti e trascrizione (disponibili per 2 ore), poi chiudi la finestra con la X.' });
        aggiornaStato(false);
        disegna(true);
    }

    function chiudiFinestra() {
        if (stato && stato.timer) clearInterval(stato.timer);
        if (stato && stato.scelta) stato.scelta(null);
        stato = null;
        if (win) { win.classList.remove('open'); win.classList.remove('apm-scegli'); }
    }

    // Export in Word (GET /assistente-pm/export): suggerimenti e poi trascrizione live.
    async function esporta() {
        const s = stato;
        if (!s || !s.modalita) return;
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

    // Blocco breve già pronto (WAV base64 + volumi), preparato dalla dashboard.
    function inviaBlocco(payload) {
        if (!stato || !stato.attiva || payload.id_calendar !== stato.eventId) return;
        fetch(`${API_URL}/assistente-pm/blocco`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...auth() },
            body: JSON.stringify(payload)
        }).then((r) => { if (r.status === 404) leggi(); }).catch(() => {});
    }

    // Audio live: campioni PCM 16 bit mono 16 kHz (già mixati dalla dashboard), raccolti in
    // pezzi da ~0,5 s e inviati in ordine. Se la rete rallenta e i pezzi in attesa si
    // accumulano, si scartano i più vecchi: per un assistente dal vivo conta il presente.
    const AUDIO_PEZZO = 8000;      // campioni = 0,5 s
    const AUDIO_MAX_ATTESA = 6;    // pezzi in coda (~3 s)
    function inviaAudio(eventId, samples) {
        const s = stato;
        if (!s || !s.attiva || s.modalita !== 'audio' || s.eventId !== eventId || !samples || !samples.length) return;
        if (!s.audio) s.audio = { parti: [], len: 0, coda: [], inVolo: false };
        const a = s.audio;
        a.parti.push(samples);
        a.len += samples.length;
        if (a.len < AUDIO_PEZZO) return;
        const pcm = new Int16Array(a.len);
        let pos = 0;
        for (const p of a.parti) { pcm.set(p, pos); pos += p.length; }
        a.parti = []; a.len = 0;
        a.coda.push(pcmBase64(pcm));
        if (a.coda.length > AUDIO_MAX_ATTESA) a.coda.splice(0, a.coda.length - AUDIO_MAX_ATTESA);
        spedisciAudio(s);
    }

    function pcmBase64(pcm) {
        const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength); // little-endian come il browser
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin);
    }

    async function spedisciAudio(s) {
        const a = s.audio;
        if (a.inVolo) return;
        a.inVolo = true;
        try {
            while (a.coda.length && s === stato && s.attiva) {
                const pcm = a.coda.shift();
                try {
                    const r = await fetch(`${API_URL}/assistente-pm/audio`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...auth() },
                        body: JSON.stringify({ id_calendar: s.eventId, pcm })
                    });
                    if (r.status === 404) { leggi(); break; }
                } catch (e) { /* rete assente: il pezzo si perde, si continua col successivo */ }
            }
        } finally {
            a.inVolo = false;
        }
    }

    // Riapre la finestra (chiusa con la X, o dopo un ricaricamento della pagina) con i messaggi
    // della sessione, attiva o terminata da meno di 2 ore. Se per la riunione non c'è nessuna
    // sessione e la registrazione è in corso, la avvia come all'inizio: restituisce allora la
    // modalità scelta ('testo' | 'audio'), come avvia; altrimenti null.
    async function riapri({ eventId, title, registrazioneInCorso = false }) {
        if (!eventId) return null;
        crea();
        if (stato && stato.eventId === eventId && stato.modalita) {
            win.classList.add('open');
            win._applyGeom();
            disegna(true);
            if (!stato.terminata) leggi();
            return null;
        }
        let d = {};
        try {
            const r = await fetch(`${API_URL}/assistente-pm/messaggi?id_calendar=${encodeURIComponent(eventId)}&dopo=0`, { headers: auth() });
            d = await r.json().catch(() => ({}));
        } catch (e) { /* server non raggiungibile */ }
        const messaggi = Array.isArray(d.messaggi) ? d.messaggi : [];
        if (!d.modalita) {
            // Nessuna sessione: con la registrazione in corso si avvia (scelta della modalità).
            if (registrazioneInCorso) return avvia({ eventId, title });
            apri(eventId, title);
            mostraErrore('Nessuna sessione dell\'assistente per questa riunione (i messaggi restano 2 ore dopo la fine della registrazione).');
            return null;
        }
        apri(eventId, d.titolo || title, 'Gemini');
        const s = stato;
        s.modalita = d.modalita;
        s.messaggi = messaggi;
        s.ultimo = messaggi.length ? messaggi[messaggi.length - 1].n : 0;
        s.attiva = !!d.attiva;
        s.terminata = !d.attiva;
        subEl.textContent = `· Gemini · ${d.modalita === 'audio' ? 'Audio live' : 'Testo'} · ${s.title}`;
        if (s.attiva) { s.timer = setInterval(leggi, POLL_MS); leggi(); }
        aggiornaStato(!!d.collegata);
        disegna(true);
        return null;
    }

    window.AssistentePm = { avvia, ferma, attivo, inviaBlocco, inviaAudio, riapri };
})();
