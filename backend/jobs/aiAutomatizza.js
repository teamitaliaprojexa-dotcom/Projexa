// ============================================================================
// «AI AUTOMATIZZA (SOLO BATCH)» - Impostazioni › AI (2026-10-12)
// ----------------------------------------------------------------------------
// Campo di settings «AI Automatizza (solo Batch)»: interruttore (valore1) + elenco a scelta
// multipla (valore2: «Recap», «Recap Interno», «RAID», «Change Request», separati da ";" o ",").
// Con l'interruttore acceso, A FINE TRASCRIZIONE di una riunione (jobs/meetingTranscription.js,
// processFinalize) e DOPO IL CARICAMENTO MANUALE di una trascrizione da file .txt/.vtt
// (routes/calendar.js, PUT /meetings/managed/text; il file audio passa da processFinalize)
// le funzioni scelte partono da sole in modalità Batch (costo dimezzato) con
// l'AI di «AI generazione e-mail recap». Vale SOLO per questo lancio automatico: i campi
// «Esecuzione ...» («Chiedi sempre», «Immediato») restano validi quando la funzione si esegue a
// mano dal suo pulsante.
//   - Recap           -> recap per il cliente (rec_meeting_batch, raccolto da jobs/recapBatch.js);
//   - Recap Interno   -> scheda Recap interno (rec_meeting_batch tipo 'recap_interno');
//   - RAID            -> proposte di rischi, decisioni, dipendenze (e Change Request) dalla
//                        riunione: lavoro AI 'pm_raid' (jobs/aiLavori.js, «Risultati AI»);
//   - Change Request  -> solo Change Request: lavoro 'pm_cr'. Con RAID scelto non serve: la
//                        stessa estrazione RAID propone anche le Change Request (una sola spesa).
// RAID e Change Request partono SOLO se la riunione ha un progetto associato (tendine della
// riga); senza progetto non si fa nulla per loro e partono solo i recap.
// Se l'AI non ha il Batch (Projexa) o il fornitore rifiuta la richiesta Batch (es. Gemini
// gratuito) quella funzione si esegue in Immediato, SOLO in questo caso.
// Notifiche: un riepilogo del lancio + quelle di sempre a lavoro finito (recap pronto, recap
// interno pronto, risultato AI pronto); in caso di errore dell'esecuzione immediata, un avviso.
// ============================================================================
import db from '../config/database.js';
import { localRecapMode, aiCollegate, PROVIDERS } from '../routes/ai.js';
import { recapAiImpostata, isChiediSempre, generateRecap, segnaRecapAutomatico, ORIGINE_AUTOMATIZZA } from './meetingTranscription.js';
import { notificaAutomazioneAi } from './notifiche.js';

const CAMPO = 'ai automatizza (solo batch)';

// Voci dell'elenco -> chiave della funzione (confronto senza maiuscole e spazi doppi).
const VOCI = {
  'recap': 'recap',
  'recap cliente': 'recap',
  'recap interno': 'recap_interno',
  'raid': 'raid',
  'rischi e decisioni': 'raid',
  'change request': 'cr',
  'cr': 'cr'
};
const ETICHETTE = { recap: 'Recap', recap_interno: 'Recap Interno', raid: 'RAID', cr: 'Change Request' };
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const vero = (v) => v === true || v === 'true' || v === 't' || v === 1 || v === '1';

// Impostazione dell'utente: { attiva, funzioni: Set('recap' | 'recap_interno' | 'raid' | 'cr') }.
export async function leggiAutomazione(user) {
  const r = (await db.query(
    `SELECT valore1, valore2 FROM settings
      WHERE tenant_id = $1 AND user_id = $2
        AND lower(btrim(campo)) IN ($3, '(*) ' || $3)
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY id LIMIT 1`,
    [user.tenant_id, user.user_id, CAMPO]
  )).rows[0];
  const funzioni = new Set();
  if (!r || !vero(r.valore1)) return { attiva: false, funzioni };
  for (const v of String(r.valore2 || '').split(/[;,]/)) {
    const k = VOCI[norm(v)];
    if (k) funzioni.add(k);
  }
  return { attiva: funzioni.size > 0, funzioni };
}

const etichettaAi = (nome) => (PROVIDERS[String(nome || '').toLowerCase()] || {}).label || nome;

// Avvia le funzioni scelte per la riunione. Non lancia mai errori (si registrano e si notificano).
// Restituisce true se si è occupata del recap per il cliente (il recap normale non deve partire).
export async function avviaAutomazioneAi(user, idCalendar) {
  let conf;
  try {
    conf = await leggiAutomazione(user);
  } catch (e) {
    console.error(`❌ [AI AUTOMATIZZA] ${idCalendar}: impostazione non letta: ${e.message}`);
    return false;
  }
  if (!conf.attiva) return false;
  const f = conf.funzioni;
  const gestisceRecap = f.has('recap');
  const righe = [];
  const daEseguireSubito = []; // { nome, avvia }

  // AI: quella di «AI generazione e-mail recap»; con «Chiedi sempre» la prima AI collegata.
  let ai = await recapAiImpostata(user).catch(() => '');
  if (isChiediSempre(ai)) ai = ((await aiCollegate(user.user_id).catch(() => []))[0] || {}).nome || '';
  if (!ai) {
    await notificaAutomazioneAi({
      tenantId: user.tenant_id, userId: user.user_id, idCalendar, titolo: 'AI Automatizza non avviata',
      righe: ['Imposta l\'AI in Impostazioni › AI › «AI generazione e-mail recap» (o collega un\'AI con chiave API).']
    });
    // Senza AI nemmeno il recap normale potrebbe partire: lo si lascia comunque alla logica di sempre.
    return false;
  }
  const locale = localRecapMode(ai) === 'server';
  const labelAi = locale ? 'Projexa' : etichettaAi(ai);
  console.log(`[AI AUTOMATIZZA] ${idCalendar}: ${[...f].map((k) => ETICHETTE[k]).join(', ')} con ${labelAi}`);

  // 1) Recap per il cliente
  if (f.has('recap')) {
    const immediato = (motivo) => {
      righe.push(`Recap: Immediato (${motivo})`);
      // Pulsante Recap arancione dalla prenotazione fino alla fine (pronto o errore).
      segnaRecapAutomatico(user, idCalendar, true);
      daEseguireSubito.push({
        nome: 'Recap',
        avvia: () => generateRecap(user, idCalendar, { origine: ORIGINE_AUTOMATIZZA, ai }),
        fine: () => segnaRecapAutomatico(user, idCalendar, false)
      });
    };
    if (locale) immediato('Projexa non ha la modalità Batch');
    else {
      try {
        const { inviaRecapBatch } = await import('./recapBatch.js');
        await inviaRecapBatch(user, idCalendar, ai, { origine: ORIGINE_AUTOMATIZZA });
        righe.push(`Recap: Batch con ${labelAi}`);
      } catch (e) {
        // La trascrizione c'è (processFinalize lo verifica prima): ogni errore qui viene dal
        // fornitore o dal Batch. Solo la chiave scollegata non si recupera in Immediato.
        if (e.status === 428) righe.push(`Recap: non avviato (${e.message})`);
        else immediato(`Batch non riuscito: ${e.message}`);
      }
    }
  }

  // 2) Recap interno
  if (f.has('recap_interno')) {
    try {
      const { avviaRecapInternoAutomatico } = await import('../routes/recapInterno.js');
      const esito = await avviaRecapInternoAutomatico(user, idCalendar, ai);
      if (esito.modo === 'batch') righe.push(`Recap Interno: Batch con ${labelAi}`);
      else {
        righe.push(`Recap Interno: Immediato (${esito.motivo})`);
        daEseguireSubito.push({ nome: 'Recap Interno', avvia: esito.avvia });
      }
    } catch (e) {
      righe.push(`Recap Interno: non avviato (${e.message})`);
    }
  }

  // 3) RAID e/o Change Request: proposte in «Risultati AI» (lavoro AI in Batch). Con RAID
  //    scelto basta quello: la sua estrazione propone anche le Change Request.
  //    SOLO se la riunione ha un progetto associato: altrimenti non si fa nulla (nemmeno una
  //    riga nel riepilogo) e partono solo i recap.
  const operazione = f.has('raid') ? 'pm_raid' : (f.has('cr') ? 'pm_cr' : null);
  const m = operazione ? (await db.query(
    `SELECT project_id::text AS project_id, oggetto FROM rec_meeting WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = $3 LIMIT 1`,
    [user.tenant_id, user.user_id, idCalendar]
  ).catch(() => ({ rows: [] }))).rows[0] : null;
  if (operazione && m && m.project_id) {
    const nome = operazione === 'pm_raid' ? (f.has('cr') ? 'RAID e Change Request' : 'RAID') : 'Change Request';
    try {
      // Projexa non sa dare risposte strutturate: si usa la prima AI con chiave collegata.
      let aiPm = { nome: ai, label: labelAi };
      if (locale) {
        const c = (await aiCollegate(user.user_id))[0];
        if (!c) throw new Error('serve un\'AI con chiave API (ChatGPT, Claude, Gemini o Mistral): Projexa non può farlo');
        aiPm = { nome: c.nome, label: c.label };
      }
      const { creaLavoroAutomatico } = await import('./aiLavori.js');
      await creaLavoroAutomatico(user, operazione, {
        path: operazione === 'pm_raid' ? '/api/pm/raid/estrai' : '/api/pm/cr/estrai',
        body: { id_calendar: idCalendar, projectId: m.project_id },
        ai: aiPm,
        titolo: m.oggetto || ''
      });
      righe.push(`${nome}: Batch con ${aiPm.label} (proposte in «Risultati AI»; se il Batch non è disponibile parte in Immediato)`);
    } catch (e) {
      righe.push(`${nome}: non avviato (${e.message})`);
    }
  }

  // Niente partito (es. scelti solo RAID/Change Request su una riunione senza progetto): nessuna notifica.
  if (righe.length) {
    await notificaAutomazioneAi({
      tenantId: user.tenant_id, userId: user.user_id, idCalendar, titolo: 'AI Automatizza avviata', righe
    });
  }

  // Ripieghi in Immediato: in background, uno alla volta; a lavoro finito arrivano le notifiche
  // di sempre (recap pronto, recap interno pronto); in caso di errore un avviso.
  if (daEseguireSubito.length) {
    (async () => {
      for (const x of daEseguireSubito) {
        try {
          await x.avvia();
        } catch (e) {
          console.error(`❌ [AI AUTOMATIZZA] ${idCalendar}: ${x.nome} non generato: ${e.message}`);
          await notificaAutomazioneAi({
            tenantId: user.tenant_id, userId: user.user_id, idCalendar, titolo: `AI Automatizza: ${x.nome} non generato`,
            righe: [String(e.message || e)]
          }).catch(() => {});
        } finally {
          if (x.fine) x.fine();
        }
      }
    })();
  }
  return gestisceRecap;
}
