// === Add-in di Outlook «Analizza con Projexa» in Impostazioni › Profilo (2026-10-22) ===
//
// Riquadro in testa al Profilo (per tutti gli utenti): stato del collegamento, «Scarica
// add-in» (manifest XML da installare in Outlook), «Collega Outlook» (codice monouso da
// scrivere nel pannello dell'add-in, valido 10 minuti), «Scollega» e l'icona ⓘ con le
// istruzioni d'installazione. Backend: backend/routes/outlookAddin.js.
(function () {
    'use strict';

    const API = location.origin + '/api/outlook';
    const auth = () => {
        const t = localStorage.getItem('authToken');
        return t ? { Authorization: `Bearer ${t}` } : {};
    };
    const avvisa = (msg, tipo = 'info') => { if (typeof showNotification === 'function') showNotification(msg, tipo); };
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const dataOra = (v) => v ? new Date(v).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

    async function chiama(metodo, percorso) {
        const r = await fetch(API + percorso, { method: metodo, headers: auth(), cache: 'no-store' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Errore ${r.status}`);
        return d;
    }

    const ISTRUZIONI = `
        <div style="font-weight:700; margin-bottom:6px;">Come installare l'add-in in Outlook</div>
        <ol style="margin:0 0 8px 18px; padding:0; line-height:1.45;">
            <li>Premi <b>Scarica add-in</b>: salvi il file <i>projexa-outlook-manifest.xml</i>.</li>
            <li>Apri la pagina dei componenti aggiuntivi di Outlook:
                <b>aka.ms/olksideload</b> nel browser (Outlook sul web e nuovo Outlook)
                oppure, nell'Outlook classico, <b>Home › Ottieni componenti aggiuntivi</b>.</li>
            <li>Vai su <b>Componenti aggiuntivi personali</b> › <b>Aggiungi un componente aggiuntivo personalizzato</b> › <b>Aggiungi da file…</b>, scegli il file scaricato e conferma con <b>Installa</b>.</li>
            <li>Apri un'email ricevuta: nella barra compare <b>Analizza con Projexa</b> (nell'Outlook sul web anche nel menu <b>…</b> › <b>App</b>).</li>
            <li>Al primo uso premi qui <b>Collega Outlook</b> e scrivi il codice nel pannello dell'add-in (vale 10 minuti, una volta sola).</li>
        </ol>
        <div style="color:#6B7280;">Serve «AI Add-in Outlook» acceso in Impostazioni › AI con l'AI da usare.
        L'add-in legge solo l'email che apri e solo quando premi il pulsante: non chiede permessi
        sulla casella né l'approvazione dell'IT. Se non trovi «Aggiungi un componente aggiuntivo
        personalizzato», la tua azienda ha disattivato gli add-in personali: chiedi all'IT di
        distribuire il file manifest a te.</div>`;

    function stile(el, css) { el.style.cssText = css; return el; }

    async function riempiStato(box) {
        const stato = box.querySelector('[data-ol-stato]');
        const pulsanti = box.querySelector('[data-ol-pulsanti]');
        stato.textContent = 'Caricamento…';
        pulsanti.innerHTML = '';
        let s;
        try { s = await chiama('GET', '/stato'); } catch (e) { stato.textContent = e.message; return; }
        const btn = (testo, icona, primario) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.innerHTML = `<i class="${icona}"></i> ${esc(testo)}`;
            stile(b, `padding:0.4rem 0.75rem; border-radius:6px; font-size:0.82rem; cursor:pointer; font-weight:600; ${primario
                ? 'background:#2563EB; color:#fff; border:1px solid #2563EB;' : 'background:#fff; color:#374151; border:1px solid #D1D5DB;'}`);
            pulsanti.appendChild(b);
            return b;
        };
        if (!s.attivo) {
            stato.innerHTML = 'Spento: accendi <b>AI Add-in Outlook</b> in Impostazioni › AI e scegli l\'AI da usare.';
        } else if (s.collegato) {
            stato.innerHTML = `Collegato a <b>${esc(s.mailbox)}</b>${s.ultimoUso ? ` · ultimo uso ${esc(dataOra(s.ultimoUso))}` : ''}${s.scadeIl ? ` · scade il ${esc(dataOra(s.scadeIl).slice(0, 10))}` : ''}${s.ai ? ` · AI: ${esc(s.ai)}` : ''}`;
        } else {
            stato.innerHTML = `Non collegato${s.ai ? ` · AI: ${esc(s.ai)}` : ''}`;
        }
        btn('Scarica add-in', 'fas fa-download', !s.collegato).addEventListener('click', scaricaManifest);
        if (s.attivo) {
            btn(s.collegato ? 'Ricollega' : 'Collega Outlook', 'fas fa-link', false).addEventListener('click', () => nuovoCodice(box));
        }
        if (s.collegato) {
            btn('Scollega', 'fas fa-unlink', false).addEventListener('click', async () => {
                if (!window.confirm('Scollegare Outlook da Projexa? L\'add-in smetterà di funzionare finché non lo ricolleghi.')) return;
                try { await chiama('DELETE', '/collegamento'); avvisa('Outlook scollegato', 'success'); } catch (e) { avvisa(e.message, 'error'); }
                riempiStato(box);
            });
        }
    }

    async function scaricaManifest() {
        try {
            const r = await fetch(API + '/manifest.xml', { headers: auth(), cache: 'no-store' });
            if (!r.ok) throw new Error(`Errore ${r.status}`);
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'projexa-outlook-manifest.xml';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            avvisa('Add-in scaricato: segui le istruzioni dell\'icona ⓘ per installarlo in Outlook', 'success');
        } catch (e) { avvisa('Download non riuscito: ' + e.message, 'error'); }
    }

    // Codice monouso in una finestra, con conto alla rovescia.
    async function nuovoCodice(box) {
        let d;
        try { d = await chiama('POST', '/codice'); } catch (e) { avvisa(e.message, 'error'); return; }
        let modal = document.getElementById('olCodiceModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'olCodiceModal';
            stile(modal, 'position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:1000; display:flex; align-items:center; justify-content:center;');
            document.body.appendChild(modal);
        }
        modal.innerHTML = `
            <div style="background:#fff; border-radius:10px; padding:1.5rem; width:460px; max-width:92vw; box-shadow:0 10px 40px rgba(0,0,0,0.25); text-align:center;">
                <h3 style="margin:0 0 0.5rem; color:#1F2937;">Collega Outlook</h3>
                <p style="margin:0 0 0.8rem; color:#4B5563; font-size:0.9rem; line-height:1.45;">In Outlook apri un'email, premi <b>Analizza con Projexa</b> e scrivi questo codice nel pannello.</p>
                <div id="olCodiceVal" style="font-family:Consolas,monospace; font-size:2rem; letter-spacing:0.2em; font-weight:700; color:#1E40AF; padding:0.5rem; background:#EFF6FF; border-radius:8px;">${esc(d.codice)}</div>
                <p id="olCodiceTempo" style="margin:0.6rem 0 0; color:#6B7280; font-size:0.82rem;"></p>
                <p style="margin:0.4rem 0 0; color:#6B7280; font-size:0.78rem;">Vale una volta sola. Non comunicarlo a nessuno: chi lo usa collega la sua casella al tuo Projexa.</p>
                <div style="display:flex; justify-content:center; margin-top:1rem;">
                    <button id="olCodiceChiudi" type="button" style="padding:0.5rem 1rem; background:#fff; color:#4B5563; border:1px solid #D1D5DB; border-radius:6px; cursor:pointer;">Chiudi</button>
                </div>
            </div>`;
        modal.style.display = 'flex';
        const fine = Date.now() + (Number(d.scadeTraSecondi) || 600) * 1000;
        const tempo = document.getElementById('olCodiceTempo');
        const t = setInterval(() => {
            const s = Math.max(0, Math.round((fine - Date.now()) / 1000));
            tempo.textContent = s ? `Scade tra ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Codice scaduto: generane uno nuovo.';
            if (!s) clearInterval(t);
        }, 1000);
        const chiudi = () => { clearInterval(t); modal.style.display = 'none'; modal.innerHTML = ''; riempiStato(box); };
        document.getElementById('olCodiceChiudi').onclick = chiudi;
        modal.onclick = (e) => { if (e.target === modal) chiudi(); };
    }

    // Riquadro in Impostazioni › Profilo (chiamato da dashboard.html come il logo organizzazione).
    function inserisci(listEl) {
        if (!listEl || listEl.querySelector('.outlook-addin-action')) return;
        const box = document.createElement('div');
        box.className = 'outlook-addin-action';
        stile(box, 'display:flex; flex-wrap:wrap; gap:0.6rem; align-items:center; justify-content:space-between; padding:0.75rem 0.9rem; margin-bottom:0.75rem; border:1px solid #E5E7EB; border-radius:10px; background:#F9FAFB; position:relative;');
        box.innerHTML = `
            <div style="display:flex; gap:0.7rem; align-items:center; min-width:0;">
                <i class="fas fa-envelope-open-text" style="font-size:1.4rem; color:#2563EB;"></i>
                <div style="min-width:0;">
                    <div style="font-weight:600; color:var(--dark, #1F2937); display:flex; align-items:center; gap:0.4rem;">Add-in Outlook
                        <button type="button" data-ol-info aria-label="Come installare l'add-in" title="Come installare l'add-in"
                            style="border:none; background:none; color:#2563EB; cursor:pointer; padding:0; font-size:0.95rem;"><i class="fas fa-circle-info"></i></button>
                    </div>
                    <div data-ol-stato style="font-size:0.8rem; color:var(--text-muted, #6B7280);"></div>
                </div>
            </div>
            <div data-ol-pulsanti style="display:flex; gap:0.4rem; flex-wrap:wrap;"></div>
            <div data-ol-tooltip role="tooltip" hidden
                style="position:absolute; z-index:50; top:2.6rem; left:0.9rem; width:min(460px, 92vw); background:#fff; color:#1F2937; border:1px solid #D1D5DB; border-radius:8px; padding:0.8rem 0.9rem; font-size:0.82rem; box-shadow:0 10px 25px rgba(0,0,0,0.15);">${ISTRUZIONI}</div>`;
        const info = box.querySelector('[data-ol-info]');
        const tip = box.querySelector('[data-ol-tooltip]');
        let fisso = false;
        info.addEventListener('mouseenter', () => { tip.hidden = false; });
        info.addEventListener('mouseleave', () => { if (!fisso) tip.hidden = true; });
        info.addEventListener('click', (e) => { e.stopPropagation(); fisso = !fisso; tip.hidden = !fisso; });
        document.addEventListener('click', (e) => { if (fisso && !tip.contains(e.target)) { fisso = false; tip.hidden = true; } });
        listEl.prepend(box);
        riempiStato(box);
    }

    window.OutlookAddin = { inserisci };
})();
