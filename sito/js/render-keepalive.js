(function () {
    'use strict';

    // Render sospende i servizi Free dopo 15 minuti senza traffico in ingresso.
    // Otto minuti lasciano margine anche quando il browser rallenta i timer
    // delle schede in secondo piano.
    const HEARTBEAT_INTERVAL_MS = 8 * 60 * 1000;
    const API_ORIGIN = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
        ? location.origin
        : (location.hostname.endsWith('github.io') ? 'https://projexa-4mix.onrender.com' : location.origin);

    let timerId = null;
    let activeRequest = null;
    let lastHeartbeatAt = Date.now();

    function authToken() {
        return localStorage.getItem('authToken') || '';
    }

    function stop() {
        if (timerId !== null) {
            window.clearInterval(timerId);
            timerId = null;
        }
        if (activeRequest) {
            activeRequest.abort();
            activeRequest = null;
        }
    }

    async function heartbeat() {
        const token = authToken();
        if (!token) {
            stop();
            return;
        }

        if (activeRequest) return;
        const controller = new AbortController();
        activeRequest = controller;
        try {
            const response = await fetch(`${API_ORIGIN}/api/session/heartbeat`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}` },
                cache: 'no-store',
                signal: controller.signal
            });
            lastHeartbeatAt = Date.now();
            if (response.status === 401 || response.status === 403) stop();
        } catch (error) {
            // Una disconnessione momentanea non deve influire sull'interfaccia:
            // il timer riproverà al ciclo successivo.
        } finally {
            if (activeRequest === controller) activeRequest = null;
        }
    }

    function start() {
        if (timerId !== null || !authToken()) return;
        lastHeartbeatAt = Date.now();
        timerId = window.setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    }

    // Se l'utente torna su una scheda rimasta a lungo in background, invia subito
    // l'heartbeat senza aspettare il ciclo successivo.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
            heartbeat();
        }
    });

    // Logout eseguito in un'altra scheda.
    window.addEventListener('storage', event => {
        if (event.key === 'authToken' && !event.newValue) stop();
        if (event.key === 'authToken' && event.newValue) start();
    });

    // Chiusura scheda/browser o navigazione fuori dall'applicazione.
    window.addEventListener('pagehide', stop);

    window.ProjexaKeepAlive = { start, stop, heartbeat };
    start();
})();
