// ============================================================================
// TASK DAL RECAP (pulsante "Crea task" nella finestra del recap)
// ----------------------------------------------------------------------------
// Legge la sezione "AZIONI IN CARICO" del recap salvato e propone un task per ogni riga
// "- ..." dei blocchi che appartengono all'utente: quelli intestati al suo nome (tabella
// users) o a una delle etichette di RECAP_TASK_OWNER_LABELS. Nessuna AI: solo lettura del
// testo, così il risultato è immediato e prevedibile. L'utente rivede tutto in una
// finestra (routes/calendar.js + dashboard) prima dell'inserimento in tasks.
// ============================================================================

// Intestazioni di blocco considerate "mie", oltre a nome e cognome dell'utente.
// Per aggiungerne una basta una nuova voce qui (minuscole, il confronto ignora maiuscole,
// parentesi quadre e due punti finali).
export const RECAP_TASK_OWNER_LABELS = [
  'il nostro team',
  'nostro team',
  'teamsystem'
];

const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio',
  'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/[\[\]"“”*_]/g, '')
  .replace(/[’`]/g, "'")
  .replace(/\s*:\s*$/, '')
  .replace(/\s+/g, ' ')
  .trim();

// Nomi con cui l'utente può comparire come intestazione: "yanko dacco'", "yanko dacco", "yanko".
export function ownerVariants(fullName) {
  const full = norm(fullName);
  const out = new Set(RECAP_TASK_OWNER_LABELS.map(norm));
  if (full) {
    out.add(full);
    out.add(full.replace(/'+$/, ''));
    const first = full.split(' ')[0];
    if (first && first.length >= 3) out.add(first);
  }
  return [...out].filter(Boolean);
}

// L'intestazione (es. "Yanko Dacco'", "Giancarla / Elena", "[Nostro team]") è dell'utente
// se contiene uno dei suoi nomi/etichette come parole intere.
function isOwnerHeader(text, variants) {
  const h = norm(text);
  return variants.some((v) => {
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}])${esc}($|[^\\p{L}])`, 'u').test(h);
  });
}

// Riga elenco: "- testo", "• testo", "* testo" (anche rientrata).
const BULLET = /^(\s*)[-•*–]\s+(.+?)\s*$/;
// Fine dell'email dopo le azioni.
const CLOSING = /^(resto a disposizione|un saluto|cordiali saluti|saluti|grazie|a presto)\b/i;
// Intestazione "breve" scritta come voce d'elenco ("- Yanko Dacco'"): poche parole, niente
// punto finale, niente date/cifre.
const looksLikeHeader = (t) => t.split(/\s+/).length <= 6 && !/[.;]\s*$/.test(t) && !/\d/.test(t);

// Righe d'azione dell'utente: [{ description }] nell'ordine del recap.
export function parseRecapActions(recap, variants) {
  const lines = String(recap || '').replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^\s*(?:\d+[.)]\s*)?azioni\s+in\s+carico\b/i.test(norm(l)));
  if (start < 0) return [];
  const items = [];
  let mine = false;
  let prevBlank = true;
  let lastInBlock = null;
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    const text = raw.trim();
    if (!text || /^[—–\-_=]{3,}$/.test(text)) { prevBlank = true; continue; }
    if (CLOSING.test(text)) break;
    const b = BULLET.exec(raw);
    if (!b) {
      // Riga normale: intestazione di un nuovo blocco (di qualcuno).
      mine = isOwnerHeader(text, variants);
      lastInBlock = null;
      prevBlank = false;
      continue;
    }
    const indent = b[1].replace(/\t/g, '  ').length;
    const body = b[2];
    // Voce d'elenco usata come intestazione ("- Yanko Dacco'" dopo una riga vuota, o
    // comunque il nome dell'utente da solo).
    if ((prevBlank && indent === 0 && looksLikeHeader(body)) || (looksLikeHeader(body) && isOwnerHeader(body, variants) && norm(body).split(' ').length <= 3)) {
      mine = isOwnerHeader(body, variants);
      lastInBlock = null;
      prevBlank = false;
      continue;
    }
    prevBlank = false;
    if (!mine) continue;
    // Sottovoce rientrata: completa l'azione precedente.
    if (indent >= 2 && lastInBlock) {
      lastInBlock.description += ` – ${body}`;
      continue;
    }
    lastInBlock = { description: body };
    items.push(lastInBlock);
  }
  return items;
}

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const validDay = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

// Scadenza scritta nella riga -> 'YYYY-MM-DD' o null. Si prende l'ULTIMA data citata
// ("tra il 16 e il 21/10" -> 21/10). Senza anno: quello della call, o il successivo se la
// data risulterebbe già passata rispetto alla call. "fine anno"/"entro l'anno" -> 31/12,
// "fine <mese>" -> ultimo giorno del mese.
export function parseDueDate(text, callDate) {
  const s = String(text || '');
  const call = /^\d{4}-\d{2}-\d{2}$/.test(String(callDate || '')) ? String(callDate) : new Date().toISOString().slice(0, 10);
  const callYear = Number(call.slice(0, 4));
  const found = [];
  const numeric = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g;
  for (let m = numeric.exec(s); m; m = numeric.exec(s)) {
    let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : null;
    found.push({ at: m.index, d: Number(m[1]), mo: Number(m[2]), y });
  }
  const named = new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?`, 'gi');
  for (let m = named.exec(s); m; m = named.exec(s)) {
    found.push({ at: m.index, d: Number(m[1]), mo: MONTHS.indexOf(m[2].toLowerCase()) + 1, y: m[3] ? Number(m[3]) : null });
  }
  const endOfMonth = new RegExp(`fine\\s+(?:di\\s+)?(${MONTHS.join('|')})(?:\\s+(\\d{4}))?`, 'gi');
  for (let m = endOfMonth.exec(s); m; m = endOfMonth.exec(s)) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    found.push({ at: m.index, d: 0, mo, y: m[2] ? Number(m[2]) : null }); // d=0: ultimo giorno
  }
  const yearEnd = /(fine\s+(?:dell['’]\s*)?anno|entro\s+l['’]\s*anno|entro\s+fine\s+anno)/gi;
  for (let m = yearEnd.exec(s); m; m = yearEnd.exec(s)) found.push({ at: m.index, d: 31, mo: 12, y: null });
  if (!found.length) return null;

  const last = found.sort((a, b) => a.at - b.at)[found.length - 1];
  const resolve = (y) => {
    const day = last.d === 0 ? new Date(Date.UTC(y, last.mo, 0)).getUTCDate() : last.d;
    return validDay(y, last.mo, day) ? iso(y, last.mo, day) : null;
  };
  if (last.y) return resolve(last.y);
  const same = resolve(callYear);
  if (!same) return null;
  return same < call ? resolve(callYear + 1) : same;
}
