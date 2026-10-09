// Funzioni comuni delle pagine del Cruscotto PM (pm.html), del Portfolio (portfolio.html) e
// dei documenti (pm-documento.html). API: /api/pm (backend/routes/pm.js).
(function () {
    const API_URL = location.origin + '/api';
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const auth = () => {
        const t = localStorage.getItem('authToken');
        return t ? { Authorization: `Bearer ${t}` } : {};
    };
    if (!localStorage.getItem('authToken')) location.href = 'index.html';

    // ai = operazione AI (config/aiFunzioni.js del backend): prima si chiede AI/esecuzione se le
    // Impostazioni dicono "Chiedi sempre" (js/ai-scelta.js). Risposta 202 = inviata in Batch:
    // torna { batch: true, messaggio }. Annullando la scelta: errore con annullata = true.
    async function api(percorso, { metodo = 'GET', corpo, raw = false, ai = null, titolo = '' } = {}) {
        if (ai && window.ProjexaAi) {
            const sc = await window.ProjexaAi.scegli(ai, { apiUrl: API_URL, headers: auth });
            if (!sc) throw Object.assign(new Error('Operazione annullata'), { annullata: true });
            if (metodo === 'GET') percorso += (percorso.includes('?') ? '&' : '?') + window.ProjexaAi.inQuery({}, sc, titolo).toString();
            else corpo = { ...(corpo || {}), ...sc, ...(titolo ? { _titolo: titolo } : {}) };
        }
        const opz = { method: metodo, headers: { ...auth() } };
        if (corpo !== undefined) { opz.headers['Content-Type'] = 'application/json'; opz.body = JSON.stringify(corpo); }
        const r = await fetch(`${API_URL}/pm${percorso}`, opz);
        if (r.status === 401) { location.href = 'index.html'; throw new Error('Sessione scaduta'); }
        if (raw) return r;
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Errore ${r.status}`);
        if (r.status === 202 && d.batch) return { ...d, batch: true };
        return d;
    }

    // Risultato salvato di una richiesta in Batch («Risultati AI» della dashboard).
    async function risultatoAi(id) {
        const r = await fetch(`${API_URL}/ai-lavori/${encodeURIComponent(id)}`, { headers: { ...auth() } });
        if (r.status === 401) { location.href = 'index.html'; throw new Error('Sessione scaduta'); }
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Errore ${r.status}`);
        if (d.stato !== 'pronto') throw new Error(d.stato === 'in_corso' ? 'Il risultato non è ancora pronto' : (d.errore || 'Risultato non disponibile'));
        return d;
    }

    // Numeri all'italiana con il punto delle migliaia sempre.
    function fmt(n, dec = 1) {
        if (n == null || n === '' || !Number.isFinite(Number(n))) return '–';
        const v = Number(n);
        const [i, d] = Math.abs(v).toFixed(dec).split('.');
        return `${v < 0 ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${d && Number(d) ? `,${d}` : ''}`;
    }
    const euro = (n) => (n == null || n === '' ? '–' : `${fmt(n, 2)} €`);
    const dataIt = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
    const SEMAFORO = {
        verde: { label: 'Verde', ico: 'fa-circle-check' },
        giallo: { label: 'Giallo', ico: 'fa-circle-exclamation' },
        rosso: { label: 'Rosso', ico: 'fa-circle-xmark' },
        nd: { label: 'Dati insufficienti', ico: 'fa-circle-question' }
    };
    const badge = (s, testo) => `<span class="sem sem-${esc(s || 'nd')}"><i class="fas ${SEMAFORO[s || 'nd'].ico}"></i> ${esc(testo || SEMAFORO[s || 'nd'].label)}</span>`;

    function toast(msg, tipo = 'ok') {
        let t = document.getElementById('pmToast');
        if (!t) { t = document.createElement('div'); t.id = 'pmToast'; t.className = 'pm-toast'; document.body.appendChild(t); }
        t.textContent = msg;
        t.className = `pm-toast on ${tipo}`;
        clearTimeout(t._h);
        t._h = setTimeout(() => t.classList.remove('on'), 3800);
    }

    // Testo dell'AI -> HTML: titoli (righe in MAIUSCOLO), elenchi ("- " o "1.") e paragrafi.
    function testoAiHtml(testo) {
        let html = '', lista = null;
        const chiudi = () => { if (lista) { html += `</${lista}>`; lista = null; } };
        for (const r of String(testo || '').split(/\r?\n/)) {
            const t = r.trim();
            if (!t) { chiudi(); continue; }
            if (/^[A-ZÀ-Ù0-9 '’/&()-]{4,}:?$/.test(t)) { chiudi(); html += `<h4>${esc(t.replace(/:$/, ''))}</h4>`; continue; }
            let m = /^[-•*]\s+(.*)$/.exec(t);
            if (m) { if (lista !== 'ul') { chiudi(); html += '<ul>'; lista = 'ul'; } html += `<li>${esc(m[1])}</li>`; continue; }
            m = /^\d+[.)]\s+(.*)$/.exec(t);
            if (m) { if (lista !== 'ol') { chiudi(); html += '<ol>'; lista = 'ol'; } html += `<li>${esc(m[1])}</li>`; continue; }
            chiudi();
            html += `<p>${esc(t)}</p>`;
        }
        chiudi();
        return html;
    }

    // Finestra modale semplice: { titolo, corpo (html), pulsanti: [{ testo, classe, azione }] }.
    function modale({ titolo, corpo, pulsanti = [], larga = false }) {
        const m = document.createElement('div');
        m.className = 'pm-modal-mask';
        m.innerHTML = `<div class="pm-modal${larga ? ' larga' : ''}" role="dialog" aria-modal="true">
            <div class="pm-modal-head"><h3>${titolo}</h3><button type="button" class="pm-x" aria-label="Chiudi">&times;</button></div>
            <div class="pm-modal-body">${corpo}</div>
            <div class="pm-modal-foot"></div></div>`;
        const foot = m.querySelector('.pm-modal-foot');
        const chiudi = () => m.remove();
        for (const p of pulsanti) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `pm-btn ${p.classe || ''}`;
            b.innerHTML = p.testo;
            b.addEventListener('click', async () => {
                if (!p.azione) return chiudi();
                b.disabled = true;
                try { if ((await p.azione(m)) !== false) chiudi(); }
                catch (e) { toast(e.message, 'errore'); }
                finally { b.disabled = false; }
            });
            foot.appendChild(b);
        }
        m.querySelector('.pm-x').addEventListener('click', chiudi);
        m.addEventListener('keydown', (e) => { if (e.key === 'Escape') chiudi(); });
        document.body.appendChild(m);
        const primo = m.querySelector('input, select, textarea');
        if (primo) primo.focus();
        return m;
    }
    // Valori dei campi [name] di un contenitore.
    function valori(el) {
        const out = {};
        el.querySelectorAll('[name]').forEach((x) => { out[x.name] = x.type === 'checkbox' ? x.checked : x.value; });
        return out;
    }

    window.PM = { API_URL, esc, auth, api, risultatoAi, fmt, euro, dataIt, badge, SEMAFORO, toast, testoAiHtml, modale, valori };
})();
