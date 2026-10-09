// Scelta dell'AI e dell'esecuzione prima di una funzione AI (2026-10-09).
// Impostazioni › AI: «AI <funzione>» e «Esecuzione <funzione>». Con "Chiedi sempre" si apre una
// finestra che chiede l'AI (tra quelle collegate) e/o Immediato / Batch (50% off).
// Usato da dashboard.html, pm.html, pm-documento.html, dossier-cliente.html.
//   const sc = await ProjexaAi.scegli('kickoff', { apiUrl, headers });
//     -> null se l'utente annulla; altrimenti { _ai?, _esecuzione? } da aggiungere alla richiesta.
//   Risposta 202 { batch: true, messaggio } = richiesta inviata in Batch: il risultato arriva in
//   «Risultati AI» (dashboard) con la notifica in campanella.
(function () {
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function stile() {
        if (document.getElementById('pxAiSceltaCss')) return;
        const st = document.createElement('style');
        st.id = 'pxAiSceltaCss';
        st.textContent = `
            .px-ai-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); display: flex; align-items: center; justify-content: center; z-index: 100000; }
            .px-ai-card { background: #fff; border-radius: 14px; width: min(460px, 94vw); box-shadow: 0 20px 50px rgba(0,0,0,0.25); font-family: inherit; color: #1E293B; }
            .px-ai-head { padding: 1rem 1.25rem; border-bottom: 1px solid #E2E8F0; font-weight: 700; font-size: 1.02rem; }
            .px-ai-body { padding: 1.1rem 1.25rem; display: flex; flex-direction: column; gap: 0.9rem; }
            .px-ai-body label.tit { font-size: 0.9rem; font-weight: 600; }
            .px-ai-body select { padding: 0.55rem 0.7rem; border: 1px solid #CBD5E1; border-radius: 8px; font-size: 0.9rem; width: 100%; }
            .px-ai-opz { display: flex; gap: 0.5rem; align-items: flex-start; font-size: 0.87rem; cursor: pointer; margin-top: 0.35rem; }
            .px-ai-nota { font-size: 0.8rem; color: #64748B; margin: 0; }
            .px-ai-foot { padding: 0.9rem 1.25rem; border-top: 1px solid #E2E8F0; display: flex; justify-content: flex-end; gap: 0.6rem; }
            .px-ai-foot button { padding: 0.55rem 1.1rem; border-radius: 8px; cursor: pointer; font-size: 0.9rem; }
            .px-ai-annulla { border: 1px solid #CBD5E1; background: #fff; color: #1E293B; }
            .px-ai-ok { border: none; background: #0EA5E9; color: #fff; font-weight: 600; }`;
        document.head.appendChild(st);
    }

    async function opzioni(operazione, { apiUrl, headers }) {
        const h = typeof headers === 'function' ? headers() : (headers || {});
        const r = await fetch(`${apiUrl}/ai-lavori/opzioni?operazione=${encodeURIComponent(operazione)}`, { headers: h });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Errore ${r.status}`);
        return d;
    }

    async function scegli(operazione, conf) {
        let o;
        try { o = await opzioni(operazione, conf); } catch (e) {
            // Senza le opzioni si prosegue con le impostazioni: il server dirà cosa manca.
            console.warn('Opzioni AI non disponibili:', e.message);
            return {};
        }
        if (!o.chiediAi && !o.chiediEsecuzione) return {};
        if (o.chiediAi && !(o.aiDisponibili || []).length) throw new Error('Nessuna AI disponibile: collega una chiave in Impostazioni › AI');
        // Solo l'esecuzione da chiedere, ma l'AI impostata non ha il Batch (Recap Projexa): Immediato.
        if (!o.chiediAi && !o.batchPossibile) return { _esecuzione: 'immediato' };
        stile();
        return new Promise((resolve) => {
            const mask = document.createElement('div');
            mask.className = 'px-ai-mask';
            const lista = o.aiDisponibili || [];
            mask.innerHTML = `<div class="px-ai-card" role="dialog" aria-modal="true">
                <div class="px-ai-head"><i class="fas fa-wand-magic-sparkles" style="color:#0EA5E9"></i> ${esc(o.etichetta)}</div>
                <div class="px-ai-body">
                    ${o.chiediAi ? `<div><label class="tit" for="pxAiSel">AI da usare</label>
                        <select id="pxAiSel">${lista.map((a) => `<option value="${esc(a.nome)}">${esc(a.label)}</option>`).join('')}</select></div>` : ''}
                    ${o.chiediEsecuzione ? `<div id="pxAiEs"><span class="tit" style="font-size:0.9rem;font-weight:600">Esecuzione</span>
                        <label class="px-ai-opz"><input type="radio" name="pxAiEs" value="immediato" checked> <span><b>Immediato</b> – risultato subito, prezzo normale.</span></label>
                        <label class="px-ai-opz"><input type="radio" name="pxAiEs" value="batch"> <span><b>Batch (50% off)</b> – costa la metà, arriva entro 24 ore (di solito pochi minuti) anche a pagina chiusa: ricevi la notifica e lo trovi in «Risultati AI».</span></label></div>
                        <p class="px-ai-nota" id="pxAiNoBatch" style="display:none">Recap Projexa è gratuito: parte subito, senza modalità Batch.</p>` : ''}
                </div>
                <div class="px-ai-foot"><button type="button" class="px-ai-annulla">Annulla</button><button type="button" class="px-ai-ok">Continua</button></div>
            </div>`;
            document.body.appendChild(mask);
            const sel = mask.querySelector('#pxAiSel');
            const es = mask.querySelector('#pxAiEs');
            const noBatch = mask.querySelector('#pxAiNoBatch');
            const aggiorna = () => {
                if (!es) return;
                const a = sel ? lista.find((x) => x.nome === sel.value) : null;
                const conBatch = sel ? !!(a && a.batch) : o.batchPossibile;
                es.style.display = conBatch ? '' : 'none';
                if (noBatch) noBatch.style.display = conBatch ? 'none' : '';
            };
            if (sel) sel.addEventListener('change', aggiorna);
            aggiorna();
            const chiudi = (v) => { mask.remove(); document.removeEventListener('keydown', tasto); resolve(v); };
            const tasto = (e) => { if (e.key === 'Escape') chiudi(null); };
            document.addEventListener('keydown', tasto);
            mask.addEventListener('click', (e) => { if (e.target === mask) chiudi(null); });
            mask.querySelector('.px-ai-annulla').addEventListener('click', () => chiudi(null));
            mask.querySelector('.px-ai-ok').addEventListener('click', () => {
                const out = {};
                if (sel) out._ai = sel.value;
                if (es) {
                    const r = mask.querySelector('input[name="pxAiEs"]:checked');
                    out._esecuzione = es.style.display === 'none' ? 'immediato' : ((r && r.value) || 'immediato');
                }
                chiudi(out);
            });
        });
    }

    // Aggiunge le scelte a una query string (richieste con file o GET).
    function inQuery(params, sc, titolo) {
        const p = params instanceof URLSearchParams ? params : new URLSearchParams(params || {});
        if (sc && sc._ai) p.set('_ai', sc._ai);
        if (sc && sc._esecuzione) p.set('_esecuzione', sc._esecuzione);
        if (titolo) p.set('_titolo', String(titolo).slice(0, 200));
        return p;
    }

    window.ProjexaAi = { scegli, inQuery };
})();
