// === Assistente "Projexa" (chatbot AI in basso a destra nella dashboard) ===
//
// Pulsante con il logo Projexa e il badge "AI": si trascina tenendo premuto (mouse o dito)
// e resta dove lo si rilascia (posizione ricordata nel browser). Un clic apre la chat.
// Le risposte arrivano da /api/chatbot (Gemini + Manuale Utente, vedi backend/routes/chatbot.js).
// La conversazione resta finché la scheda è aperta (sessionStorage).
(function () {
    'use strict';

    const API_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? location.origin
        : (location.hostname.endsWith('github.io') ? 'https://projexa-4mix.onrender.com' : location.origin)) + '/api';
    const POS_KEY = 'projexaChatbotPos';
    const HISTORY_KEY = 'projexaChatbotStoria';
    const GREETING = 'Ciao sono Projexa, come posso aiutarti?';
    const BTN_SIZE = 60;
    const MARGIN = 12;
    const DRAG_THRESHOLD = 5;

    const store = {
        get(k, storage) { try { return JSON.parse(storage.getItem(k)); } catch { return null; } },
        set(k, v, storage) { try { storage.setItem(k, JSON.stringify(v)); } catch { /* storage non disponibile */ } },
        del(k, storage) { try { storage.removeItem(k); } catch { /* storage non disponibile */ } }
    };

    const css = `
    .pxbot-btn {
        position: fixed; z-index: 785; width: ${BTN_SIZE}px; height: ${BTN_SIZE}px; border-radius: 50%;
        background: #fff; border: none; padding: 0; cursor: grab; touch-action: none; user-select: none;
        box-shadow: 0 6px 20px rgba(59, 70, 246, 0.28), 0 2px 6px rgba(0, 0, 0, 0.12);
        display: flex; align-items: center; justify-content: center; transition: box-shadow .2s, transform .2s;
    }
    .pxbot-btn:hover { box-shadow: 0 8px 26px rgba(124, 58, 237, 0.38), 0 2px 6px rgba(0, 0, 0, 0.12); transform: translateY(-1px); }
    .pxbot-btn.dragging { cursor: grabbing; transform: scale(1.06); transition: none; }
    .pxbot-btn:focus-visible { outline: 3px solid #93C5FD; outline-offset: 2px; }
    .pxbot-btn img { width: 36px; height: 36px; pointer-events: none; -webkit-user-drag: none; }
    .pxbot-badge {
        position: absolute; top: -4px; right: -8px; padding: 2px 6px; border-radius: 999px;
        background: linear-gradient(135deg, #2563EB, #7C3AED); color: #fff; font: 700 10px/1.3 system-ui, sans-serif;
        letter-spacing: .04em; box-shadow: 0 0 0 2px #fff; pointer-events: none; white-space: nowrap;
    }
    .pxbot-panel {
        position: fixed; z-index: 830; width: 370px; height: 540px; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px);
        background: #fff; border-radius: 16px; box-shadow: 0 18px 50px rgba(15, 23, 42, 0.28);
        display: none; flex-direction: column; overflow: hidden; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    }
    .pxbot-panel.open { display: flex; }
    .pxbot-head {
        display: flex; align-items: center; gap: 10px; padding: 12px 14px; color: #fff;
        background: linear-gradient(135deg, #2563EB, #7C3AED);
    }
    .pxbot-head .pxbot-avatar { width: 34px; height: 34px; border-radius: 50%; background: #fff; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
    .pxbot-head .pxbot-avatar img { width: 22px; height: 22px; }
    .pxbot-head .pxbot-title { flex: 1 1 auto; min-width: 0; line-height: 1.2; }
    .pxbot-head .pxbot-title strong { display: block; font-size: 15px; }
    .pxbot-head .pxbot-title span { font-size: 12px; opacity: .9; }
    .pxbot-head button { background: rgba(255,255,255,.18); border: none; color: #fff; width: 30px; height: 30px; border-radius: 8px; cursor: pointer; font-size: 14px; }
    .pxbot-head button:hover { background: rgba(255,255,255,.3); }
    .pxbot-msgs { flex: 1 1 auto; overflow-y: auto; padding: 14px; background: #F8FAFC; display: flex; flex-direction: column; gap: 10px; }
    .pxbot-msg { max-width: 86%; padding: 9px 12px; border-radius: 14px; font-size: 14px; line-height: 1.45; word-wrap: break-word; overflow-wrap: anywhere; }
    .pxbot-msg.bot { align-self: flex-start; background: #fff; color: #1F2937; border: 1px solid #E5E7EB; border-bottom-left-radius: 4px; }
    .pxbot-msg.user { align-self: flex-end; background: #2563EB; color: #fff; border-bottom-right-radius: 4px; white-space: pre-wrap; }
    .pxbot-msg.error { align-self: flex-start; background: #FEF2F2; color: #991B1B; border: 1px solid #FECACA; }
    .pxbot-msg ol, .pxbot-msg ul { margin: 4px 0 4px 18px; padding: 0; }
    .pxbot-msg li { margin: 2px 0; }
    .pxbot-msg p { margin: 0 0 6px; }
    .pxbot-msg p:last-child { margin-bottom: 0; }
    .pxbot-typing { align-self: flex-start; color: #6B7280; font-size: 13px; font-style: italic; padding: 2px 4px; }
    .pxbot-form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #E5E7EB; background: #fff; align-items: flex-end; }
    .pxbot-form textarea {
        flex: 1 1 auto; resize: none; border: 1px solid #D1D5DB; border-radius: 10px; padding: 9px 11px;
        font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; max-height: 120px; min-height: 40px;
    }
    .pxbot-form textarea:focus { outline: none; border-color: #3B82F6; box-shadow: 0 0 0 3px rgba(59,130,246,.18); }
    .pxbot-form button {
        flex: 0 0 auto; width: 42px; height: 40px; border: none; border-radius: 10px; cursor: pointer; color: #fff;
        background: linear-gradient(135deg, #2563EB, #7C3AED); font-size: 15px;
    }
    .pxbot-form button:disabled { opacity: .5; cursor: not-allowed; }
    .pxbot-foot { font-size: 11px; color: #9CA3AF; text-align: center; padding: 0 10px 8px; background: #fff; }
    @media (max-width: 480px) {
        .pxbot-panel { width: calc(100vw - 16px); height: calc(100vh - 90px); }
    }`;

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // Markdown essenziale delle risposte: grassetto, corsivo, elenchi puntati/numerati, paragrafi.
    function renderMarkdown(text) {
        const inline = (t) => esc(t)
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
            .replace(/`([^`]+)`/g, '<code>$1</code>');
        const out = [];
        let list = null;
        const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
        for (const raw of String(text).split('\n')) {
            const line = raw.trimEnd();
            const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
            const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
            if (ol || ul) {
                const tag = ol ? 'ol' : 'ul';
                if (list !== tag) { closeList(); out.push(`<${tag}>`); list = tag; }
                out.push(`<li>${inline((ol || ul)[1])}</li>`);
            } else if (!line.trim()) {
                closeList();
            } else {
                closeList();
                out.push(`<p>${inline(line.replace(/^#+\s*/, ''))}</p>`);
            }
        }
        closeList();
        return out.join('');
    }

    function init() {
        if (!localStorage.getItem('authToken') || document.querySelector('.pxbot-btn')) return;

        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pxbot-btn';
        btn.title = 'Projexa AI – assistente (tieni premuto per spostarlo)';
        btn.setAttribute('aria-label', 'Apri l\'assistente AI Projexa');
        btn.innerHTML = '<img src="Logo_Projexa_P.png" alt=""><span class="pxbot-badge">✦ AI</span>';

        const panel = document.createElement('div');
        panel.className = 'pxbot-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Assistente AI Projexa');
        panel.innerHTML = `
            <div class="pxbot-head">
                <div class="pxbot-avatar"><img src="Logo_Projexa_P.png" alt=""></div>
                <div class="pxbot-title"><strong>Projexa</strong><span>✦ Assistente AI</span></div>
                <button type="button" class="pxbot-new" title="Nuova conversazione" aria-label="Nuova conversazione">⟲</button>
                <button type="button" class="pxbot-close" title="Chiudi" aria-label="Chiudi">✕</button>
            </div>
            <div class="pxbot-msgs" aria-live="polite"></div>
            <form class="pxbot-form">
                <textarea rows="1" maxlength="2000" placeholder="Scrivi la tua domanda… es. come creo un nuovo progetto?"></textarea>
                <button type="submit" title="Invia" aria-label="Invia">➤</button>
            </form>
            <div class="pxbot-foot">Risposte generate dall'AI in base al Manuale Utente: possono contenere errori.</div>`;

        document.body.appendChild(btn);
        document.body.appendChild(panel);

        const msgsEl = panel.querySelector('.pxbot-msgs');
        const form = panel.querySelector('.pxbot-form');
        const input = form.querySelector('textarea');
        const sendBtn = form.querySelector('button');
        let storia = store.get(HISTORY_KEY, sessionStorage) || [];
        let busy = false;

        // --- Posizione del pulsante ---
        function clamp(x, y) {
            return {
                x: Math.min(Math.max(MARGIN, x), window.innerWidth - BTN_SIZE - MARGIN),
                y: Math.min(Math.max(MARGIN, y), window.innerHeight - BTN_SIZE - MARGIN)
            };
        }
        function place(x, y) {
            const p = clamp(x, y);
            btn.style.left = p.x + 'px';
            btn.style.top = p.y + 'px';
            return p;
        }
        // La posizione si ricorda in proporzione alla finestra, così resta sensata se cambia dimensione.
        function savePos(p) {
            store.set(POS_KEY, { rx: p.x / window.innerWidth, ry: p.y / window.innerHeight }, localStorage);
        }
        function restorePos() {
            const s = store.get(POS_KEY, localStorage);
            if (s && typeof s.rx === 'number' && typeof s.ry === 'number') {
                place(s.rx * window.innerWidth, s.ry * window.innerHeight);
            } else {
                place(window.innerWidth - BTN_SIZE - 24, window.innerHeight - BTN_SIZE - 24);
            }
        }
        restorePos();
        window.addEventListener('resize', () => { restorePos(); if (panel.classList.contains('open')) placePanel(); });

        // --- Trascinamento (tieni premuto e sposta; al rilascio resta lì) ---
        let drag = null;
        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const r = btn.getBoundingClientRect();
            drag = { startX: e.clientX, startY: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
            btn.setPointerCapture(e.pointerId);
        });
        btn.addEventListener('pointermove', (e) => {
            if (!drag) return;
            if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
            drag.moved = true;
            btn.classList.add('dragging');
            place(e.clientX - drag.dx, e.clientY - drag.dy);
            if (panel.classList.contains('open')) placePanel();
        });
        function endDrag(e) {
            if (!drag) return;
            const moved = drag.moved;
            drag = null;
            btn.classList.remove('dragging');
            try { btn.releasePointerCapture(e.pointerId); } catch { /* già rilasciato */ }
            if (moved) {
                const r = btn.getBoundingClientRect();
                savePos({ x: r.left, y: r.top });
            } else {
                toggle();
            }
        }
        btn.addEventListener('pointerup', endDrag);
        btn.addEventListener('pointercancel', (e) => { if (drag) { drag.moved = true; endDrag(e); } });
        // Da tastiera (Invio/Spazio) il "click" arriva senza pointer events
        btn.addEventListener('click', (e) => { if (e.detail === 0) toggle(); });

        // --- Pannello: si apre accanto al pulsante, dal lato dove c'è spazio ---
        function placePanel() {
            const r = btn.getBoundingClientRect();
            const pw = panel.offsetWidth, ph = panel.offsetHeight;
            let left = r.left + r.width / 2 > window.innerWidth / 2 ? r.right - pw : r.left;
            let top = r.top + r.height / 2 > window.innerHeight / 2 ? r.top - ph - 12 : r.bottom + 12;
            left = Math.min(Math.max(8, left), window.innerWidth - pw - 8);
            top = Math.min(Math.max(8, top), window.innerHeight - ph - 8);
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
        }
        function toggle(force) {
            const open = typeof force === 'boolean' ? force : !panel.classList.contains('open');
            panel.classList.toggle('open', open);
            btn.setAttribute('aria-expanded', String(open));
            if (open) {
                placePanel();
                scrollDown();
                setTimeout(() => input.focus(), 50);
            }
        }
        panel.querySelector('.pxbot-close').addEventListener('click', () => toggle(false));
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) toggle(false); });

        // --- Messaggi ---
        function scrollDown() { msgsEl.scrollTop = msgsEl.scrollHeight; }
        function addMsg(kind, text) {
            const div = document.createElement('div');
            div.className = 'pxbot-msg ' + kind;
            if (kind === 'bot') div.innerHTML = renderMarkdown(text);
            else div.textContent = text;
            msgsEl.appendChild(div);
            scrollDown();
            return div;
        }
        function renderAll() {
            msgsEl.innerHTML = '';
            addMsg('bot', GREETING);
            for (const m of storia) addMsg(m.ruolo === 'utente' ? 'user' : 'bot', m.testo);
        }
        renderAll();

        panel.querySelector('.pxbot-new').addEventListener('click', () => {
            if (busy) return;
            storia = [];
            store.del(HISTORY_KEY, sessionStorage);
            renderAll();
            input.focus();
        });

        function autoGrow() {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        }
        input.addEventListener('input', autoGrow);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const messaggio = input.value.trim();
            if (!messaggio || busy) return;
            busy = true;
            sendBtn.disabled = true;
            input.value = '';
            autoGrow();
            addMsg('user', messaggio);
            const typing = document.createElement('div');
            typing.className = 'pxbot-typing';
            typing.textContent = 'Projexa sta scrivendo…';
            msgsEl.appendChild(typing);
            scrollDown();
            try {
                const res = await fetch(`${API_URL}/chatbot`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('authToken') || ''}` },
                    body: JSON.stringify({ messaggio, storia })
                });
                const data = await res.json().catch(() => ({}));
                typing.remove();
                if (res.status === 401) {
                    addMsg('error', 'La sessione è scaduta: accedi di nuovo per continuare.');
                } else if (!res.ok) {
                    addMsg('error', data.error || 'Non riesco a rispondere in questo momento. Riprova tra poco.');
                } else {
                    addMsg('bot', data.risposta);
                    storia.push({ ruolo: 'utente', testo: messaggio }, { ruolo: 'projexa', testo: data.risposta });
                    storia = storia.slice(-20);
                    store.set(HISTORY_KEY, storia, sessionStorage);
                }
            } catch {
                typing.remove();
                addMsg('error', 'Connessione non riuscita. Controlla la rete e riprova.');
            } finally {
                busy = false;
                sendBtn.disabled = false;
                input.focus();
            }
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
