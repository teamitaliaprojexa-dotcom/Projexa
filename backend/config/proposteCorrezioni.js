// ============================================================================
// CORREZIONI PROPOSTE (2026-10-21)
// ----------------------------------------------------------------------------
// Pulsante «Proponi correzioni» nella finestra della trascrizione: Projexa cerca nel testo le
// parole che somigliano a un nome della riunione (partecipanti, team del progetto, rubrica,
// cliente, termini già corretti) senza essere uguali, e le propone come coppie
// errato → corretto. L'utente sceglie quali salvare in «Correzioni Termini AI»; poi valgono
// per tutte le trascrizioni (Whisper, Parakeet, Gemini) e ogni nome corretto diventa anche
// glossario / hotword delle riunioni successive.
//
// Somiglianza: stessa pronuncia all'italiana (ch/k/q, y/j/i, w/v, doppie, h muta, accenti)
// oppure al massimo 1 lettera diversa (2 da 8 lettere in su), con la stessa iniziale. Per non
// proporre parole comuni («sarà» → «Sara») la parola del testo deve comparire con la maiuscola
// in mezzo a una frase almeno una volta (Parakeet e Whisper scrivono i nomi propri in maiuscolo).
// Anche i nomi spezzati in due parole: «Team System» → «TeamSystem».
// ============================================================================

const PAROLA_RE = /[\p{L}][\p{L}\p{N}'’-]*/gu;
const MAX_PROPOSTE = 30;

// Forma «come si pronuncia», per confrontare varianti di scrittura.
export function fonetica(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’-]/g, '')
    .replace(/ph/g, 'f').replace(/ch/g, 'k').replace(/gh/g, 'g')
    .replace(/c(?=[aou]|$|[^eiaou])/g, 'k').replace(/q/g, 'k')
    .replace(/x/g, 'ks').replace(/[yj]/g, 'i').replace(/w/g, 'v')
    .replace(/h/g, '')
    .replace(/(.)\1+/g, '$1');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function simile(parola, termine) {
  const a = fonetica(parola);
  const b = fonetica(termine);
  if (!a || !b || a[0] !== b[0]) return false;
  if (a === b) return true;
  const max = Math.max(a.length, b.length) >= 8 ? 2 : 1;
  return Math.abs(a.length - b.length) <= max && levenshtein(a, b) <= max;
}

// Parole del testo con conteggio, esempio e se compaiono con la maiuscola a metà frase.
function paroleDelTesto(testo) {
  const out = new Map();
  for (const riga of String(testo || '').split('\n')) {
    // Via l'orario e «Nome:» all'inizio della riga (li scrive Projexa, non la trascrizione).
    const corpo = riga.replace(/^\s*\[[\d:]+\]\s*/, '').replace(/^[^:\n]{1,40}:\s+/, '');
    let prec = '';
    for (const m of corpo.matchAll(PAROLA_RE)) {
      const w = m[0];
      const inizioFrase = !prec || /[.!?…:]\s*$/.test(corpo.slice(0, m.index));
      const k = w.toLowerCase();
      const v = out.get(k) || { forme: new Map(), n: 0, maiuscola: false, esempio: '' };
      v.n++;
      v.forme.set(w, (v.forme.get(w) || 0) + 1);
      if (!inizioFrase && /^\p{Lu}/u.test(w)) v.maiuscola = true;
      if (!v.esempio) v.esempio = corpo.slice(Math.max(0, m.index - 40), m.index + w.length + 40).trim();
      out.set(k, v);
      prec = w;
    }
  }
  return out;
}

// Coppie di parole vicine («Team System»), per i nomi scritti attaccati.
function coppieDelTesto(testo) {
  const out = new Map();
  for (const riga of String(testo || '').split('\n')) {
    const parole = [...riga.matchAll(PAROLA_RE)].map((m) => m[0]);
    for (let i = 0; i + 1 < parole.length; i++) {
      const forma = `${parole[i]} ${parole[i + 1]}`;
      const k = forma.toLowerCase();
      const v = out.get(k) || { forma, n: 0 };
      v.n++;
      out.set(k, v);
    }
  }
  return out;
}

// termini: nomi della riunione (persone, cliente, glossario). regole: correzioni già attive
// ({ re, corretto }, loadCorrections): le varianti che già correggono non si ripropongono.
// Restituisce [{ corretto, varianti: [{ testo, n }], n, esempio }].
export function proponiCorrezioni(testo, termini, regole = []) {
  const parole = paroleDelTesto(testo);
  const coppie = coppieDelTesto(testo);
  const glossario = new Map(); // parola minuscola -> forma corretta
  for (const t of termini || []) {
    const pulito = String(t || '').replace(/\s+/g, ' ').trim();
    if (pulito.length < 3) continue;
    for (const w of pulito.split(' ')) if (w.length >= 4 && /^\p{L}/u.test(w)) glossario.set(w.toLowerCase(), w);
    if (!pulito.includes(' ') && pulito.length >= 6) glossario.set(pulito.toLowerCase(), pulito);
  }
  const giaCorrette = (forma) => regole.some(({ re }) => { re.lastIndex = 0; return re.test(forma); });
  const proposte = new Map();
  const aggiungi = (corretto, forma, n, esempio) => {
    if (giaCorrette(forma)) return;
    const p = proposte.get(corretto) || { corretto, varianti: [], n: 0, esempio };
    if (p.varianti.some((v) => v.testo.toLowerCase() === forma.toLowerCase())) return;
    p.varianti.push({ testo: forma, n });
    p.n += n;
    proposte.set(corretto, p);
  };

  for (const [k, v] of parole) {
    if (k.length < 4 || glossario.has(k) || !v.maiuscola) continue; // già giusta o parola comune
    for (const [gk, corretto] of glossario) {
      if (gk.includes(' ') || !simile(k, gk)) continue;
      // forma più frequente con la maiuscola
      const forma = [...v.forme.entries()].filter(([f]) => /^\p{Lu}/u.test(f)).sort((a, b) => b[1] - a[1])[0];
      aggiungi(corretto, forma ? forma[0] : k, v.n, v.esempio);
      break;
    }
  }
  for (const [k, v] of coppie) {
    const unita = fonetica(k.replace(' ', ''));
    for (const [gk, corretto] of glossario) {
      if (gk.length >= 6 && !gk.includes(' ') && fonetica(gk) === unita) { aggiungi(corretto, v.forma, v.n, ''); break; }
    }
  }
  return [...proposte.values()].sort((a, b) => b.n - a.n).slice(0, MAX_PROPOSTE);
}
