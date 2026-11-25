// ============================================================================
// ANONYMIZATION LAYER (PII MASKING) PER LE AI ESTERNE (2026-10-22)
// ----------------------------------------------------------------------------
// Ogni testo che Projexa manda a un'AI ESTERNA (Claude, ChatGPT, Gemini, Mistral), in modalità
// Immediata o Batch, passa di qui: i dati personali vengono sostituiti da segnaposto
// ([PERSONA_1], [AZIENDA_2], [EMAIL_1], ...) e la risposta dell'AI torna con i segnaposto, che
// Projexa sostituisce con i valori veri prima di mostrarla o salvarla. L'AI lavora sul contenuto
// (cosa si è deciso, quali rischi, quali azioni) senza sapere a chi appartiene.
// I servizi di trascrizione locali della VM NON passano di qui: i dati non escono dal server.
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
import authDb from './authDatabase.js';
import { encryptValue } from './crypto.js';

const disattivo = (v) => /^(0|off|no|false|spento|disattivo)$/i.test(String(v ?? '').trim());
export const piiAttivo = () => !disattivo(process.env.PII_MASCHERAMENTO);
const piiUrl = () => String(process.env.PII_URL || '').trim().replace(/\/+$/, '');
const bloccaSenzaServizio = () => /^blocca$/i.test(String(process.env.PII_SE_NON_DISPONIBILE || '').trim());
const entitaNer = () => String(process.env.PII_ENTITA_NER || 'PERSON').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const soglia = () => Number(process.env.PII_SOGLIA) || 0.5;

// Etichette dei segnaposto (in italiano: l'AI le capisce e le riusa così come sono).
// PERSON_INTERNO / PERSON_CLIENTE (2026-11-25): persone note divise per dominio email (vedi
// classePersona): [INTERNO_n] = stesso dominio dell'utente (il suo team), [CLIENTE_n] = dominio
// diverso. [PERSONA_n] resta per chi non si può classificare (nessuna email, provider pubblici, NER).
const ETICHETTE = {
  PERSON: 'PERSONA', PERSON_INTERNO: 'INTERNO', PERSON_CLIENTE: 'CLIENTE', ORGANIZATION: 'AZIENDA', LOCATION: 'LUOGO',
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
  + 'email, telefoni, codici) sono stati sostituiti da segnaposto tra parentesi quadre, ad esempio [INTERNO_1], [CLIENTE_1], '
  + '[PERSONA_1], [AZIENDA_1], [EMAIL_1]. Quando ti servono riportali ESATTAMENTE come sono scritti (stesse maiuscole, numero e '
  + 'parentesi), senza tradurli, modificarli o inventare i dati reali. Lo stesso segnaposto indica sempre la stessa persona o cosa.\n'
  + 'Le persone sono divise così: [INTERNO_n] = persona della NOSTRA azienda (il nostro team: le attività a suo carico sono '
  + 'nostre); [CLIENTE_n] = persona del CLIENTE o comunque esterna alla nostra azienda (le attività a suo carico sono del '
  + 'cliente); [PERSONA_n] = persona di cui non sappiamo se è interna o del cliente (decidilo solo dal contesto, se è chiaro). '
  + '«Partecipante 1», «Partecipante 2»... sono voci della riunione senza nome: anche per loro interno o cliente si capisce '
  + 'solo dal contesto.\n\n';

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
//
// SEGNAPOSTO PER PERSONA (2026-11-12): ogni persona (e ogni cliente) nota ha un'IDENTITÀ, e
// tutte le sue forme danno lo STESSO segnaposto: «Yanko Dacco'», «Dacco' Yanko», «Dacco'» e
// «Yanko» -> [PERSONA_1]. Prima ogni forma aveva il suo segnaposto e l'AI non poteva capire che
// «Yanko» nella trascrizione era «Yanko Dacco'» dell'elenco del team: niente owner nei recap.
// Nome o cognome da soli (con la maiuscola): valgono se appartengono a una sola persona nota,
// oppure, se sono di più persone, se nello stesso testo (o sessione) compare per intero una
// sola di loro («Marco» = «Marco Bianchi» del team, anche se in rubrica c'è un altro Marco).
// Il ripristino usa la forma più lunga vista nel testo («Yanko» -> «Yanko Dacco'» se nel testo
// c'è anche il nome intero).
const CACHE_NOMI_MS = 10 * 60 * 1000;
const cacheNomi = new Map(); // user_id -> { at, indice: Map(prima parola -> [{ parole, tipo, maiuscola, id }]), ambigui: Map(parola -> [id]) }
// Nomi propri che sono anche parole comuni: da soli non si mascherano (con il cognome sì).
const NOMI_PAROLA = new Set(['vera', 'rosa', 'bianca', 'sole', 'stella', 'serena', 'gioia', 'felice', 'celeste', 'speranza',
  'marina', 'franco', 'chiara', 'luce', 'pia', 'fortunato', 'fortunata', 'benedetta', 'benedetto', 'italia', 'grazia',
  'gloria', 'viola', 'margherita', 'regina', 'santo', 'santa', 'natale', 'pasqua', 'domenica', 'ventura', 'fiore', 'neve',
  'alba', 'aurora', 'leone', 'amore', 'giusto', 'giusta', 'primo', 'prima', 'costante', 'onesta', 'nevio', 'nazzareno',
  'grande', 'piccolo', 'bello', 'bella', 'conte', 'costa', 'riva', 'monti', 'ferro', 'fabbri', 'porta', 'villa', 'rossa']);
const PARTICELLE = new Set(['de', 'di', 'da', 'del', 'della', 'dei', 'degli', 'dal', 'van', 'von', 'der', 'la', 'lo', 'le', 'mc', 'mac', 'san', 'dos', 'das']);
const RE_PAROLA = /[\p{L}\p{N}]+/gu;
const RE_SEPARATORE = /^[\s'’\-.&]{1,3}$/u;
// Forma societaria in coda al nome del cliente: si cerca anche il nome senza («Acme» per «Acme S.r.l.»).
const RE_FORMA_SOCIETARIA = /[\s,]+(s\.?\s?p\.?\s?a\.?|s\.?\s?r\.?\s?l\.?(\s?s\.?)?|s\.?\s?n\.?\s?c\.?|s\.?\s?a\.?\s?s\.?|spa|srl|snc|sas|soc\.?\s?coop\.?|ltd\.?|gmbh|inc\.?)\s*$/iu;

async function righe(sql, params, pool = db) {
  try { return (await pool.query(sql, params)).rows; } catch (e) {
    console.warn(`[PII] Nomi noti: query non riuscita (${e.message})`);
    return [];
  }
}

// INTERNO / CLIENTE DAL DOMINIO EMAIL (2026-11-25)
// Domini interni = dominio dell'email dell'utente (Projexa-Auth) + PII_DOMINI_INTERNI (.env,
// separati da virgola: altri domini della stessa azienda). Una persona nota con almeno un'email
// su un dominio interno è INTERNO; con email solo su altri domini è CLIENTE. I provider pubblici
// (gmail, outlook...) non dicono a quale azienda appartiene la persona: non classificano (resta
// PERSONA), a meno che non siano elencati apposta in PII_DOMINI_INTERNI.
const DOMINI_PUBBLICI = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'outlook.it', 'hotmail.com', 'hotmail.it',
  'live.com', 'live.it', 'msn.com', 'yahoo.com', 'yahoo.it', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'libero.it',
  'virgilio.it', 'tiscali.it', 'alice.it', 'tim.it', 'fastwebnet.it', 'email.it', 'inwind.it', 'aruba.it', 'pec.it',
  'legalmail.it', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.it', 'aol.com']);
const dominioEmail = (e) => {
  const m = String(e || '').trim().toLowerCase().match(/@([^@\s>]+)$/);
  return m ? m[1].replace(/\.+$/, '') : '';
};
const dominiInterniEnv = () => String(process.env.PII_DOMINI_INTERNI || '').split(',')
  .map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
// domini: Set dei domini email della persona -> 'INTERNO' | 'CLIENTE' | null.
function classePersona(domini, interni) {
  if (!domini || !domini.size) return null;
  let esterno = false;
  for (const d of domini) {
    if (interni.has(d)) return 'INTERNO';
    if (!DOMINI_PUBBLICI.has(d)) esterno = true;
  }
  return esterno ? 'CLIENTE' : null;
}

const parole = (s) => String(s || '').match(RE_PAROLA) || [];

async function nomiNoti(userId) {
  const k = String(userId || '');
  const c = cacheNomi.get(k);
  if (c && Date.now() - c.at < CACHE_NOMI_MS) return c;
  const indice = new Map();
  const ok = consentitiSet();
  const visti = new Set();
  // Identità: stessa persona da più tabelle (rubrica, contatti, utenti...) = stesso id.
  // Chiave = parole del nome in ordine alfabetico («Rossi Mario» = «Mario Rossi»).
  const identita = new Map(); // chiave -> id
  let prossimoId = 0;
  const idDi = (tipo, nome) => {
    const k = `${tipo}|${parole(nome).map((x) => x.toLowerCase()).sort().join(' ')}`;
    if (!identita.has(k)) identita.set(k, ++prossimoId);
    return identita.get(k);
  };
  const alias = new Map(); // parola singola -> Set(id) (nomi e cognomi da soli)
  // maiuscola: il nome vale solo se nel testo inizia con la maiuscola (nomi/cognomi da soli).
  const aggiungi = (nome, tipo, id, maiuscola = false) => {
    const p = parole(nome);
    const testo = p.join(' ');
    if (!p.length || testo.length < 3 || ok.has(testo.toLowerCase())) return;
    const chiave = `${tipo}|${maiuscola ? 1 : 0}|${testo.toLowerCase()}|${id}`;
    if (visti.has(chiave)) return;
    visti.add(chiave);
    const prima = p[0].toLowerCase();
    if (!indice.has(prima)) indice.set(prima, []);
    indice.get(prima).push({ parole: p.map((x) => x.toLowerCase()), tipo, maiuscola, id });
  };
  const aggiungiAlias = (parola, id) => {
    const w = String(parola || '').toLowerCase();
    if (w.length < 3 || PARTICELLE.has(w) || NOMI_PAROLA.has(w) || ok.has(w)) return;
    if (!alias.has(w)) alias.set(w, new Set());
    alias.get(w).add(id);
  };
  const dominiPer = new Map(); // id persona -> Set(domini email) (interno / cliente)
  const persona = (nome, cognome, email = '') => {
    const n = String(nome || '').trim();
    const cg = String(cognome || '').trim();
    const tutte = parole(`${n} ${cg}`);
    if (!tutte.length) return;
    const id = idDi('PERSON', tutte.join(' '));
    const dom = dominioEmail(email);
    if (dom) { if (!dominiPer.has(id)) dominiPer.set(id, new Set()); dominiPer.get(id).add(dom); }
    if (n && cg) { aggiungi(`${n} ${cg}`, 'PERSON', id); aggiungi(`${cg} ${n}`, 'PERSON', id); }
    else if (parole(n).length > 1) { aggiungi(n, 'PERSON', id); aggiungi(parole(n).reverse().join(' '), 'PERSON', id); }
    // Nome e cognome da soli (con la maiuscola): «ne parlo con Bianchi», «Yanko aiutami».
    for (const w of tutte) aggiungiAlias(w, id);
  };
  // Email degli utenti (e dell'utente stesso): stanno su Projexa-Auth, stesso id del database principale.
  const emailUtenti = async (ids) => {
    const m = new Map();
    if (!ids.length) return m;
    for (const r of await righe('SELECT id::text AS id, email FROM users WHERE id::text = ANY($1::text[])', [ids], authDb)) m.set(r.id, r.email);
    return m;
  };
  const interni = new Set(dominiInterniEnv());
  const mioDominio = dominioEmail((await emailUtenti([k])).get(k));
  if (mioDominio && !DOMINI_PUBBLICI.has(mioDominio)) interni.add(mioDominio);
  const tenants = (await righe('SELECT DISTINCT tenant_id FROM user_tenants WHERE user_id = $1', [k])).map((r) => r.tenant_id);
  if (tenants.length) {
    const t = [tenants];
    for (const r of await righe(
      `SELECT valore2 FROM clients WHERE tenant_id = ANY($1::uuid[]) AND argument = 'Cliente' AND campo = 'Cliente' AND valore2 IS NOT NULL`, t)) {
      const corto = String(r.valore2).replace(RE_FORMA_SOCIETARIA, '').trim();
      const idOrg = idDi('ORGANIZATION', corto || r.valore2); // «Acme» e «Acme S.r.l.» = stesso cliente
      aggiungi(r.valore2, 'ORGANIZATION', idOrg);
      if (corto && corto !== String(r.valore2).trim()) aggiungi(corto, 'ORGANIZATION', idOrg);
    }
    for (const r of await righe('SELECT nome, cognome, email FROM contacts WHERE tenant_id = ANY($1::uuid[])', t)) persona(r.nome, r.cognome, r.email);
    for (const r of await righe('SELECT nominativo, email FROM rubrica WHERE tenant_id = ANY($1::uuid[])', t)) persona(r.nominativo, '', r.email);
    for (const r of await righe('SELECT DISTINCT nominativo, email FROM proj_componenti WHERE tenant_id = ANY($1::uuid[])', t)) persona(r.nominativo, '', r.email);
    for (const r of await righe('SELECT nominativo, email FROM pm_stakeholder WHERE tenant_id = ANY($1::uuid[])', t)) persona(r.nominativo, '', r.email);
    const utenti = await righe(
      'SELECT DISTINCT u.id::text AS id, u.name, u.cognome FROM users u JOIN user_tenants ut ON ut.user_id = u.id WHERE ut.tenant_id = ANY($1::uuid[])', t);
    const emailU = await emailUtenti(utenti.map((r) => r.id));
    for (const r of utenti) persona(r.name, r.cognome, emailU.get(r.id));
  }
  // Interno / cliente per persona. Senza nessun dominio interno (es. utente con email gmail e
  // PII_DOMINI_INTERNI vuoto) non si classifica nessuno: tutti «cliente» sarebbe sbagliato.
  const classe = new Map(); // id persona -> 'INTERNO' | 'CLIENTE'
  if (interni.size) {
    for (const [id, domini] of dominiPer) {
      const c = classePersona(domini, interni);
      if (c) classe.set(id, c);
    }
  }
  // Nome o cognome da solo: di una sola persona -> nell'indice; di più persone -> «ambiguo»,
  // si decide nel testo (trovaNomiNoti) in base a chi vi compare per intero.
  const ambigui = new Map(); // parola -> [id]
  for (const [w, ids] of alias) {
    if (ids.size === 1) aggiungi(w, 'PERSON', [...ids][0], true);
    else ambigui.set(w, [...ids]);
  }
  // Nomi più lunghi prima: «Mario Rossi Bianchi» vince su «Mario Rossi».
  for (const lista of indice.values()) lista.sort((a, b) => b.parole.length - a.parole.length);
  const voce = { at: Date.now(), indice, ambigui, classe, totale: visti.size };
  cacheNomi.set(k, voce);
  return voce;
}

// presenti: id delle persone già viste per intero nella sessione (Anonimizzatore), per
// decidere i nomi da soli ambigui.
function trovaNomiNoti(testo, noti, presenti = new Set()) {
  const out = [];
  if (!noti || !noti.indice.size) return out;
  const tok = [];
  RE_PAROLA.lastIndex = 0;
  let m;
  while ((m = RE_PAROLA.exec(testo))) tok.push({ p: m[0], l: m[0].toLowerCase(), i: m.index, f: m.index + m[0].length });
  const coperto = new Set(); // indici di token già presi
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
      // Apostrofo finale del cognome («Dacco'»): fa parte del nome, non resta fuori dal segnaposto.
      let fine = tok[i + n - 1].f;
      if (/['’]/.test(testo[fine] || '') && !/[\p{L}\p{N}]/u.test(testo[fine + 1] || '')) fine += 1;
      out.push({ tipo: c.tipo, inizio: tok[i].i, fine, priorita: c.maiuscola ? 3 : 4, id: c.id });
      for (let j = 0; j < n; j++) coperto.add(i + j);
      i += n - 1;
      break;
    }
  }
  // Nomi da soli di più persone: valgono se nel testo (o nella sessione) c'è per intero una
  // sola di quelle persone.
  if (noti.ambigui && noti.ambigui.size) {
    const qui = new Set([...presenti, ...out.filter((x) => x.tipo === 'PERSON' && x.priorita === 4).map((x) => x.id)]);
    tok.forEach((t, i) => {
      if (coperto.has(i) || !/^\p{Lu}/u.test(t.p)) return;
      const ids = noti.ambigui.get(t.l);
      if (!ids) return;
      const scelti = ids.filter((id) => qui.has(id));
      if (scelti.length === 1) out.push({ tipo: 'PERSON', inizio: t.i, fine: t.f, priorita: 3, id: scelti[0] });
    });
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
    this.perSegnaposto = new Map(); // "ETICHETTA_n" -> valore originale (la forma più lunga vista)
    this.perId = new Map();         // "tipo|id" della persona/cliente noti -> "ETICHETTA_n"
    this.contatori = {};
    this.motore = 'regole';
  }

  get totale() { return this.perSegnaposto.size; }

  // id: identità della persona o del cliente noti (nomiNoti): tutte le sue forme («Yanko»,
  // «Yanko Dacco'») hanno lo stesso segnaposto.
  segnaposto(tipo, valore, id = null) {
    // Persona nota interna o del cliente (dominio email): [INTERNO_n] / [CLIENTE_n]. L'identità
    // (chiaveId) resta «PERSON|id», così idPresenti e i nomi da soli continuano a funzionare.
    const classe = tipo === 'PERSON' && id != null ? this.noti?.classe?.get(id) : null;
    const etichetta = classe || ETICHETTE[tipo] || 'DATO';
    const chiave = `${etichetta}|${norm(valore)}`;
    const chiaveId = id != null ? `${tipo}|${id}` : null;
    let s = (chiaveId && this.perId.get(chiaveId)) || this.perValore.get(chiave);
    if (!s) {
      this.contatori[etichetta] = (this.contatori[etichetta] || 0) + 1;
      s = `${etichetta}_${this.contatori[etichetta]}`;
      this.perSegnaposto.set(s, valore);
    } else if (parole(valore).length > parole(this.perSegnaposto.get(s)).length) {
      this.perSegnaposto.set(s, valore); // al ripristino la forma più completa
    }
    this.perValore.set(chiave, s);
    if (chiaveId) this.perId.set(chiaveId, s);
    return `[${s}]`;
  }

  // Persone già viste per intero in questa sessione (per i nomi da soli ambigui).
  idPresenti() {
    return new Set([...this.perId.keys()].filter((k) => k.startsWith('PERSON|')).map((k) => Number(k.slice(7))));
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
      out += testo.slice(pos, t.inizio) + this.segnaposto(t.tipo, testo.slice(t.inizio, t.fine), t.id);
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
    return this.applica(t, [...this.trovaGiaNoti(t), ...trovaNomiNoti(t, this.noti, this.idPresenti()), ...trovaConRegole(t), ...presidio.trovati]);
  }

  // Versione immediata (senza NER), per i punti che non possono attendere: valori già visti in
  // questa sessione, nomi noti e regole. Richiede maschera() chiamata almeno una volta prima.
  mascheraSubito(testo) {
    const t = String(testo ?? '');
    if (!piiAttivo() || !t.trim()) return t;
    return this.applica(t, [...this.trovaGiaNoti(t), ...(this.noti ? trovaNomiNoti(t, this.noti, this.idPresenti()) : []), ...trovaConRegole(t)]);
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
