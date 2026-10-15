// === Import MySupport dalla cartella del PC (interruttore «DataBricks», 2026-10-15) ===
//
// Il file «MySupport.xlsx» lo crea sul PC uno script schedulato che legge Databricks. Il server
// di Projexa non vede il PC, quindi:
//  - acceso l'interruttore «DataBricks» in Impostazioni, si sceglie la CARTELLA (Chrome/Edge,
//    File System Access API): il browser ne conserva l'accesso (IndexedDB), il nome della
//    cartella va in settings.valore2 e il server crea la schedulazione dell'utente
//    (job_schedules «import_mysupport_cartella», lun-ven 10:15 e 16:00, modificabile dalla
//    pagina Schedulazioni) — backend/routes/mysupportCartella.js;
//  - con Projexa aperta, ogni minuto si chiede al server se è ora: in quel caso si legge il file
//    e lo si importa come Qlik › MySupport (QlikVoucher.importaMySupportFile, js/Qlik_voucher.js).
//    File non cambiato dall'ultimo import: il server fa riprovare fra 5 minuti (fino a 6 volte).
// Dopo un riavvio del browser l'accesso alla cartella può richiedere un clic di conferma: compare
// un avviso con il pulsante (il browser non lo concede senza un clic dell'utente).
(function () {
    'use strict';

    const API = location.origin + '/api/mysupport/cartella';
    const DB_NOME = 'projexa-cartelle';
    const STORE = 'handle';
    const auth = () => {
        const t = localStorage.getItem('authToken');
        return t ? { Authorization: `Bearer ${t}` } : {};
    };
    const utente = () => {
        try { return (window.decodeJwtPayload && window.decodeJwtPayload(localStorage.getItem('authToken')) || {}).user_id || 'utente'; }
        catch (e) { return 'utente'; }
    };
    const chiave = () => `mysupport:${utente()}`;
    const avvisa = (msg, tipo = 'info') => { if (typeof showNotification === 'function') showNotification(msg, tipo); };
    const supportato = () => typeof window.showDirectoryPicker === 'function';

    // --- IndexedDB: l'accesso alla cartella (FileSystemDirectoryHandle) ---
    function apriDb() {
        return new Promise((ok, ko) => {
            const r = indexedDB.open(DB_NOME, 1);
            r.onupgradeneeded = () => r.result.createObjectStore(STORE);
            r.onsuccess = () => ok(r.result);
            r.onerror = () => ko(r.error);
        });
    }
    async function idb(modo, fn) {
        const db = await apriDb();
        return new Promise((ok, ko) => {
            const tx = db.transaction(STORE, modo);
            const req = fn(tx.objectStore(STORE));
            tx.oncomplete = () => { db.close(); ok(req && req.result); };
            tx.onerror = () => { db.close(); ko(tx.error); };
        });
    }
    const leggiHandle = () => idb('readonly', (s) => s.get(chiave())).catch(() => null);
    const salvaHandle = (h) => idb('readwrite', (s) => s.put(h, chiave()));

    async function post(percorso, body) {
        const r = await fetch(`${API}/${percorso}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth() }, body: JSON.stringify(body || {}) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `Errore ${r.status}`);
        return d;
    }

    // Interruttore acceso: scelta della cartella e attivazione. Restituisce il nome della cartella ('' = non attivato).
    async function attiva(settingId) {
        if (!supportato()) { avvisa('Per leggere la cartella serve Chrome o Edge (versione recente)'); return ''; }
        let h;
        try {
            h = await window.showDirectoryPicker({ id: 'projexa-mysupport', mode: 'read' });
        } catch (e) {
            if (e && e.name !== 'AbortError') avvisa('Cartella non accessibile: ' + e.message);
            return '';
        }
        try {
            await salvaHandle(h);
            let presente = true;
            try { await h.getFileHandle('MySupport.xlsx'); } catch (e) { presente = false; }
            await post('attiva', { settingId, cartella: h.name });
            avvisa(presente
                ? `Cartella «${h.name}» collegata: MySupport.xlsx verrà importato alle 10:15 e alle 16:00 (con Projexa aperta)`
                : `Cartella «${h.name}» collegata, ma ora non contiene MySupport.xlsx: verrà importato quando ci sarà`, 'success');
            nascondiPermesso();
            return h.name;
        } catch (e) {
            avvisa('Attivazione non riuscita: ' + e.message);
            return '';
        }
    }

    async function disattiva(settingId) {
        try { await post('disattiva', { settingId }); return true; } catch (e) { avvisa('Disattivazione non riuscita: ' + e.message); return false; }
    }

    // --- Avviso «riconferma l'accesso alla cartella» ---
    function mostraPermesso(h) {
        let el = document.getElementById('msCartellaPermesso');
        if (!el) {
            el = document.createElement('div');
            el.id = 'msCartellaPermesso';
            el.style.cssText = 'position:fixed; left:16px; bottom:110px; z-index:900; max-width:360px; background:#FFFBEB; color:#92400E; border:1px solid #FDE68A; border-radius:10px; padding:10px 12px; font-size:13px; box-shadow:0 8px 24px rgba(0,0,0,0.15);';
            document.body.appendChild(el);
        }
        el.innerHTML = '<b>Import MySupport</b><br>Il browser chiede di riconfermare l\'accesso alla cartella del file MySupport.xlsx.'
            + '<div style="margin-top:8px; display:flex; gap:6px;"><button type="button" data-ms-ok style="border:none; background:#D97706; color:#fff; border-radius:6px; padding:5px 10px; font-weight:600; cursor:pointer;">Consenti accesso</button>'
            + '<button type="button" data-ms-no style="border:none; background:transparent; color:#92400E; cursor:pointer;">Più tardi</button></div>';
        el.querySelector('[data-ms-no]').onclick = nascondiPermesso;
        el.querySelector('[data-ms-ok]').onclick = async () => {
            try {
                if (await h.requestPermission({ mode: 'read' }) === 'granted') { nascondiPermesso(); avvisa('Accesso alla cartella concesso: l\'import MySupport riparte entro 5 minuti', 'success'); }
            } catch (e) { avvisa('Accesso non concesso: ' + e.message); }
        };
    }
    function nascondiPermesso() { const el = document.getElementById('msCartellaPermesso'); if (el) el.remove(); }

    // --- Esecuzione ---
    let inCorso = false;
    async function esegui(stato) {
        const avvio = Date.now();
        const esito = (e) => post('esito', { id: stato.id, durataMs: Date.now() - avvio, ...e }).catch(() => {});
        const h = await leggiHandle();
        if (!h) {
            await esito({ esito: 'fallito', errore: 'Cartella non scelta in questo browser: spegni e riaccendi «DataBricks» in Impostazioni' });
            return;
        }
        if (await h.queryPermission({ mode: 'read' }) !== 'granted') {
            mostraPermesso(h);
            await esito({ esito: 'permesso' });
            return;
        }
        let file;
        try {
            file = await (await h.getFileHandle(stato.file || 'MySupport.xlsx')).getFile();
        } catch (e) {
            await esito({ esito: 'fallito', errore: `File ${stato.file || 'MySupport.xlsx'} non trovato nella cartella «${h.name}»` });
            return;
        }
        if (stato.ultimoFileMs && file.lastModified <= Number(stato.ultimoFileMs)) {
            await esito({ esito: 'invariato', fileMs: file.lastModified });
            return;
        }
        if (!window.QlikVoucher || !window.QlikVoucher.importaMySupportFile) {
            await esito({ esito: 'fallito', errore: 'Modulo di import MySupport non disponibile nella pagina' });
            return;
        }
        try {
            const tot = await window.QlikVoucher.importaMySupportFile(file);
            await esito({
                esito: tot.ambigui ? 'errori' : 'ok', fileMs: file.lastModified,
                errore: tot.ambigui ? `${tot.ambigui} nomi My Support presenti su più clienti (righe non caricate)` : null,
                report: { file: file.name, modificato: new Date(file.lastModified).toISOString(), ...tot }
            });
            avvisa(`Import MySupport automatico: ${tot.inserted} nuovi, ${tot.updated} aggiornati`, (tot.inserted + tot.updated) ? 'success' : 'info');
        } catch (e) {
            await esito({ esito: 'fallito', errore: e.message, fileMs: null });
        }
    }

    // Ogni minuto: è ora? (con prenota=1 il server assegna l'esecuzione a una sola scheda)
    async function controlla() {
        if (inCorso) return;
        inCorso = true;
        try {
            const r = await fetch(`${API}/stato?prenota=1`, { headers: auth() });
            if (!r.ok) return;
            const stato = await r.json();
            if (stato.attiva && stato.eseguire) await esegui(stato);
        } catch (e) { /* rete assente: si riprova al giro successivo */ }
        finally { inCorso = false; }
    }

    setTimeout(() => { controlla(); setInterval(controlla, 60000); }, 20000);

    window.MySupportCartella = { attiva, disattiva, supportato, esegui: controlla };
})();
