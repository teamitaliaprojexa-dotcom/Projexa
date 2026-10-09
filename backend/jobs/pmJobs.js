// ============================================================================
// JOB DEI PROGETTI (funzioni da PM senior, 2026-10-09) - schedulatore del server
// ----------------------------------------------------------------------------
//   pm_notifiche_progetti  (ogni mattina) per ogni PM con progetti aperti:
//     1. fotografia giornaliera di effort speso / completamento / semaforo (pm_snapshot), che
//        serve al ritmo di consumo e alla data prevista di esaurimento del budget;
//     2. notifiche proattive in campanella (fonte «progetto»), ciascuna UNA volta sola per
//        evento (chiave_dedup): budget all'80% e superato, stima a finire oltre il 110%,
//        data di fine superata, attività del Gantt in ritardo, milestone superata o raggiunta
//        (= si può fatturare), rischio da rivedere, progetto diventato rosso.
//        Chi non le vuole le spegne nel Portfolio (pm_preferenze.notifiche_prog).
//   pm_digest_settimanale  (lunedì) email di riepilogo ai PM che l'hanno attivata nel
//        Portfolio (pm_preferenze.digest): progetti in rosso/giallo, To-Do scadute e della
//        settimana, riunioni senza recap inviato, ordini da sollecitare, rischi, CR in attesa,
//        milestone delle prossime due settimane. Nessuna AI: testo composto da Projexa.
// ============================================================================
import db from '../config/database.js';
import authDb from '../config/authDatabase.js';
import notifDb from '../config/notifDatabase.js';
import { encryptValue } from '../config/crypto.js';
import { sendMail } from '../config/mailer.js';
import {
  saluteTuttiProgetti, tabellaPresente, oggiIso, dataIt, fmt, giorniTra
} from '../config/pmCore.js';

const cifra = (v) => (v == null ? v : encryptValue(String(v)));
const APP_URL = () => (process.env.APP_URL || process.env.BACKEND_URL || 'https://www.projexa.it').replace(/\/+$/, '');

// PM con almeno un progetto aperto (proprietari delle righe di progetto).
async function utentiConProgetti() {
  const r = await db.query(
    `SELECT DISTINCT p.tenant_id::text AS tenant_id, p.user_id::text AS user_id, ut.id_roles
       FROM projects p
       LEFT JOIN user_tenants ut ON ut.tenant_id = p.tenant_id AND ut.user_id = p.user_id
      WHERE p.argument = 'Progetto' AND p.campo = 'Progetto' AND p.scadenza >= CURRENT_DATE`
  );
  return r.rows;
}

async function preferenze(user) {
  if (!(await tabellaPresente('pm_preferenze'))) return { digest: false, notifiche_prog: true };
  const r = (await db.query('SELECT digest, notifiche_prog FROM pm_preferenze WHERE tenant_id = $1 AND user_id = $2', [user.tenant_id, user.user_id])).rows[0];
  return r || { digest: false, notifiche_prog: true };
}

// Notifica una sola volta per chiave: se esiste già (letta o no) non si ricrea.
async function notificaUnaVolta(user, projectId, chiave, titolo, messaggio) {
  const r = await notifDb.query(
    `INSERT INTO notifiche (tenant_id, user_id, fonte, titolo, messaggio, tabella, riga_id, chiave_dedup)
     VALUES ($1, $2, 'progetto', $3, $4, 'projects', $5, $6)
     ON CONFLICT (tenant_id, user_id, chiave_dedup) WHERE chiave_dedup IS NOT NULL DO NOTHING
     RETURNING id`,
    [user.tenant_id, user.user_id, cifra(titolo), cifra(messaggio), projectId, `progetto|${chiave}`]
  );
  return r.rowCount > 0;
}

export async function eseguiNotificheProgetti() {
  const report = { ok: true, utenti: 0, progetti: 0, fotografie: 0, notifiche: 0, errori: [] };
  const oggi = oggiIso();
  const conSnapshot = await tabellaPresente('pm_snapshot');
  for (const user of await utentiConProgetti()) {
    report.utenti += 1;
    try {
      const pref = await preferenze(user);
      const tutti = await saluteTuttiProgetti(user);
      for (const s of tutti) {
        if (s.errore) continue;
        report.progetti += 1;
        const pid = s.progetto.projectId;
        const nome = `${s.progetto.cliente ? `${s.progetto.cliente} · ` : ''}${s.progetto.nome}`;
        let ieri = null;
        if (conSnapshot) {
          ieri = (await db.query(
            `SELECT semaforo FROM pm_snapshot WHERE tenant_id = $1 AND user_id = $2 AND project_id = $3 AND giorno < $4::date
              ORDER BY giorno DESC LIMIT 1`, [user.tenant_id, user.user_id, pid, oggi])).rows[0] || null;
          await db.query(
            `INSERT INTO pm_snapshot (tenant_id, user_id, project_id, giorno, offerta, speso, completamento, semaforo)
             VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8)
             ON CONFLICT (tenant_id, user_id, project_id, giorno)
             DO UPDATE SET offerta = EXCLUDED.offerta, speso = EXCLUDED.speso, completamento = EXCLUDED.completamento, semaforo = EXCLUDED.semaforo`,
            [user.tenant_id, user.user_id, pid, oggi, s.eac.bac || 0, s.eac.ac || 0, s.eac.completamento, s.semaforo]
          );
          report.fotografie += 1;
        }
        if (!pref.notifiche_prog) continue;
        const e = s.eac;
        const u = e.unita;
        const avvisi = [];
        if (e.bac > 0 && e.ac > e.bac) avvisi.push(['budget100', 'Budget superato', `${nome}: speso ${fmt(e.ac)} ${u} su ${fmt(e.bac)} previsti`]);
        else if (e.bac > 0 && e.ac >= 0.8 * e.bac) avvisi.push(['budget80', 'Budget all\'80%', `${nome}: speso ${fmt(e.ac)} ${u} su ${fmt(e.bac)} (${fmt((e.ac / e.bac) * 100, 0)}%)`]);
        if (e.percPrevista != null && e.percPrevista > 110) avvisi.push([`eac110|${oggi.slice(0, 7)}`, 'Stima a finire oltre il budget', `${nome}: a finire previsto ${fmt(e.percPrevista, 0)}% del budget (${fmt(e.eac)} ${u} su ${fmt(e.bac)})`]);
        const end = s.scheda.end;
        if (end && end < oggi && (e.completamento == null || e.completamento < 100)) avvisi.push([`end|${end}`, 'Data di fine superata', `${nome}: la fine prevista era il ${dataIt(end)} e il progetto non è completato`]);
        for (const a of s.gantt.inRitardo.slice(0, 10)) avvisi.push([`ritardo|${a.id}|${a.fine}`, 'Attività in ritardo', `${nome}: «${a.nome}» doveva finire il ${dataIt(a.fine)} (avanzamento ${a.avanzamento}%)`]);
        for (const m of s.gantt.milestone) {
          if (m.scaduta) avvisi.push([`milestone|${m.id}|${m.data}`, 'Milestone non raggiunta', `${nome}: «${m.nome}» prevista il ${dataIt(m.data)}`]);
          if (m.raggiunta) avvisi.push([`milestone-ok|${m.id}`, 'Milestone raggiunta: puoi fatturare', `${nome}: «${m.nome}» completata. Controlla la fatturazione collegata.`]);
        }
        if (await tabellaPresente('pm_raid')) {
          const rv = await db.query(
            `SELECT id::text AS id, titolo, data_revisione::text AS d FROM pm_raid
              WHERE tenant_id = $1 AND user_id = $2 AND project_id = $3 AND tipo = 'rischio' AND stato <> 'chiuso'
                AND data_revisione <= CURRENT_DATE AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
            [user.tenant_id, user.user_id, pid]);
          for (const x of rv.rows) avvisi.push([`rischio|${x.id}|${x.d}`, 'Rischio da rivedere', `${nome}: «${x.titolo}» (revisione prevista il ${dataIt(x.d)})`]);
        }
        if (s.semaforo === 'rosso' && ieri && ieri.semaforo && ieri.semaforo !== 'rosso') {
          const motivi = s.indicatori.filter((i) => i.stato === 'rosso').map((i) => `${i.titolo}: ${i.nota}`).join(' · ');
          avvisi.push([`rosso|${oggi}`, 'Progetto diventato rosso', `${nome}: ${motivi}`]);
        }
        for (const [chiave, titolo, msg] of avvisi) {
          if (await notificaUnaVolta(user, pid, `${pid}|${chiave}`, titolo, msg)) report.notifiche += 1;
        }
      }
    } catch (err) {
      if (err.code === '42P01' && /notifiche/.test(err.message)) throw new Error('Tabelle delle notifiche assenti su projexa_notif: eseguire Supporto/CreaDB/notifiche.sql');
      report.errori.push(`${user.user_id}: ${err.message}`);
    }
  }
  if (report.errori.length) report.ok = report.errori.length < report.utenti;
  return report;
}

// ----------------------------------------------------------------------------
// DIGEST SETTIMANALE
// ----------------------------------------------------------------------------
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function nomeUtente(user) {
  const r = (await db.query("SELECT concat_ws(' ', name, cognome) AS n FROM users WHERE id = $1", [user.user_id])).rows[0];
  return r && r.n ? String(r.n).trim() : '';
}

// Contenuto del digest per un PM: { oggetto, html, text, sezioni }.
export async function costruisciDigest(user) {
  const oggi = oggiIso();
  const tutti = (await saluteTuttiProgetti(user)).filter((s) => !s.errore);
  const sez = [];
  const nomeP = (s) => `${s.progetto.cliente ? `${s.progetto.cliente} · ` : ''}${s.progetto.nome}`;
  const link = (s) => `${APP_URL()}/pm.html?projectId=${encodeURIComponent(s.progetto.projectId)}`;

  const rossi = tutti.filter((s) => s.semaforo === 'rosso');
  const gialli = tutti.filter((s) => s.semaforo === 'giallo');
  if (rossi.length || gialli.length) {
    sez.push({
      titolo: `Progetti da seguire (${rossi.length} rossi, ${gialli.length} gialli)`,
      righe: [...rossi, ...gialli].map((s) => ({
        testo: `${s.semaforo === 'rosso' ? '🔴' : '🟡'} ${nomeP(s)}: ${s.indicatori.filter((i) => i.stato === s.semaforo).map((i) => `${i.titolo} – ${i.nota}`).join(' · ')}`,
        link: link(s)
      }))
    });
  }
  const t = await db.query(
    `SELECT titile, due_date::text AS due FROM tasks
      WHERE tenant_id = $1 AND user_id = $2 AND COALESCE(status, 'todo') IN ('todo', 'in_progress')
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE) AND due_date <= CURRENT_DATE + 7
      ORDER BY due_date LIMIT 50`,
    [user.tenant_id, user.user_id]
  );
  if (t.rows.length) {
    sez.push({
      titolo: `To-Do scadute o in scadenza entro 7 giorni (${t.rows.length})`,
      righe: t.rows.map((x) => ({ testo: `${x.due < oggi ? '⚠️ scaduta' : '📅'} ${dataIt(x.due)} – ${x.titile || '(senza titolo)'}` }))
    });
  }
  const m = await db.query(
    `SELECT oggetto, data_calendar::text AS d FROM rec_meeting
      WHERE tenant_id = $1 AND user_id = $2 AND inviata IS NOT TRUE AND recap IS NOT NULL AND BTRIM(recap) <> ''
        AND data_calendar >= CURRENT_DATE - 21
      ORDER BY data_calendar DESC LIMIT 30`,
    [user.tenant_id, user.user_id]
  );
  if (m.rows.length) sez.push({ titolo: `Riunioni con recap non ancora inviato (${m.rows.length})`, righe: m.rows.map((x) => ({ testo: `${dataIt(x.d)} – ${x.oggetto || 'Riunione'}` })) });

  const ordini = tutti.filter((s) => (s.indicatori.find((i) => i.chiave === 'commerciale') || {}).stato === 'rosso'
    || /ordine non ancora arrivato/.test((s.indicatori.find((i) => i.chiave === 'commerciale') || {}).nota || ''));
  if (ordini.length) sez.push({ titolo: `Offerte e ordini da sollecitare (${ordini.length})`, righe: ordini.map((s) => ({ testo: `${nomeP(s)}: ${(s.indicatori.find((i) => i.chiave === 'commerciale') || {}).nota}`, link: link(s) })) });

  if (await tabellaPresente('pm_raid')) {
    const r = await db.query(
      `SELECT project_id::text AS p, titolo, probabilita * impatto AS punti, data_revisione::text AS rev FROM pm_raid
        WHERE tenant_id = $1 AND user_id = $2 AND tipo = 'rischio' AND stato <> 'chiuso' AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
          AND (probabilita * impatto >= 12 OR data_revisione <= CURRENT_DATE + 7)
        ORDER BY probabilita * impatto DESC NULLS LAST LIMIT 30`,
      [user.tenant_id, user.user_id]
    );
    const perId = new Map(tutti.map((s) => [s.progetto.projectId, s]));
    const righe = r.rows.filter((x) => perId.has(x.p)).map((x) => ({ testo: `${nomeP(perId.get(x.p))}: «${x.titolo}» punteggio ${x.punti ?? '-'}${x.rev ? `, revisione ${dataIt(x.rev)}` : ''}`, link: link(perId.get(x.p)) }));
    if (righe.length) sez.push({ titolo: `Rischi alti o da rivedere (${righe.length})`, righe });
  }
  const crAttesa = tutti.filter((s) => s.conteggi && s.conteggi.crAperte);
  if (crAttesa.length) sez.push({ titolo: 'Change Request in attesa di decisione', righe: crAttesa.map((s) => ({ testo: `${nomeP(s)}: ${s.conteggi.crAperte} in bozza o inviate`, link: link(s) })) });
  const ms = [];
  for (const s of tutti) for (const x of s.gantt.milestone) {
    if (!x.raggiunta && x.data && x.data >= oggi && giorniTra(oggi, x.data) <= 14) ms.push({ testo: `${dataIt(x.data)} – ${nomeP(s)}: «${x.nome}»`, link: link(s), d: x.data });
  }
  if (ms.length) sez.push({ titolo: `Milestone delle prossime 2 settimane (${ms.length})`, righe: ms.sort((a, b) => a.d.localeCompare(b.d)) });

  const verdi = tutti.filter((s) => s.semaforo === 'verde').length;
  const nome = await nomeUtente(user);
  const oggetto = `Projexa · il tuo riepilogo della settimana (${dataIt(oggi)})`;
  const intro = `${nome ? `Ciao ${nome.split(' ')[0]},` : 'Ciao,'} ecco la situazione dei tuoi ${tutti.length} progetti aperti: ${rossi.length} rossi, ${gialli.length} gialli, ${verdi} verdi.`;
  const text = [intro, '', ...sez.flatMap((s) => [s.titolo.toUpperCase(), ...s.righe.map((r) => `- ${r.testo}`), '']), `Portfolio: ${APP_URL()}/portfolio.html`].join('\n');
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1F2937;max-width:720px">
    <h2 style="color:#4F46E5;margin:0 0 8px">Il tuo riepilogo della settimana</h2>
    <p>${escHtml(intro)}</p>
    ${sez.length ? sez.map((s) => `<h3 style="font-size:15px;color:#312E81;margin:18px 0 6px">${escHtml(s.titolo)}</h3>
      <ul style="margin:0;padding-left:18px">${s.righe.map((r) => `<li style="margin:3px 0">${r.link ? `<a href="${escHtml(r.link)}" style="color:#1F2937">${escHtml(r.testo)}</a>` : escHtml(r.testo)}</li>`).join('')}</ul>`).join('')
      : '<p>Nessun punto di attenzione questa settimana. 👍</p>'}
    <p style="margin-top:22px"><a href="${escHtml(APP_URL())}/portfolio.html" style="background:#4F46E5;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:600">Apri il Portfolio</a></p>
    <p style="font-size:12px;color:#6B7280;margin-top:18px">Ricevi questa email perché hai attivato il digest settimanale nel Portfolio di Projexa. Puoi disattivarlo da lì.</p></div>`;
  return { oggetto, html, text, sezioni: sez.length };
}

export async function emailUtente(userId) {
  const r = (await authDb.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0];
  return r && r.email ? String(r.email).trim() : '';
}

export async function eseguiDigestSettimanale() {
  const report = { ok: true, inviati: 0, saltati: 0, errori: [] };
  if (!(await tabellaPresente('pm_preferenze'))) return { ...report, nota: 'Tabella pm_preferenze assente: eseguire Supporto/CreaDB/pm_senior.sql' };
  const r = await db.query('SELECT tenant_id::text AS tenant_id, user_id::text AS user_id FROM pm_preferenze WHERE digest');
  for (const u of r.rows) {
    try {
      const email = await emailUtente(u.user_id);
      if (!email) { report.saltati += 1; continue; }
      const d = await costruisciDigest(u);
      await sendMail({ to: email, subject: d.oggetto, html: d.html, text: d.text, log: { tipo: 'digest_settimanale', userId: u.user_id, tenantId: u.tenant_id } });
      report.inviati += 1;
    } catch (e) {
      report.errori.push(`${u.user_id}: ${e.message}`);
    }
  }
  if (report.errori.length && !report.inviati) report.ok = false;
  return report;
}
