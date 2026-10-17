// === Azioni dei pulsanti senza codice inline (2026-10-17) ===
//
// La Content-Security-Policy non ammette più script inline non autorizzati ('unsafe-inline'
// tolto da script-src, backend/config/cspHash.js): gli attributi onclick="..." e
// onsubmit="..." non vengono più eseguiti dal browser. Al loro posto:
//   data-click="nomeFunzione"   (anche data-submit sui <form>)
//   data-arg="valore"           -> nomeFunzione(valore, elemento, evento)
//   data-el                     -> nomeFunzione(elemento, evento)
//   (nessuno dei due)           -> nomeFunzione(evento, elemento)
//   data-stop                   -> event.stopPropagation() (anche senza data-click)
// Si chiamano solo funzioni globali già definite dalla pagina: dall'HTML non si esegue
// codice, al massimo si passa una stringa come argomento.
// Ascolto in fase di CATTURA sul documento: funziona anche dentro contenitori che fermano la
// propagazione (es. il contenuto delle finestre modali) e data-stop ferma l'evento prima che
// arrivi agli altri elementi, come faceva onclick="event.stopPropagation()".
(function () {
    'use strict';

    function esegui(e, el, nome) {
        if (el.hasAttribute('data-stop')) e.stopPropagation();
        if (!nome) return;
        const fn = window[nome];
        if (typeof fn !== 'function') { console.warn('[azioni] funzione non trovata:', nome); return; }
        if (el.hasAttribute('data-arg')) return fn.call(el, el.getAttribute('data-arg'), el, e);
        if (el.hasAttribute('data-el')) return fn.call(el, el, e);
        return fn.call(el, e, el);
    }

    document.addEventListener('click', (e) => {
        const el = e.target.closest && e.target.closest('[data-click], [data-stop]');
        if (!el || el.tagName === 'FORM') return;
        esegui(e, el, el.getAttribute('data-click'));
    }, true);

    document.addEventListener('submit', (e) => {
        const el = e.target.closest && e.target.closest('form[data-submit]');
        if (el) esegui(e, el, el.getAttribute('data-submit'));
    }, true);

    // Azioni comuni a più pagine.
    // Pulsante «Indietro» delle pagine aperte nella stessa scheda (o dentro la dashboard
    // durante una registrazione: area interna).
    window.tornaIndietro = function () {
        if (window.top !== window && window.top.paginaInternaIndietro) window.top.paginaInternaIndietro();
        else if (history.length > 1) history.back();
        else location.href = 'dashboard.html';
    };
    // Nasconde l'elemento con l'id indicato (es. chiusura di una finestra).
    window.nascondi = function (id) {
        const el = document.getElementById(String(id));
        if (el) el.style.display = 'none';
    };
    // Apre un'altra pagina di Projexa (solo pagine .html dello stesso sito).
    window.vaiA = function (pagina) {
        if (/^[a-z0-9-]+\.html$/i.test(String(pagina))) location.href = pagina;
    };
})();
