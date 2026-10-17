// === MySupport inviato dal PC (interruttore «DataBricks», 2026-10-17) ===
//
// Il file «MySupport.xlsx» lo crea sul PC uno script schedulato che legge Databricks; lo stesso
// script poi invia le righe a Projexa (POST /api/mysupport/push) con un token dedicato.
// Projexa non legge più la cartella del PC e non deve restare aperta.
//  - interruttore acceso -> si genera il token e lo si mostra UNA volta, da incollare nel campo
//    "projexa_token" di config.json dello script (backend/routes/mysupportPush.js);
//  - «Nuovo token» -> il precedente smette di funzionare;
//  - interruttore spento (con conferma) -> token revocato.
// Accanto all'interruttore: stato del token e ultimo invio ricevuto.
(function () {
    'use strict';

    const API = location.origin + '/api/mysupport/push/token';
    const auth = () => {
        const t = localStorage.getItem('authToken');
        return t ? { Authorization: `Bearer ${t}` } : {};
    };
    const avvisa = (msg, tipo = 'info') => { if (typeof showNotification === 'function') showNotification(msg, tipo); };
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const dataOra = (v) => v ? new Date(v).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

    async function chiama(metodo) {
        const r = await fetch(API, { method: metodo, headers: auth(), cache: 'no-store' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Errore ${r.status}`);
        return d;
    }

    // Finestra con il token appena generato (unica volta in cui si vede) e il pulsante Copia.
    function mostraToken(token) {
        let modal = document.getElementById('msPushTokenModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'msPushTokenModal';
            modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:1000; display:flex; align-items:center; justify-content:center;';
            document.body.appendChild(modal);
        }
        modal.innerHTML = `
            <div style="background:white; border-radius:10px; padding:1.5rem; width:560px; max-width:92vw; box-shadow:0 10px 40px rgba(0,0,0,0.25);">
                <h3 style="margin:0 0 0.75rem; color:#1F2937;">Token per l'invio di MySupport</h3>
                <p style="margin:0 0 0.6rem; color:#4B5563; line-height:1.45; font-size:0.9rem;">
                    Copialo nel campo <b>"projexa_token"</b> del file <b>config.json</b> dello script del report MySupport sul tuo PC.
                    <b>Non verrà più mostrato</b>: se lo perdi, genera un nuovo token.</p>
                <div style="display:flex; gap:0.5rem; align-items:center;">
                    <input id="msPushTokenVal" type="text" readonly value="${esc(token)}" style="flex:1; font-family:monospace; font-size:0.82rem; padding:0.5rem; border:1px solid #D1D5DB; border-radius:6px; background:#F9FAFB;">
                    <button id="msPushTokenCopia" type="button" style="padding:0.5rem 0.9rem; background:#3B82F6; color:white; border:none; border-radius:6px; font-weight:600; cursor:pointer;"><i class="fas fa-copy"></i> Copia</button>
                </div>
                <p style="margin:0.6rem 0 0; color:#6B7280; font-size:0.8rem;">Il token vale solo per inviare i dati MySupport al tuo tenant. Spegnendo l'interruttore «DataBricks» viene revocato.</p>
                <div style="display:flex; justify-content:flex-end; margin-top:1rem;">
                    <button id="msPushTokenChiudi" type="button" style="padding:0.5rem 1rem; background:white; color:#4B5563; border:1px solid #D1D5DB; border-radius:6px; cursor:pointer;">Chiudi</button>
                </div>
            </div>`;
        modal.style.display = 'flex';
        const campo = document.getElementById('msPushTokenVal');
        campo.addEventListener('focus', () => campo.select());
        document.getElementById('msPushTokenCopia').onclick = async () => {
            try { await navigator.clipboard.writeText(token); } catch (e) { campo.select(); document.execCommand('copy'); }
            avvisa('Token copiato', 'success');
        };
        document.getElementById('msPushTokenChiudi').onclick = () => { modal.style.display = 'none'; };
    }

    // Genera (o rigenera) il token. true = fatto.
    async function attiva() {
        try {
            const d = await chiama('POST');
            mostraToken(d.token);
            return true;
        } catch (e) {
            avvisa('Generazione del token non riuscita: ' + e.message);
            return false;
        }
    }

    async function disattiva() {
        try { await chiama('DELETE'); return true; } catch (e) { avvisa('Revoca del token non riuscita: ' + e.message); return false; }
    }

    // Contenuto accanto all'interruttore: stato del token, ultimo invio, «Nuovo token».
    async function riempi(el, settingId) {
        if (!el) return;
        let s;
        try { s = await chiama('GET'); } catch (e) { el.innerHTML = `<span class="calendar-conn-account" style="color:#B91C1C;">${esc(e.message)}</span>`; return; }
        // Interruttore acceso ma nessun token (es. acceso con il vecchio import dalla cartella).
        if (!s.attivo) {
            el.innerHTML = '<span class="calendar-conn-account" style="color:#B45309;"><i class="fas fa-key"></i> Nessun token: lo script del PC non può inviare i dati</span>'
                + `<button type="button" class="calendar-conn-btn calendar-conn-on" data-dbx-nuovo="${esc(settingId)}" data-dbx-primo="1"><i class="fas fa-key"></i> Genera token</button>`;
            return;
        }
        const r = s.ultimoReport;
        const invio = !s.ultimoUso ? 'nessun invio ricevuto finora'
            : `ultimo invio ${dataOra(s.ultimoUso)}${r ? `: ${r.inserted || 0} nuovi, ${r.updated || 0} aggiornati${r.ricevuti < r.blocchi ? ` (incompleto: ${r.ricevuti}/${r.blocchi} blocchi)` : ''}` : ''}`;
        const titolo = r ? `Righe ricevute ${r.totale || 0} · invariate ${r.unchanged || 0} · clienti non abbinati ${r.nonTrovati || 0}${r.ambigui ? ` · nomi su più clienti ${r.ambigui}` : ''}` : `Token generato il ${dataOra(s.creatoIl)}`;
        el.innerHTML = `<span class="calendar-conn-account" title="${esc(titolo)}"><i class="fas fa-key" style="color:#F59E0B;"></i> Token attivo · ${esc(invio)}</span>`
            + `<button type="button" class="calendar-conn-btn calendar-conn-on" data-dbx-nuovo="${esc(settingId)}" title="Il token attuale smette di funzionare"><i class="fas fa-rotate"></i> Nuovo token</button>`;
    }

    window.MySupportPush = { attiva, disattiva, riempi };
})();
