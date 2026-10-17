// Pagine di ritorno dei collegamenti OAuth (Jira, Google/Outlook Calendar): manda l'esito alla
// finestra che ha aperto il popup e si chiude. È un file statico perché la Content-Security-
// Policy non ammette script inline generati al volo (backend/routes/jira.js e calendar.js,
// callbackPage: i dati arrivano negli attributi data-msg e data-origin di #oauthEsito).
(function () {
    'use strict';
    var el = document.getElementById('oauthEsito');
    try {
        if (el && window.opener) {
            window.opener.postMessage(JSON.parse(el.getAttribute('data-msg') || '{}'), el.getAttribute('data-origin') || '');
        }
    } catch (e) { /* finestra aperta senza opener o origine non valida */ }
    setTimeout(function () { window.close(); }, 800);
})();
