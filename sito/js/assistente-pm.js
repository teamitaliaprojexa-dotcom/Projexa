// === Finestra «Assistente PM» durante la registrazione di una riunione ===
//
// Con Impostazioni › «Ai Assistente PM» acceso, all'avvio della registrazione (dashboard,
// startMeetingRecording) si apre questa finestra: il server Projexa trascrive con Whisper dei
// blocchi brevi (~25 s) inviati solo per l'assistente e ne manda il testo a Gemini Live, che
// risponde con suggerimenti da project manager senior (backend/routes/assistentePm.js).
// La finestra legge risposte e trascrizione ogni pochi secondi; si sposta trascinando la
// testata e si allarga/allunga dai bordi e dall'angolo (posizione e dimensioni restano nel
// browser). Fermando la registrazione la sessione si chiude.
(function () {
    'use strict';

    const API_URL = location.origin + '/api';
    const GEOM_KEY = 'assistentePmGeom';
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

        win.querySelector('.apm-close').addEventListener('click', () => { if (stato) ferma(stato.eventId); });
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
                ? '<div class="apm-msg info">La trascrizione per l\'assistente compare qui ogni mezzo minuto circa.</div>'
                : '<div class="apm-msg info">Collegamento in corso…</div>';
        }
        if (stato.tab === 'ai' && stato.inAttesa && stato.attiva) html += '<div class="apm-attesa"><i class="fas fa-ellipsis fa-fade"></i> l\'assistente sta leggendo…</div>';
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
                if (eraAttiva && !s.attiva && !nuovi.some((m) => m.tipo === 'errore')) {
                    s.messaggi.push({ n: 0, tipo: 'errore', testo: 'Sessione dell\'assistente chiusa (server riavviato o errore): riavvia la registrazione per riaprirla.', ora: new Date().toISOString() });
                }
                aggiornaStato(d.collegata);
                disegna(false);
                if (!s.attiva) { clearInterval(s.timer); s.timer = null; }
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

    // Avvio con la registrazione. Restituisce true se l'assistente è attivo (la dashboard
    // inizia allora a mandare i blocchi brevi).
    async function avvia({ eventId, title }) {
        if (!eventId) return false;
        let d;
        try {
            const r = await fetch(`${API_URL}/assistente-pm/avvia`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth() },
                body: JSON.stringify({ id_calendar: eventId, titolo: title || '' })
            });
            d = await r.json().catch(() => ({}));
            if (!r.ok) {
                // Interruttore acceso ma qualcosa manca (chiave Gemini, AI non supportata): si mostra.
                crea();
                apri(eventId, title);
                stato.attiva = false;
                stato.messaggi.push({ n: 0, tipo: 'errore', testo: d.error || `Errore ${r.status}`, ora: new Date().toISOString() });
                aggiornaStato(false);
                disegna(true);
                return false;
            }
        } catch (e) {
            return false; // server non raggiungibile: la registrazione prosegue senza assistente
        }
        if (!d.attiva) return false; // interruttore spento
        crea();
        apri(eventId, title, d.ai);
        stato.timer = setInterval(leggi, POLL_MS);
        leggi();
        return true;
    }

    function apri(eventId, title, ai) {
        if (stato && stato.timer) clearInterval(stato.timer);
        stato = { eventId, ultimo: 0, timer: null, messaggi: [], tab: 'ai', attiva: true, inAttesa: false };
        subEl.textContent = `${ai ? `· ${ai} ` : ''}· ${title || 'Riunione'}`;
        win.querySelectorAll('.apm-tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'ai'));
        win.classList.add('open');
        win._applyGeom();
        aggiornaStato(false);
        disegna(true);
    }

    // Fine registrazione (o X della finestra): chiude la sessione e la finestra.
    function ferma(eventId) {
        if (!stato || (eventId && stato.eventId !== eventId)) return;
        const id = stato.eventId;
        if (stato.timer) clearInterval(stato.timer);
        stato = null;
        if (win) win.classList.remove('open');
        fetch(`${API_URL}/assistente-pm/ferma`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...auth() },
            body: JSON.stringify({ id_calendar: id }),
            keepalive: true
        }).catch(() => {});
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

    window.AssistentePm = { avvia, ferma, attivo, inviaBlocco };
})();
