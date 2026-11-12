// ============================================================================
// CHI PARLA NELLA RIUNIONE (2026-11-12) - Supporto/CreaDB/rec_meeting_parlanti.sql
// ----------------------------------------------------------------------------
// La trascrizione divide gli altri partecipanti in «Partecipante 1, 2…» (diarizzazione, a fine
// riunione) ma non sa chi sono. Qui si danno i nomi, in due modi:
//
//  1. AUTOMATICO, dai clic: durante la registrazione il PM clicca l'icona di chi parla
//     (sito/dashboard.html, pannello «Chi parla»); ogni clic = { secondo della registrazione,
//     persona } in rec_meeting_parlanti. A fine registrazione, dopo la diarizzazione e PRIMA del
//     recap, applicaParlanti() sostituisce le etichette:
//       - un clic «aggancia» la riga degli altri in corso in quel momento (con ANTICIPO_SEC di
//         tolleranza: si clicca quando la voce è già partita, ma l'orario della riga è l'inizio
//         della frase) e quella riga prende la persona cliccata;
//       - la persona resta «di turno» sulle righe degli altri successive, fino al clic seguente;
//       - ogni «Partecipante N» prende la persona che ha la maggioranza (QUOTA_GRUPPO) del suo
//         parlato tra le righe di turno: così si coprono anche le frasi dove non si è cliccato;
//       - ordine di precedenza: riga agganciata > persona del gruppo > persona di turno.
//     Senza diarizzazione («Partecipanti») valgono solo aggancio e turno.
//
//  2. MANUALE: finestra «Assegna nomi» (allo Stop per i «Partecipante N» rimasti, oppure dalla
//     finestra della trascrizione per correggere qualsiasi etichetta). rinominaParlanti()
//     aggiorna la trascrizione e, se ci sono già, recap cliente, recap interno, attività del
//     recap interno (owner compreso), To-Do create dalla riunione e azioni del cliente.
//
// All'AI esterna i nomi arrivano comunque anonimizzati (config/pii.js, [PERSONA_n]): i clic e
// l'associazione voce -> persona non escono mai da Projexa.
// ============================================================================
import db from './database.js';
import { encryptRowForWrite } from './crypto.js';
import { SALTA_LOG_ON, SALTA_LOG_OFF } from './audit.js';
import { encRec, speakerName } from '../jobs/meetingTranscription.js';

export const RIGA_RE = /^\[(\d{2}):(\d{2}):(\d{2})\] ([^:\n]{1,100}?): /;
export const ALTRI_RE = /^(Partecipanti|Partecipante \d+)$/;
const GRUPPO_RE = /^Partecipante \d+$/;
const ANTICIPO_SEC = 3;      // clic arrivato fino a 3 s prima dell'inizio della riga: vale per lei...
const RIGA_VECCHIA_SEC = 5;  // ...se la riga in corso era partita da più di 5 s (altrimenti vale per quella)
const MAX_RIGA_SEC = 180;    // una riga «in corso» al clic non può essere iniziata da più di 3 minuti
const QUOTA_GRUPPO = 0.6;    // maggioranza del parlato di un «Partecipante N» per dargli il nome

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Nome usabile come etichetta di riga: niente «:» (chiuderebbe l'etichetta) né a capo.
export const pulisciNome = (s) => String(s || '').replace(/[:\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
const chiavePersona = (p) => (p.rubrica_id ? `r:${p.rubrica_id}` : p.contact_id ? `c:${p.contact_id}` : `n:${norm(p.nominativo)}`);

export async function tabellaPronta() {
  try {
    const r = await db.query(
      `SELECT (SELECT count(*) FROM information_schema.tables WHERE table_name = 'rec_meeting_parlanti') AS t,
              (SELECT count(*) FROM information_schema.columns WHERE table_name = 'rec_meeting' AND column_name = 'parlanti_stato') AS c`
    );
    return Number(r.rows[0].t) > 0 && Number(r.rows[0].c) > 0;
  } catch { return false; }
}

// Righe con etichetta della trascrizione: [{ i, sec, label, len }].
export function righeEtichettate(linee) {
  const out = [];
  linee.forEach((riga, i) => {
    const m = RIGA_RE.exec(riga);
    if (!m) return;
    out.push({ i, sec: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), label: m[4].trim(), len: Math.max(1, riga.length - m[0].length) });
  });
  return out;
}

// Abbinamento clic -> righe (puro, testabile). linee: righe della trascrizione; clic: [{ sec,
// nominativo, email, rubrica_id, contact_id }]. Restituisce Map(indice riga -> persona).
export function abbinaClic(linee, clic) {
  const altri = righeEtichettate(linee).filter((r) => ALTRI_RE.test(r.label));
  const out = new Map();
  if (!altri.length || !clic.length) return out;
  const ordinati = [...clic].map((c) => ({ ...c, sec: Number(c.sec) || 0 })).sort((a, b) => a.sec - b.sec);
  // 1. Aggancio: ogni clic alla riga degli altri in corso in quel momento; alla riga successiva
  //    se questa inizia entro ANTICIPO_SEC dal clic e quella in corso era partita da più di
  //    RIGA_VECCHIA_SEC (clic dato appena si è sentita la voce nuova, prima dell'orario della riga).
  const ancore = []; // { k (posizione in altri), p }
  for (const c of ordinati) {
    let k = -1;
    for (let j = 0; j < altri.length && altri[j].sec <= c.sec; j++) k = j;
    const dopo = k + 1 < altri.length ? altri[k + 1] : null;
    if (dopo && dopo.sec - c.sec <= ANTICIPO_SEC && (k < 0 || c.sec - altri[k].sec > RIGA_VECCHIA_SEC)) k += 1;
    if (k < 0 || c.sec - altri[k].sec > MAX_RIGA_SEC) {
      // Clic prima della prima riga, o in un lungo silenzio degli altri: vale per la riga successiva.
      const prossima = altri.findIndex((r) => r.sec >= c.sec);
      if (prossima < 0) continue;
      k = prossima;
    }
    if (ancore.length && ancore[ancore.length - 1].k === k) ancore[ancore.length - 1].p = c; // corretto subito: vale l'ultimo
    else ancore.push({ k, p: c });
  }
  // 2. Turno: dalla riga agganciata fino all'aggancio successivo.
  const diretta = new Map();
  const turno = new Map();
  ancore.forEach((a, n) => {
    diretta.set(a.k, a.p);
    const fine = n + 1 < ancore.length ? ancore[n + 1].k : altri.length;
    for (let k = a.k; k < fine; k++) turno.set(k, a.p);
  });
  // 3. Gruppi «Partecipante N»: persona con la maggioranza del parlato di turno.
  const voti = new Map(); // label -> Map(chiave -> { p, peso })
  altri.forEach((r, k) => {
    const p = turno.get(k);
    if (!p || !GRUPPO_RE.test(r.label)) return;
    if (!voti.has(r.label)) voti.set(r.label, new Map());
    const v = voti.get(r.label);
    const ch = chiavePersona(p);
    v.set(ch, { p, peso: ((v.get(ch) || {}).peso || 0) + r.len, diretti: ((v.get(ch) || {}).diretti || 0) + (diretta.has(k) ? 1 : 0) });
  });
  const perGruppo = new Map();
  for (const [label, v] of voti) {
    const tutti = [...v.values()].sort((a, b) => b.peso - a.peso);
    const tot = tutti.reduce((s, x) => s + x.peso, 0);
    if (tutti[0] && tutti[0].diretti > 0 && tutti[0].peso >= QUOTA_GRUPPO * tot) perGruppo.set(label, tutti[0].p);
  }
  // 4. Riga agganciata > persona del gruppo > persona di turno.
  altri.forEach((r, k) => {
    const p = diretta.get(k) || perGruppo.get(r.label) || turno.get(k);
    if (p) out.set(r.i, p);
  });
  return out;
}

// Clic della riunione (in chiaro: il pool decifra).
async function clicRiunione(user, idCalendar) {
  return (await db.query(
    `SELECT sec, nominativo, email, rubrica_id::text AS rubrica_id, contact_id::text AS contact_id
       FROM rec_meeting_parlanti WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 ORDER BY sec, id`,
    [user.tenant_id, user.user_id, idCalendar]
  )).rows;
}

// A fine registrazione (jobs/meetingTranscription.js, dopo dividiPartecipanti): etichette degli
// altri -> nominativi dei clic. Restituisce il numero di righe cambiate (0 senza clic/tabella).
export async function applicaParlanti(user, idCalendar) {
  let clic;
  try { clic = await clicRiunione(user, idCalendar); } catch (e) {
    if (e.code !== '42P01') console.error(`❌ [PARLANTI] ${idCalendar}: ${e.message}`);
    return 0;
  }
  if (!clic.length) return 0;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query(
      'SELECT trascrizione FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1 FOR UPDATE',
      [user.tenant_id, user.user_id, idCalendar]
    )).rows[0];
    if (!cur || !cur.trascrizione) { await client.query('ROLLBACK'); return 0; }
    const linee = cur.trascrizione.split('\n');
    let cambiate = 0;
    for (const [i, p] of abbinaClic(linee, clic)) {
      const nome = pulisciNome(p.nominativo);
      if (!nome) continue;
      const nuova = linee[i].replace(RIGA_RE, (t, h, mi, s) => `[${h}:${mi}:${s}] ${nome}: `);
      if (nuova !== linee[i]) { linee[i] = nuova; cambiate++; }
    }
    if (!cambiate) { await client.query('ROLLBACK'); return 0; }
    await client.query(SALTA_LOG_ON);
    await client.query('UPDATE rec_meeting SET trascrizione = $1, crypto = 1 WHERE tenant_id = $2 AND user_id = $3 AND id_calendar = $4',
      [encRec(linee.join('\n')), user.tenant_id, user.user_id, idCalendar]);
    await client.query(SALTA_LOG_OFF);
    await client.query('COMMIT');
    console.log(`[PARLANTI] ${idCalendar}: ${cambiate} righe con il nome da ${clic.length} clic`);
    return cambiate;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`❌ [PARLANTI] ${idCalendar}: nomi non applicati (${e.message})`);
    return 0;
  } finally {
    client.release();
  }
}

// Etichette della trascrizione per la finestra «Assegna nomi»: tutte tranne l'utente (voce del
// microfono), ognuna con prima apparizione, numero di righe e fino a 3 frasi d'esempio (le più lunghe).
export async function etichetteTrascrizione(user, testo) {
  const me = norm(await speakerName(user));
  const linee = String(testo || '').split('\n');
  const per = new Map();
  for (const r of righeEtichettate(linee)) {
    if (norm(r.label) === me) continue;
    if (!per.has(r.label)) per.set(r.label, { label: r.label, primo: r.sec, righe: 0, parlato: 0, frasi: [] });
    const e = per.get(r.label);
    e.righe += 1;
    const frase = linee[r.i].replace(RIGA_RE, '').trim();
    e.parlato += frase.length;
    e.frasi.push({ sec: r.sec, testo: frase });
  }
  return [...per.values()].map((e) => ({
    label: e.label, primo: e.primo, righe: e.righe,
    da_assegnare: ALTRI_RE.test(e.label),
    esempi: e.frasi.filter((f) => f.testo.length >= 25).sort((a, b) => b.testo.length - a.testo.length).slice(0, 3)
      .sort((a, b) => a.sec - b.sec).map((f) => ({ sec: f.sec, testo: f.testo.slice(0, 220) }))
  })).sort((a, b) => a.primo - b.primo);
}

// ---------------------------------------------------------------------------
// RINOMINA (manuale): etichette e testi collegati
// ---------------------------------------------------------------------------
// Sostituzione «a parola intera» di più nomi insieme (anche scambi A<->B): prima segnaposto, poi valori.
function sostituisciTesto(testo, coppie) {
  if (!testo || !coppie.length) return { testo, n: 0 };
  let out = String(testo);
  let n = 0;
  coppie.forEach((c, k) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escRe(c.da).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'gu');
    out = out.replace(re, () => { n++; return `\u0000${k}\u0000`; });
  });
  out = out.replace(/\u0000(\d+)\u0000/g, (x, k) => coppie[Number(k)].a);
  return { testo: out, n };
}
// Come sopra, ma solo nel testo tra i tag di un recap formattato (HTML), anche con l'apostrofo
// scritto come entità (&#39; / &apos;).
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function sostituisciHtml(html, coppie) {
  if (!html || !coppie.length) return { testo: html, n: 0 };
  let n = 0;
  const varianti = coppie.flatMap((c) => {
    const a = escHtml(c.a);
    const base = escHtml(c.da);
    return [...new Set([base, base.replace(/'/g, '&#39;'), base.replace(/'/g, '&apos;'), base.replace(/'/g, '&#039;')])].map((da) => ({ da, a }));
  });
  const out = String(html).split(/(<[^>]*>)/).map((parte) => {
    if (!parte || parte.startsWith('<')) return parte;
    const r = sostituisciTesto(parte, varianti);
    n += r.n;
    return r.testo;
  }).join('');
  return { testo: out, n };
}

// mappa: [{ da: 'Partecipante 3', a: { nominativo, email, rubrica_id, contact_id } }].
// collegati: aggiorna anche recap, recap interno, attività, To-Do e azioni del cliente.
// Restituisce i conteggi per la notifica.
export async function rinominaParlanti(user, idCalendar, mappa, { collegati = true } = {}) {
  const coppie = [];
  const visti = new Set();
  for (const x of Array.isArray(mappa) ? mappa : []) {
    const da = pulisciNome(x && x.da);
    const p = (x && x.a) || {};
    const a = pulisciNome(p.nominativo);
    if (!da || !a || norm(da) === norm(a) || visti.has(da)) continue;
    visti.add(da);
    coppie.push({
      da, a,
      email: String(p.email || '').trim().slice(0, 300) || null,
      rubrica_id: /^[0-9a-f-]{36}$/i.test(String(p.rubrica_id || '')) ? String(p.rubrica_id) : null
    });
  }
  const conti = { righe: 0, recap: 0, recapInterno: 0, attivita: 0, todo: 0, azioniCliente: 0 };
  if (!coppie.length) return conti;
  const perDa = new Map(coppie.map((c) => [c.da, c]));

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const m = (await client.query(
      `SELECT trascrizione, recap, recap_html, recap_interno, oggetto, data_calendar::text AS data FROM rec_meeting
        WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1 FOR UPDATE`,
      [user.tenant_id, user.user_id, idCalendar]
    )).rows[0];
    if (!m) throw Object.assign(new Error('Riunione non gestita con Projexa'), { status: 404 });

    // 1. Trascrizione: solo le etichette di riga.
    const linee = String(m.trascrizione || '').split('\n');
    linee.forEach((riga, i) => {
      const r = RIGA_RE.exec(riga);
      const c = r && perDa.get(r[4].trim());
      if (!c) return;
      linee[i] = riga.replace(RIGA_RE, (t, h, mi, s) => `[${h}:${mi}:${s}] ${c.a}: `);
      conti.righe++;
    });
    const set = [];
    const val = [];
    if (conti.righe) { val.push(encRec(linee.join('\n'))); set.push(`trascrizione = $${val.length}`); }

    if (collegati) {
      // 2. Recap cliente (testo e versione formattata) e sintesi del recap interno.
      const rc = sostituisciTesto(m.recap, coppie);
      if (rc.n) { conti.recap += rc.n; val.push(encRec(rc.testo)); set.push(`recap = $${val.length}`); }
      const rh = sostituisciHtml(m.recap_html, coppie);
      if (rh.n) { val.push(encRec(rh.testo)); set.push(`recap_html = $${val.length}`); if (!rc.n) conti.recap += rh.n; }
      const ri = sostituisciTesto(m.recap_interno, coppie);
      if (ri.n) { conti.recapInterno += ri.n; val.push(encRec(ri.testo)); set.push(`recap_interno = $${val.length}`); }
    }
    if (set.length) {
      await client.query(
        `UPDATE rec_meeting SET ${set.join(', ')}, crypto = 1 WHERE tenant_id = $${val.length + 1} AND user_id = $${val.length + 2} AND id_calendar = $${val.length + 3}`,
        [...val, user.tenant_id, user.user_id, idCalendar]
      );
    }

    if (collegati) {
      const colTasks = new Set((await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks'")).rows.map((x) => x.column_name));
      const aggiornaTask = async (id, dati) => {
        const d = Object.fromEntries(Object.entries(dati).filter(([k]) => colTasks.has(k)));
        if (!Object.keys(d).length) return;
        d.updated_at = new Date().toISOString();
        const { data } = await encryptRowForWrite(db, 'tasks', d, { id });
        const cols = Object.keys(data).filter((c) => colTasks.has(c));
        await client.query(
          `UPDATE tasks SET ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')} WHERE id::text = $${cols.length + 1} AND tenant_id = $${cols.length + 2}`,
          [...cols.map((c) => data[c]), id, user.tenant_id]
        );
        conti.todo++;
      };
      const taskFatti = new Set();

      // 3. Attività del recap interno: testo e owner; la To-Do collegata segue l'owner.
      try {
        const att = (await client.query(
          `SELECT id::text AS id, argomento, descrizione, owner_nominativo, task_id::text AS task_id FROM rec_meeting_attivita
            WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3`,
          [user.tenant_id, user.user_id, idCalendar]
        )).rows;
        for (const a of att) {
          const dati = {};
          const ar = sostituisciTesto(a.argomento, coppie);
          if (ar.n) dati.argomento = ar.testo;
          const de = sostituisciTesto(a.descrizione, coppie);
          if (de.n) dati.descrizione = de.testo;
          const owner = coppie.find((c) => norm(c.da) === norm(a.owner_nominativo));
          if (owner) Object.assign(dati, { owner_nominativo: owner.a, owner_email: owner.email, rubrica_id: owner.rubrica_id });
          if (!Object.keys(dati).length) continue;
          dati.updated_at = new Date().toISOString();
          const { data } = await encryptRowForWrite(db, 'rec_meeting_attivita', dati, { id: a.id });
          const cols = Object.keys(data);
          await client.query(
            `UPDATE rec_meeting_attivita SET ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')} WHERE id::text = $${cols.length + 1} AND tenant_id = $${cols.length + 2}`,
            [...cols.map((c) => data[c]), a.id, user.tenant_id]
          );
          conti.attivita++;
          if (!a.task_id) continue;
          const t = (await client.query('SELECT description FROM tasks WHERE id::text = $1 AND tenant_id = $2', [a.task_id, user.tenant_id])).rows[0];
          if (!t) continue;
          const td = {};
          const tx = sostituisciTesto(t.description, coppie);
          if (tx.n) td.description = tx.testo;
          if (owner) {
            if (owner.rubrica_id) { td.assigned_to = owner.rubrica_id; td.assigned_to_text = null; } else { td.assigned_to = null; td.assigned_to_text = owner.a.slice(0, 255); }
          }
          await aggiornaTask(a.task_id, td);
          taskFatti.add(a.task_id);
        }
      } catch (e) { if (e.code !== '42P01') throw e; }

      // 4. To-Do create dal recap cliente («<oggetto> - Azioni in carico», stessa data di inizio).
      if (m.data) {
        const titoli = [`${String(m.oggetto || 'Riunione').trim()} - Azioni in carico`, `${String(m.oggetto || 'Riunione').trim()} - Attività interne`]
          .map((x) => norm(x.slice(0, 200)));
        const tt = (await client.query(
          'SELECT id::text AS id, titile, description, assigned_to_text FROM tasks WHERE tenant_id = $1 AND user_id = $2 AND data_inizio = $3::date',
          [user.tenant_id, user.user_id, m.data.slice(0, 10)]
        )).rows.filter((t) => titoli.includes(norm(t.titile)) && !taskFatti.has(t.id));
        for (const t of tt) {
          const td = {};
          const tx = sostituisciTesto(t.description, coppie);
          if (tx.n) td.description = tx.testo;
          const owner = coppie.find((c) => norm(c.da) === norm(t.assigned_to_text));
          if (owner) {
            if (owner.rubrica_id) { td.assigned_to = owner.rubrica_id; td.assigned_to_text = null; } else td.assigned_to_text = owner.a.slice(0, 255);
          }
          if (Object.keys(td).length) await aggiornaTask(t.id, td);
        }
      }

      // 5. Azioni a carico del cliente lette da questo recap: referente e descrizione.
      try {
        const az = (await client.query(
          'SELECT id::text AS id, referente, descrizione FROM pm_azioni_cliente WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3',
          [user.tenant_id, user.user_id, idCalendar]
        )).rows;
        for (const a of az) {
          const dati = {};
          const ref = coppie.find((c) => norm(c.da) === norm(a.referente));
          if (ref) dati.referente = ref.a;
          else {
            const rr = sostituisciTesto(a.referente, coppie);
            if (rr.n) dati.referente = rr.testo;
          }
          const de = sostituisciTesto(a.descrizione, coppie);
          if (de.n) dati.descrizione = de.testo;
          if (!Object.keys(dati).length) continue;
          dati.updated_at = new Date().toISOString();
          const { data } = await encryptRowForWrite(db, 'pm_azioni_cliente', dati, { id: a.id });
          const cols = Object.keys(data);
          await client.query(
            `UPDATE pm_azioni_cliente SET ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')} WHERE id::text = $${cols.length + 1} AND tenant_id = $${cols.length + 2}`,
            [...cols.map((c) => data[c]), a.id, user.tenant_id]
          );
          conti.azioniCliente++;
        }
      } catch (e) { if (e.code !== '42P01') throw e; }
    }
    await client.query('COMMIT');
    console.log(`[PARLANTI] ${idCalendar}: rinominati ${coppie.length} (righe ${conti.righe}, recap ${conti.recap}, interno ${conti.recapInterno}, attività ${conti.attivita}, To-Do ${conti.todo}, azioni cliente ${conti.azioniCliente})`);
    return conti;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
