// Scala dell'interfaccia (dashboard, reporting, database viewer).
// La preferenza Impostazioni › Preferenze › Dimensioni (tipo_valore=30, valore2='schermo',
// valore3 = percentuale) si applica come zoom sul <body>, moltiplicata per BASE: con la
// preferenza a 100 l'interfaccia è già ridotta del 25%.
//
// Effetti dello zoom sul body e relative compensazioni:
// - vw/vh vengono scalati anch'essi: nel CSS sono scritti come
//   calc(100vh * var(--ui-zoom-inv, 1)), dove --ui-zoom-inv = 1/zoom (impostata su <html>).
// - getBoundingClientRect/clientX sono in pixel dello schermo, mentre style.left/top/width
//   di un elemento nel body vengono moltiplicati per lo zoom: prima di assegnarli
//   dividere per uiZoom().
(function () {
    const BASE = 0.75;
    let zoom = 1;

    function apply(pct) {
        let p = Number(pct);
        if (!Number.isFinite(p) || p <= 0) p = 100;
        p = Math.max(35, Math.min(p, 150)); // limiti di sicurezza per non rendere la UI inutilizzabile
        zoom = (p / 100) * BASE;
        if (document.body) document.body.style.zoom = zoom;
        document.documentElement.style.setProperty('--ui-zoom-inv', String(1 / zoom));
        window.dispatchEvent(new Event('ui-zoom-change'));
        return zoom;
    }

    // Legge la percentuale dalla preferenza "Dimensioni" (stesso filtro tenant/utente del
    // flyout Impostazioni); l'endpoint storico screen-scale resta come fallback.
    async function readSetting() {
        const token = localStorage.getItem('authToken');
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const api = location.origin + '/api';
        let pct = NaN;
        try {
            const r = await fetch(`${api}/settings/details?argument=${encodeURIComponent('Preferenze')}`, { headers });
            if (r.ok) {
                const rows = await r.json();
                if (Array.isArray(rows)) {
                    const row = rows.find(x => {
                        const campo = String(x && x.campo || '').trim().toLowerCase();
                        const target = String(x && x.valore2 || '').trim().toLowerCase();
                        return Number(x && x.tipo_valore) === 30 && (campo === 'dimensioni' || target === 'schermo');
                    });
                    pct = Number(row && row.valore3);
                }
            }
        } catch (e) { /* ignore */ }
        if (!Number.isFinite(pct) || pct <= 0) {
            try {
                const r = await fetch(`${api}/settings/screen-scale`, { headers });
                if (r.ok) pct = Number((await r.json()).value);
            } catch (e) { /* ignore */ }
        }
        return Number.isFinite(pct) && pct > 0 ? pct : 100;
    }

    async function init() {
        return apply(await readSetting());
    }

    // Scala base subito al caricamento, prima che arrivi la preferenza (evita lo "scatto").
    if (document.body) apply(100);
    else document.addEventListener('DOMContentLoaded', () => { if (zoom === 1) apply(100); });

    window.uiZoom = () => zoom;
    window.ProjexaUiScale = { apply, readSetting, init, BASE };
})();
