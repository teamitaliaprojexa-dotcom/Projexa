// Banner consenso cookie (condiviso tra le pagine).
// Projexa usa cookie/archiviazione locale strettamente necessari per l'autenticazione;
// il banner informa l'utente e raccoglie la scelta per eventuali finalità non essenziali.
(function () {
  var KEY = 'cookieConsent'; // valori: 'all' | 'essential'
  if (localStorage.getItem(KEY)) return; // scelta già effettuata

  function setConsent(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
    var b = document.getElementById('cookieBanner');
    if (b) b.remove();
  }

  function render() {
    if (document.getElementById('cookieBanner')) return;
    var bar = document.createElement('div');
    bar.id = 'cookieBanner';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Informativa cookie');
    bar.style.cssText = [
      'position:fixed', 'left:16px', 'right:16px', 'bottom:16px', 'z-index:2147483000',
      'max-width:720px', 'margin:0 auto', 'background:#ffffff', 'color:#1F2937',
      'border:1px solid #E5E7EB', 'border-radius:12px', 'box-shadow:0 10px 40px rgba(0,0,0,0.18)',
      'padding:16px 18px', 'font-family:-apple-system,Segoe UI,Roboto,sans-serif', 'font-size:14px', 'line-height:1.5'
    ].join(';');

    bar.innerHTML =
      '<div style="font-weight:600;margin-bottom:6px;">Informativa cookie</div>' +
      '<div style="color:#6B7280;margin-bottom:12px;">' +
        'Usiamo cookie e archiviazione locale strettamente necessari per farti accedere e usare Projexa. ' +
        'Con il tuo consenso potremmo usare strumenti aggiuntivi. Consulta la ' +
        '<a href="privacy.html" style="color:#3B82F6;text-decoration:underline;">Informativa privacy e cookie</a>.' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">' +
        '<button id="ckEss" type="button" style="padding:8px 14px;border:1px solid #E5E7EB;background:#fff;color:#1F2937;border-radius:8px;cursor:pointer;font-weight:600;">Solo necessari</button>' +
        '<button id="ckAll" type="button" style="padding:8px 14px;border:none;background:#10B981;color:#fff;border-radius:8px;cursor:pointer;font-weight:600;">Accetta tutti</button>' +
      '</div>';

    document.body.appendChild(bar);
    document.getElementById('ckAll').addEventListener('click', function () { setConsent('all'); });
    document.getElementById('ckEss').addEventListener('click', function () { setConsent('essential'); });
  }

  if (document.body) render();
  else document.addEventListener('DOMContentLoaded', render);
})();
