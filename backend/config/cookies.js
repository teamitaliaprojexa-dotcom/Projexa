// Lettura e scrittura dei cookie senza dipendenze esterne (niente cookie-parser).
// Usato dal login OAuth (config/oauthLogin.js), dal cookie di sessione
// (config/session.js) e dallo "state" dei collegamenti Calendario/Jira.

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

// sameSite: 'Lax' quando il cookie deve arrivare anche al ritorno da un sito esterno
// (callback OAuth), 'Strict' per tutto il resto.
export function cookieOptions(req, path, maxAgeSec, sameSite = 'Lax') {
  return [`Path=${path}`, `Max-Age=${maxAgeSec}`, 'HttpOnly', `SameSite=${sameSite}`, req.secure ? 'Secure' : '']
    .filter(Boolean).join('; ');
}

// Aggiunge un Set-Cookie senza perdere quelli già impostati nella stessa risposta.
export function appendCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(prev ? [].concat(prev) : []), value]);
}

export function setCookie(req, res, name, value, { path = '/', maxAgeSec, sameSite = 'Lax' } = {}) {
  appendCookie(res, `${name}=${encodeURIComponent(value)}; ${cookieOptions(req, path, maxAgeSec, sameSite)}`);
}

export function clearCookie(req, res, name, { path = '/', sameSite = 'Lax' } = {}) {
  appendCookie(res, `${name}=; ${cookieOptions(req, path, 0, sameSite)}`);
}
