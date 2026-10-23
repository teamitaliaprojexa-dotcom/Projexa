// ============================================================================
// ANONYMIZATION LAYER (PII MASKING) PER LE AI ESTERNE (2026-10-22)
// ----------------------------------------------------------------------------
// Ogni testo che Projexa manda a un'AI ESTERNA (Claude, ChatGPT, Gemini, Mistral), in modalità
// Immediata o Batch, passa di qui: i dati personali vengono sostituiti da segnaposto
// ([PERSONA_1], [AZIENDA_2], [EMAIL_1], ...) e la risposta dell'AI torna con i segnaposto, che
// Projexa sostituisce con i valori veri prima di mostrarla o salvarla. L'AI lavora sul contenuto
// (cosa si è deciso, quali rischi, quali azioni) senza sapere a chi appartiene.
// Le AI locali della VM («Projexa», Ollama) e i servizi di trascrizione locali NON passano di
// qui: i dati non escono dal server.
//
// Tre livelli di riconoscimento, uniti (in caso di sovrapposizione vince il primo, tranne email e
// URL che restano interi anche se contengono un nome):
//   1. NOMI NOTI di Projexa per i tenant dell'utente: clienti, contatti, rubrica, team di
//      progetto, stakeholder, utenti. Precisi, sempre attivi (anche senza il servizio Python).
//   2. REGOLE (espressioni regolari): email, telefono, IBAN, carta di credito (Luhn), codice
//      fiscale, partita IVA, IP, URL. Sempre attive.
//   3. NER: Microsoft Presidio + spaCy it_core_news_lg (pii-service/app.py, PII_URL) per i nomi
//      di persona (e, se richiesti in PII_ENTITA_NER, organizzazioni e luoghi) non presenti in
//      Projexa, più i riconoscitori italiani di Presidio (documenti d'identità, patente...).
//
// La tabella segnaposto -> valore resta in memoria per la durata della richiesta (o della
// sessione dell'Assistente PM). Per le richieste Batch, che tornano ore dopo, si salva CIFRATA
// in ai_pii_mappe (Supporto/CreaDB/ai_pii_mappe.sql) e si cancella dopo 7 giorni.
//
// Variabili (.env):
//   PII_MASCHERAMENTO       attivo (predefinito) | 0 / off = nessuna anonimizzazione
//   PII_URL                 servizio Presidio (VM: http://127.0.0.1:8104); vuoto = solo livelli 1-2
//   PII_SE_NON_DISPONIBILE  regole (predefinito: si prosegue con i livelli 1-2) | blocca (la
//                           richiesta all'AI esterna non parte)
//   PII_ENTITA_NER          entità NER da mascherare (predefinito PERSON; es. PERSON,ORGANIZATION,LOCATION)
//   PII_SOGLIA              punteggio minimo Presidio (0.5)
//   PII_CONSENTITI          parole da non mascherare mai, separate da virgola (oltre a quelle sotto)
// ============================================================================
import db from './database.js';
import { encryptValue } from './crypto.js';

const disattivo = (v) => /^(0|off|no|false|spento|disattivo)$/i.test(String(v ?? '').trim());
export const piiAttivo = () => !disattivo(process.env.PII_MASCHERAMENTO);
const piiUrl = () => String(process.env.PII_URL || '').trim().replace(/\/+$/, '');
const bloccaSenzaServizio = () => /^blocca$/i.test(String(process.env.PII_SE_NON_DISPONIBILE || '').trim());
const entitaNer = () => String(process.env.PII_ENTITA_NER || 'PERSON').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const soglia = () => Number(process.env.PII_SOGLIA) || 0.5;

// Etichette dei segnaposto (in italiano: l'AI le capisce e le riusa così come sono).
const ETICHETTE = {
  PERSON: 'PERSONA', ORGANIZATION: 'AZIENDA', LOCATION: 'LUOGO',
  EMAIL_ADDRESS: 'EMAIL', PHONE_NUMBER: 'TELEFONO', IBAN_CODE: 'IBAN', CREDIT_CARD: 'CARTA',
  IP_ADDRESS: 'IP', URL: 'URL', IT_FISCAL_CODE: 'CODICE_FISCALE', IT_VAT_CODE: 'PARTITA_IVA',
  IT_IDENTITY_CARD: 'DOCUMENTO', IT_PASSPORT: 'DOCUMENTO', IT_DRIVER_LICENSE: 'DOCUMENTO'
};
// Riconoscitori a regole di Presidio, chiesti sempre (sono precisi e non dipendono dal NER).
const ENTITA_REGOLE_PRESIDIO = ['EMAIL_ADDRESS', 'PHONE_NUMBER', 'IBAN_CODE', 'CREDIT_CARD', 'IP_ADDRESS', 'URL',
  'IT_FISCAL_CODE', 'IT_VAT_CODE', 'IT_IDENTITY_CARD', 'IT_PASSPORT', 'IT_DRIVER_LICENSE'];
const NOMI_ETICHETTE = [...new Set(Object.values(ETICHETTE))].sort((a, b) => b.length - a.length).join('|');
// Segnaposto nella risposta dell'AI, anche ritoccati: [PERSONA_1], [Persona 1], \[PERSONA\_1\], PERSONA_1.
const RE_SEGNAPOSTO = new RegExp(`\\\\?\\[\\s*(${NOMI_ETICHETTE})\\\\?[ _-]?(\\d{1,5})\\s*\\\\?\\]|\\b(${NOMI_ETICHETTE})_(\\d{1,5})\\b`, 'giu');

// Nomi di prodotti e servizi che non identificano nessuno: mai mascherati.
const CONSENTITI_BASE = ['Projexa', 'TeamSystem', 'Team System', 'Jira', 'Qlik', 'MySupport', 'Gemini', 'Claude',
  'ChatGPT', 'OpenAI', 'Mistral', 'Ollama', 'Outlook', 'Teams', 'Microsoft', 'Google', 'Excel', 'Word', 'PowerPoint',
  'SharePoint', 'OneDrive', 'Kick-off', 'Kick off', 'Gantt', 'RAID', 'Recap', 'PM'];
const consentiti = () => [...CONSENTITI_BASE, ...String(process.env.PII_CONSENTITI || '').split(',').map((s) => s.trim()).filter(Boolean)];
const consentitiSet = () => new Set(consentiti().map((s) => s.toLowerCase()));

export const NOTA_SEGNAPOSTO = 'NOTA DI RISERVATEZZA: nel testo che segue alcuni dati personali (nomi di persone e aziende, '
  + 'email, telefoni, codici) sono stati sostituiti da segnaposto tra parentesi quadre, ad esempio [PERSONA_1], [AZIENDA_1], '
  + '[EMAIL_1]. Quando ti servono riportali ESATTAMENTE come sono scritti (stesse maiuscole, numero e parentesi), senza '
  + 'tradurli, modificarli o inventare i dati reali. Lo stesso segnaposto indica sempre la stessa persona o cosa.\n\n';

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BORDO_PRIMA = '(?<![\\p{L}\\p{N}_@.])';
const BORDO_DOPO = '(?![\\p{L}\\p{N}_@])';

// ----------------------------------------------------------------------------
// LIVELLO 2: REGOLE
// ----------------------------------------------------------------------------
function luhn(cifre) {
  let somma = 0;
  for (let i = 0; i < cifre.length; i++) {
    let d = Number(cifre[cifre.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    somma += d;
  }
  return somma % 10 === 0;
}
const REGOLE = [
  // Email e URL vincono anche sui nomi noti che contengono («mario.rossi@acme.it» resta un'email sola).
  { tipo: 'EMAIL_ADDRESS', priorita: 6, re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu },
  { tipo: 'URL', priorita: 6, re: /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/giu },
  { tipo: 'IBAN_CODE', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g },
  { tipo: 'IT_FISCAL_CODE', re: /\b[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-EHLMPR-T][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]\b/gi },
  // Partita IVA: 11 cifre solo se precedute da «P.IVA», «partita IVA», «VAT» (altrimenti
  // si confonderebbe con numeri di ticket, importi o telefoni). Si maschera il solo numero.
  { tipo: 'IT_VAT_CODE', re: /(?:p\.?\s?iva|partita\s+iva|vat(?:\s+number)?|c\.?\s?f\.?\s?\/\s?p\.?\s?iva)\s*(?:n\.?|nr\.?|num\.?|:)?\s*((?:IT\s?)?\d{11})\b/giu, gruppo: 1 },
  { tipo: 'IP_ADDRESS', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  {
    tipo: 'CREDIT_CARD', re: /\b(?:\d[ -]?){12,18}\d\b/g,
    valida: (v) => { const c = v.replace(/\D/g, ''); return c.length >= 13 && c.length <= 19 && luhn(c); }
  },
  {
    // Telefoni italiani (cellulari 3xx, fissi 0x) con prefisso internazionale facoltativo, e
    // numeri esteri con «+». 9-13 cifre in tutto, così date e importi non vengono presi.
    tipo: 'PHONE_NUMBER',
    re: /(?<![\p{L}\p{N}+])(?:(?:\+|00)\d{1,3}[\s.\-/]?)?(?:\(?(?:3\d{2}|0\d{1,3})\)?)[\s.\-/]?\d{2,4}[\s.\-/]?\d{2,4}(?:[\s.\-/]?\d{1,4})?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])\+\d{1,3}[\s.\-]?\d{2,4}[\s.\-]?\d{2,4}[\s.\-]?\d{2,5}(?![\p{L}\p{N}])/gu,
    // Date con orario o anno («02/10/2026 10», «2026-10-22») non sono telefoni.
    valida: (v) => {
      const n = v.replace(/\D/g, '').length;
      return n >= 9 && n <= 13 && !/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(v.trim()) && !/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(v.trim());
    }
  }
];

function trovaConRegole(testo) {
  const out = [];
  for (const r of REGOLE) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(testo))) {
      const valore = r.gruppo ? m[r.gruppo] : m[0];
      if (!valore) continue;
      if (r.valida && !r.valida(valore)) continue;
      const inizio = m.index + (r.gruppo ? m[0].lastIndexOf(valore) : 0);
      out.push({ tipo: r.tipo, inizio, fine: inizio + valore.length, priorita: r.priorita || 2 });
      if (m[0].length === 0) r.re.lastIndex++;
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// LIVELLO 1: NOMI NOTI DI PROJEXA (per utente, in cache 10 minuti)
// ----------------------------------------------------------------------------
// I campi sono cifrati sul database: il pool li restituisce in chiaro, quindi si leggono tutte
// le righe dei tenant dell'utente e si filtrano qui. La ricerca usa un indice per PRIMA PAROLA
// (non una regex con migliaia di alternative, lenta sulle trascrizioni lunghe): il testo si
// scorre una volta, parola per parola.
const CACHE_NOMI_MS = 10 * 60 * 1000;
const cacheNomi = new Map(); // user_id -> { at, indice: Map(prima parola -> [{ parole, tipo, maiuscola }]) }
const RE_PAROLA = /[\p{L}\p{N}]+/gu;
const RE_SEPARATORE = /^[\s'’\-.&]{1,3}$/u;
// Forma societaria in coda al nome del cliente: si cerca anche il nome senza («Acme» per «Acme S.r.l.»).
const RE_FORMA_SOCIETARIA = /[\s,]+(s\.?\s?p\.?\s?a\.?|s\.?\s?r\.?\s?l\.?(\s?s\.?)?|s\.?\s?n\.?\s?c\.?|s\.?\s?a\.?\s?s\.?|spa|srl|snc|sas|soc\.?\s?coop\.?|ltd\.?|gmbh|inc\.?)\s*$/iu;

async function righe(sql, params) {
  try { return (await db.query(sql, params)).rows; } catch (e) {
    console.warn(`[PII] Nomi noti: query non riuscita (${e.message})`);
    return [];
  }
}

const parole = (s) => String(s || '').match(RE_PAROLA) || [];

async function nomiNoti(userId) {
  const k = String(userId || '');
  const c = cacheNomi.get(k);
  if (c && Date.now() - c.at < CACHE_NOMI_MS) return c;
  const indice = new Map();
  const ok = consentitiSet();
  const visti = new Set();
  // maiuscola: il nome vale solo se nel testo inizia con la maiuscola (cognomi da soli).
  const aggiungi = (nome, tipo, maiuscola = false) => {
    const p = parole(nome);
    const testo = p.join(' ');
    if (!p.length || testo.length < 3 || ok.has(testo.toLowerCase())) return;
    const chiave = `${tipo}|${maiuscola ? 1 : 0}|${testo.toLowerCase()}`;
    if (visti.has(chiave)) return;
    visti.add(chiave);
    const prima = p[0].toLowerCase();
    if (!indice.has(prima)) indice.set(prima, []);
    indice.get(prima).push({ parole: p.map((x) => x.toLowerCase()), tipo, maiuscola });
  };
  const persona = (nome, cognome) => {
    const n = String(nome || '').trim();
    const cg = String(cognome || '').trim();
    if (n && cg) { aggiungi(`${n} ${cg}`, 'PERSON'); aggiungi(`${cg} ${n}`, 'PERSON'); }
    else if (parole(n).length > 1) { aggiungi(n, 'PERSON'); aggiungi(parole(n).reverse().join(' '), 'PERSON'); }
    // Cognome da solo (con la maiuscola, almeno 4 lettere): «ne parlo con Bianchi».
    const ultimo = cg || (parole(n).length > 1 ? parole(n).pop() : '');
    if (ultimo && ultimo.length >= 4) aggiungi(ultimo, 'PERSON', true);
  };
  const tenants = (await righe('SELECT DISTINCT tenant_id FROM user_tenants WHERE user_id = $1', [k])).map((r) => r.tenant_id);
  if (tenants.length) {
    const t = [tenants];
    for (const r of await righe(
      `SELECT valore2 FROM clients WHERE tenant_id = ANY($1::uuid[]) AND argument = 'Cliente' AND campo = 'Cliente' AND valore2 IS NOT NULL`, t)) {
      aggiungi(r.valore2, 'ORGANIZATION');
      const corto = String(r.valore2).replace(RE_FORMA_SOCIETARIA, '').trim();
      if (corto && corto !== String(r.valore2).trim()) aggiungi(corto, 'ORGANIZATION');
    }
    for (const r of await righe('SELECT nome, cognome FROM contacts WHERE tenant_id = ANY($1::uuid[])', t)) persona(r.nome, r.cognome);
    for (const r of await righe('SELECT nominativo FROM rubrica WHERE tenant_id = ANY($1::uuid[])', t)) persona(r.nominativo, '');
    for (const r of await righe('SELECT DISTINCT nominativo FROM proj_componenti WHERE tenant_id = ANY($1::uuid[])', t)) persona(r.nominativo, '');
    for (const r of await righe('SELECT nominativo FROM pm_stakeholder WHERE tenant_id = ANY($1::uuid[])', t)) persona(r.nominativo, '');
    for (const r of await righe(
      'SELECT u.name, u.cognome FROM users u JOIN user_tenants ut ON ut.user_id = u.id WHERE ut.tenant_id = ANY($1::uuid[])', t)) persona(r.name, r.cognome);
  }
  // Nomi più lunghi prima: «Mario Rossi Bianchi» vince su «Mario Rossi».
  for (const lista of indice.values()) lista.sort((a, b) => b.parole.length - a.parole.length);
  const voce = { at: Date.now(), indice, totale: visti.size };
  cacheNomi.set(k, voce);
  return voce;
}

function trovaNomiNoti(testo, noti) {
  const out = [];
  if (!noti || !noti.indice.size) return out;
  const tok = [];
  RE_PAROLA.lastIndex = 0;
  let m;
  while ((m = RE_PAROLA.exec(testo))) tok.push({ p: m[0], l: m[0].toLowerCase(), i: m.index, f: m.index + m[0].length });
  for (let i = 0; i < tok.length; i++) {
    const candidati = noti.indice.get(tok[i].l);
    if (!candidati) continue;
    for (const c of candidati) {
      const n = c.parole.length;
      if (i + n > tok.length) continue;
      if (c.maiuscola && !/^\p{Lu}/u.test(tok[i].p)) continue;
      let ok = true;
      for (let j = 1; j < n && ok; j++) {
        ok = tok[i + j].l === c.parole[j] && RE_SEPARATORE.test(testo.slice(tok[i + j - 1].f, tok[i + j].i));
      }
      if (!ok) continue;
      out.push({ tipo: c.tipo, inizio: tok[i].i, fine: tok[i + n - 1].f, priorita: c.maiuscola ? 3 : 4 });
      i += n - 1;
      break;
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// LIVELLO 3: PRESIDIO + spaCy (servizio pii-service)
// ----------------------------------------------------------------------------
const PEZZO_CHARS = 20000;       // testi per il servizio, divisi a capoverso / frase
const RICHIESTA_CHARS = 200000;  // caratteri per chiamata
let servizioGiuDa = 0;           // servizio non raggiungibile: si riprova dopo PAUSA_SERVIZIO_MS
const PAUSA_SERVIZIO_MS = 60000;
let ultimoAvviso = 0;

function dividi(testo) {
  const pezzi = [];
  let i = 0;
  while (i < testo.length) {
    let fine = Math.min(testo.length, i + PEZZO_CHARS);
    if (fine < testo.length) {
      const taglio = Math.max(testo.lastIndexOf('\n', fine), testo.lastIndexOf('. ', fine));
      if (taglio > i + PEZZO_CHARS / 2) fine = taglio + 1;
    }
    pezzi.push({ da: i, testo: testo.slice(i, fine) });
    i = fine;
  }
  return pezzi;
}

function errore(status, message) {
  return Object.assign(new Error(message), { status });
}

async function trovaConPresidio(testo) {
  const url = piiUrl();
  if (!url) return { trovati: [], motore: 'regole' };
  if (Date.now() < servizioGiuDa) return servizioNonDisponibile('in pausa dopo un errore recente');
  const pezzi = dividi(testo);
  const trovati = [];
  try {
    for (let i = 0; i < pezzi.length;) {
      const gruppo = [];
      let tot = 0;
      while (i < pezzi.length && (tot === 0 || tot + pezzi[i].testo.length <= RICHIESTA_CHARS)) { tot += pezzi[i].testo.length; gruppo.push(pezzi[i++]); }
      const res = await fetch(`${url}/analizza`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testi: gruppo.map((p) => p.testo), soglia: soglia(), consentiti: consentiti(),
          entita: [...new Set([...entitaNer(), ...ENTITA_REGOLE_PRESIDIO])]
        }),
        signal: AbortSignal.timeout(30000 + Math.ceil(tot / 1000) * 300)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      (data.risultati || []).forEach((lista, j) => {
        for (const r of lista || []) {
          if (!ETICHETTE[r.tipo]) continue;
          trovati.push({ tipo: r.tipo, inizio: gruppo[j].da + r.inizio, fine: gruppo[j].da + r.fine, priorita: ENTITA_REGOLE_PRESIDIO.includes(r.tipo) ? 2 : 1 });
        }
      });
    }
    return { trovati, motore: 'presidio' };
  } catch (e) {
    servizioGiuDa = Date.now() + PAUSA_SERVIZIO_MS;
    return servizioNonDisponibile(e.name === 'TimeoutError' ? 'tempo scaduto' : e.message);
  }
}

function servizioNonDisponibile(motivo) {
  if (bloccaSenzaServizio()) {
    throw errore(503, 'Anonimizzazione dei dati non disponibile in questo momento: per riservatezza la richiesta NON è stata inviata all\'AI esterna. Riprova tra poco o usa l\'AI «Projexa».');
  }
  if (Date.now() - ultimoAvviso > 10 * 60 * 1000) {
    ultimoAvviso = Date.now();
    console.warn(`[PII] Servizio Presidio non disponibile (${motivo}): anonimizzazione solo con nomi noti e regole`);
  }
  return { trovati: [], motore: 'regole' };
}

// Stato per Monitor / Impostazioni: { attivo, motore: 'presidio' | 'regole', disponibile }.
export async function statoAnonimizzazione() {
  if (!piiAttivo()) return { attivo: false, motore: null, disponibile: false };
  const url = piiUrl();
  if (!url) return { attivo: true, motore: 'regole', disponibile: true };
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    return { attivo: true, motore: 'presidio', disponibile: !!(r.ok && d.ready), modello: d.modello || '' };
  } catch {
    return { attivo: true, motore: 'presidio', disponibile: false };
  }
}

// ----------------------------------------------------------------------------
// ANONIMIZZATORE: una tabella di segnaposto per richiesta (o sessione)
// ----------------------------------------------------------------------------
export class Anonimizzatore {
  constructor(userId, noti = null) {
    this.userId = userId;
    this.noti = noti;
    this.perValore = new Map();   // "ETICHETTA|valore normalizzato" -> segnaposto
    this.perSegnaposto = new Map(); // "ETICHETTA_n" -> valore originale
    this.contatori = {};
    this.motore = 'regole';
  }

  get totale() { return this.perSegnaposto.size; }

  segnaposto(tipo, valore) {
    const etichetta = ETICHETTE[tipo] || 'DATO';
    const chiave = `${etichetta}|${norm(valore)}`;
    let s = this.perValore.get(chiave);
    if (!s) {
      this.contatori[etichetta] = (this.contatori[etichetta] || 0) + 1;
      s = `${etichetta}_${this.contatori[etichetta]}`;
      this.perValore.set(chiave, s);
      this.perSegnaposto.set(s, valore);
    }
    return `[${s}]`;
  }

  // Sostituisce gli intervalli trovati (senza sovrapposizioni: vince priorità, poi lunghezza).
  applica(testo, trovati) {
    const ok = consentitiSet();
    const occupato = new Uint8Array(testo.length);
    const scelti = [];
    trovati
      .filter((t) => t.fine > t.inizio && !ok.has(norm(testo.slice(t.inizio, t.fine))))
      .sort((a, b) => (b.priorita - a.priorita) || ((b.fine - b.inizio) - (a.fine - a.inizio)))
      .forEach((t) => {
        for (let i = t.inizio; i < t.fine; i++) if (occupato[i]) return;
        occupato.fill(1, t.inizio, t.fine);
        scelti.push(t);
      });
    scelti.sort((a, b) => a.inizio - b.inizio);
    let out = '';
    let pos = 0;
    for (const t of scelti) {
      out += testo.slice(pos, t.inizio) + this.segnaposto(t.tipo, testo.slice(t.inizio, t.fine));
      pos = t.fine;
    }
    return out + testo.slice(pos);
  }

  // Valori già sostituiti in questa sessione: si ritrovano anche dove il NER non li vedrebbe.
  trovaGiaNoti(testo) {
    const out = [];
    for (const [s, valore] of this.perSegnaposto) {
      if (String(valore).length < 3) continue;
      const re = new RegExp(`${BORDO_PRIMA}${escRe(String(valore)).replace(/\s+/g, '\\s+')}${BORDO_DOPO}`, 'giu');
      let m;
      while ((m = re.exec(testo))) out.push({ tipo: Object.keys(ETICHETTE).find((k) => s.startsWith(`${ETICHETTE[k]}_`)) || 'PERSON', inizio: m.index, fine: m.index + m[0].length, priorita: 5 });
    }
    return out;
  }

  // Anonimizza un testo con tutti e tre i livelli.
  async maschera(testo) {
    const t = String(testo ?? '');
    if (!piiAttivo() || !t.trim()) return t;
    if (!this.noti) this.noti = await nomiNoti(this.userId);
    const presidio = await trovaConPresidio(t);
    if (presidio.motore === 'presidio') this.motore = 'presidio';
    return this.applica(t, [...this.trovaGiaNoti(t), ...trovaNomiNoti(t, this.noti), ...trovaConRegole(t), ...presidio.trovati]);
  }

  // Versione immediata (senza NER), per i punti che non possono attendere: valori già visti in
  // questa sessione, nomi noti e regole. Richiede maschera() chiamata almeno una volta prima.
  mascheraSubito(testo) {
    const t = String(testo ?? '');
    if (!piiAttivo() || !t.trim()) return t;
    return this.applica(t, [...this.trovaGiaNoti(t), ...(this.noti ? trovaNomiNoti(t, this.noti) : []), ...trovaConRegole(t)]);
  }

  // Rimette i valori veri al posto dei segnaposto nella risposta dell'AI. json: la risposta è
  // JSON e il valore va con le virgolette/barre protette.
  ripristina(testo, { json = false } = {}) {
    if (!this.perSegnaposto.size || testo == null) return testo;
    return String(testo).replace(RE_SEGNAPOSTO, (x, e1, n1, e2, n2) => {
      const v = this.perSegnaposto.get(`${String(e1 || e2).toUpperCase()}_${Number(n1 || n2)}`);
      if (v === undefined) return x;
      return json ? JSON.stringify(String(v)).slice(1, -1) : v;
    });
  }

  // Riepilogo per il log: SOLO i conteggi per tipo, mai i valori.
  riepilogo() {
    return Object.entries(this.contatori).map(([k, n]) => `${k} ${n}`).join(', ') || 'nessuno';
  }

  esporta() { return JSON.stringify([...this.perSegnaposto]); }

  static importa(userId, json) {
    const a = new Anonimizzatore(userId);
    try {
      for (const [s, v] of JSON.parse(json || '[]')) {
        a.perSegnaposto.set(s, v);
        const etichetta = s.replace(/_\d+$/, '');
        a.perValore.set(`${etichetta}|${norm(v)}`, s);
        a.contatori[etichetta] = Math.max(a.contatori[etichetta] || 0, Number(s.split('_').pop()) || 0);
      }
    } catch { /* mappa illeggibile: la risposta resta con i segnaposto */ }
    return a;
  }
}

// ----------------------------------------------------------------------------
// PSEUDONIMIZZAZIONE DEI FILE DI ADDESTRAMENTO (2026-10-23)
// ----------------------------------------------------------------------------
// I file JSONL di Analisi PM (domande, recap, associazioni, RAID e CR) vanno su Google Colab:
// prima di uscire dal server ogni dato personale diventa un dato FINTO ma realistico e coerente
// in tutto il file («Mario Rossi» -> sempre «Luca Ferri», «Rossi» da solo -> «Ferri», il cliente
// -> «Azienda Alfa»). Niente segnaposto tra parentesi: il modello deve imparare su testo
// naturale, come quello che vedrà davvero. La corrispondenza vera/finta resta in memoria per
// la sola durata del download e non si salva da nessuna parte.
// Stessi tre livelli dell'anonimizzazione (nomi noti, regole, Presidio) e attiva anche con
// PII_MASCHERAMENTO spento: un file di addestramento non esce mai con i dati veri.
const NOMI_FINTI = ['Luca', 'Giulia', 'Marco', 'Sara', 'Andrea', 'Chiara', 'Paolo', 'Elena', 'Davide', 'Marta', 'Stefano',
  'Laura', 'Simone', 'Francesca', 'Matteo', 'Silvia', 'Roberto', 'Valentina', 'Fabio', 'Federica', 'Alberto', 'Anna',
  'Riccardo', 'Paola', 'Giorgio', 'Alessia', 'Enrico', 'Monica', 'Daniele', 'Ilaria', 'Massimo', 'Roberta', 'Claudio',
  'Beatrice', 'Nicola', 'Serena', 'Emanuele', 'Cristina', 'Filippo', 'Barbara', 'Tommaso', 'Elisa', 'Pietro', 'Lucia',
  'Antonio', 'Martina', 'Alessio', 'Teresa', 'Gabriele', 'Carla'];
const COGNOMI_FINTI = ['Ferri', 'Galli', 'Conti', 'Moretti', 'Barbieri', 'Fontana', 'Santoro', 'Mariani', 'Rinaldi', 'Caruso',
  'Ferrara', 'Lombardi', 'Testa', 'Gentile', 'Martinelli', 'Serra', 'Villa', 'Pellegrini', 'Leone', 'Longo', 'Sala',
  'Vitale', 'Bernardi', 'Monti', 'Fabbri', 'Marchetti', 'Grasso', 'Parisi', 'Silvestri', 'Cattaneo', 'Ferraro', 'Rossetti',
  'Bianco', 'Benedetti', 'Riva', 'Orlando', 'Neri', 'Donati', 'Sartori', 'Messina', 'Farina', 'Palumbo', 'Guidi', 'Bassi',
  'Valentini', 'Pagano', 'Basile', 'Morelli', 'Negri', 'Grassi', 'Coppola', 'Mazza', 'Fiore', 'Ruggiero', 'Piras'];
const LETTERE_GRECHE = ['Alfa', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mi',
  'Ni', 'Xi', 'Omicron', 'Pi', 'Rho', 'Sigma', 'Tau', 'Ypsilon', 'Phi', 'Chi', 'Psi', 'Omega'];
const LUOGHI_FINTI = ['Valverde', 'Montefiore', 'Borgonuovo', 'Castelrosso', 'Pianalto', 'Roccabella', 'Sanfelice', 'Collebianco'];
const MAIUSCOLO = (s) => s.length > 1 && s === s.toUpperCase() && s !== s.toLowerCase();

export class Pseudonimizzatore extends Anonimizzatore {
  constructor(userId) {
    super(userId);
    this.tipi = new Map();          // valore vero normalizzato -> tipo (per trovaGiaNoti)
    this.finti = new Map();         // "tipo|valore vero normalizzato" -> valore finto
    this.parolaPersona = new Map(); // parola vera (minuscola) -> parola finta: nome e cognome restano coerenti
    this.usati = { nome: 0, cognome: 0 };
  }

  // Nome o cognome finto per una parola vera; i finti non si ripetono finché ce ne sono.
  parolaFinta(parola, tipo) {
    const k = parola.toLowerCase();
    let f = this.parolaPersona.get(k);
    if (!f) {
      const lista = tipo === 'nome' ? NOMI_FINTI : COGNOMI_FINTI;
      const n = this.usati[tipo]++;
      f = lista[n % lista.length] + (n >= lista.length ? String(Math.floor(n / lista.length) + 1) : '');
      this.parolaPersona.set(k, f);
    }
    return MAIUSCOLO(parola) ? f.toUpperCase() : f;
  }

  finto(tipo, valore) {
    const parole = String(valore).match(RE_PAROLA) || [];
    const n = (this.contatori[tipo] = (this.contatori[tipo] || 0) + 1);
    switch (tipo) {
      case 'PERSON':
        // Più parole: la prima è il nome (o la si tratta così), le altre i cognomi.
        return parole.length ? parole.map((p, i) => this.parolaFinta(p, parole.length > 1 && i === 0 ? 'nome' : 'cognome')).join(' ') : 'Persona';
      case 'ORGANIZATION': return `Azienda ${LETTERE_GRECHE[(n - 1) % 24]}${n > 24 ? ` ${Math.ceil(n / 24)}` : ''}`;
      case 'LOCATION': return `${LUOGHI_FINTI[(n - 1) % LUOGHI_FINTI.length]}${n > LUOGHI_FINTI.length ? ` ${Math.ceil(n / LUOGHI_FINTI.length)}` : ''}`;
      case 'EMAIL_ADDRESS': return `utente${n}@esempio.it`;
      case 'PHONE_NUMBER': return `+39 333 000 ${String(n).padStart(4, '0')}`;
      case 'URL': return `https://www.esempio${n}.it`;
      case 'IBAN_CODE': return `IT00X000000000000000000${String(n).padStart(4, '0')}`;
      case 'CREDIT_CARD': return `4000 0000 0000 ${String(n).padStart(4, '0')}`;
      case 'IP_ADDRESS': return `10.0.0.${n % 250}`;
      case 'IT_FISCAL_CODE': return `XXXXXX00X00X${String(n).padStart(3, '0')}X`;
      case 'IT_VAT_CODE': return `IT${String(n).padStart(11, '0')}`;
      default: return `DOC${String(n).padStart(6, '0')}`;
    }
  }

  segnaposto(tipo, valore) {
    const chiave = `${tipo}|${norm(valore)}`;
    let f = this.finti.get(chiave);
    if (f === undefined) {
      f = this.finto(tipo, valore);
      this.finti.set(chiave, f);
      this.tipi.set(String(valore), tipo);
      this.perSegnaposto.set(`${tipo}|${this.finti.size}`, valore); // solo per il conteggio (totale)
    }
    return f;
  }

  trovaGiaNoti(testo) {
    const out = [];
    for (const [valore, tipo] of this.tipi) {
      if (valore.length < 3) continue;
      const re = new RegExp(`${BORDO_PRIMA}${escRe(valore).replace(/\s+/g, '\\s+')}${BORDO_DOPO}`, 'giu');
      let m;
      while ((m = re.exec(testo))) out.push({ tipo, inizio: m.index, fine: m.index + m[0].length, priorita: 5 });
    }
    return out;
  }

  // Come maschera(), ma sempre attiva (anche con PII_MASCHERAMENTO spento).
  async maschera(testo) {
    const t = String(testo ?? '');
    if (!t.trim()) return t;
    if (!this.noti) this.noti = await nomiNoti(this.userId);
    const presidio = await trovaConPresidio(t);
    if (presidio.motore === 'presidio') this.motore = 'presidio';
    return this.applica(t, [...this.trovaGiaNoti(t), ...trovaNomiNoti(t, this.noti), ...trovaConRegole(t), ...presidio.trovati]);
  }
}

// File JSONL di addestramento (una riga = { messages: [{ role, content }] }) pseudonimizzato:
// ogni content passa dal Pseudonimizzatore, con la stessa corrispondenza per tutto il file.
// Se Presidio è configurato ma non risponde il download si FERMA (503): con le sole regole e i
// nomi noti i nomi che Projexa non conosce uscirebbero veri.
export async function pseudonimizzaJsonl(userId, righeJson, etichetta = 'addestramento') {
  if (piiUrl()) {
    const stato = await statoAnonimizzazione().catch(() => ({ disponibile: false }));
    if (stato.motore === 'presidio' && !stato.disponibile) {
      throw errore(503, 'Pseudonimizzazione non disponibile (servizio Presidio della VM non raggiungibile): per riservatezza il file non viene scaricato. Riprova tra qualche minuto.');
    }
  }
  const p = new Pseudonimizzatore(userId);
  const giaFatti = new Map(); // stesso testo (es. istruzioni di sistema ripetute) = un solo passaggio
  const out = [];
  for (const riga of righeJson) {
    if (!riga) continue;
    const r = JSON.parse(riga);
    for (const m of Array.isArray(r.messages) ? r.messages : []) {
      if (typeof m.content !== 'string' || !m.content.trim()) continue;
      if (!giaFatti.has(m.content)) giaFatti.set(m.content, await p.maschera(m.content));
      m.content = giaFatti.get(m.content);
    }
    out.push(JSON.stringify(r));
  }
  console.log(`[PII] File di ${etichetta} pseudonimizzato: ${out.length} righe, ${p.totale} dati sostituiti (${p.riepilogo()}) · motore ${p.motore}`);
  return out;
}

// Prompt pronto per un'AI esterna: { prompt, anon } (anon null se l'anonimizzazione è spenta).
// Con almeno un dato sostituito, in testa va la NOTA che spiega i segnaposto all'AI.
export async function anonimizzaPrompt(userId, prompt, { anon = null, etichetta = 'AI' } = {}) {
  if (!piiAttivo()) return { prompt, anon: null };
  const a = anon || new Anonimizzatore(userId);
  const mascherato = await a.maschera(prompt);
  if (a.totale) console.log(`[PII] ${etichetta}: ${a.totale} dati anonimizzati (${a.riepilogo()}) · motore ${a.motore}`);
  return { prompt: a.totale ? NOTA_SEGNAPOSTO + mascherato : mascherato, anon: a };
}

// ----------------------------------------------------------------------------
// RICHIESTE BATCH: tabella dei segnaposto salvata cifrata fino alla risposta
// ----------------------------------------------------------------------------
// Copia in memoria (risposta di solito in pochi minuti); il DB serve dopo un riavvio/deploy.
let ultimaPulizia = 0;
const mappeInMemoria = new Map(); // "provider|batchId" -> { anon, at }
const chiaveBatch = (provider, batchId) => `${String(provider).toLowerCase()}|${batchId}`;

export async function salvaMappaBatch(provider, batchId, userId, anon) {
  if (!anon || !anon.totale) return;
  mappeInMemoria.set(chiaveBatch(provider, batchId), { anon, at: Date.now() });
  try {
    await db.query(
      `INSERT INTO ai_pii_mappe (provider, batch_id, user_id, mappa) VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, batch_id) DO UPDATE SET mappa = EXCLUDED.mappa`,
      [String(provider).toLowerCase(), String(batchId), userId, encryptValue(anon.esporta())]
    );
  } catch (e) {
    console.error(`[PII] Mappa del batch ${batchId} non salvata sul DB (${e.message}): resta solo in memoria fino al riavvio`);
  }
}

export async function ripristinaBatch(provider, batchId, userId, testo, opzioni = {}) {
  if (testo == null) return testo;
  if (Date.now() - ultimaPulizia > 60 * 60 * 1000) {
    ultimaPulizia = Date.now();
    const limite = Date.now() - 7 * 24 * 3600 * 1000;
    for (const [k, v] of mappeInMemoria) if (v.at < limite) mappeInMemoria.delete(k);
    db.query(`DELETE FROM ai_pii_mappe WHERE creato_il < now() - interval '7 days'`).catch(() => {});
  }
  const mem = mappeInMemoria.get(chiaveBatch(provider, batchId));
  if (mem) return mem.anon.ripristina(testo, opzioni);
  try {
    const r = (await db.query(
      'SELECT mappa FROM ai_pii_mappe WHERE provider = $1 AND batch_id = $2',
      [String(provider).toLowerCase(), String(batchId)]
    )).rows[0];
    return r ? Anonimizzatore.importa(userId, r.mappa).ripristina(testo, opzioni) : testo;
  } catch (e) {
    console.error(`[PII] Mappa del batch ${batchId} non leggibile (${e.message}): risposta con i segnaposto`);
    return testo;
  }
}
