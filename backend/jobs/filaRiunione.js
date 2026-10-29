// ============================================================================
// FILA DEI LAVORI DI UNA RIUNIONE CHE SOPRAVVIVE AI RIAVVII (2026-10-23)
// ----------------------------------------------------------------------------
// «AI Automatizza» con il Batch rifiutato dal fornitore e il pulsante «Genera» del Recap
// interno eseguivano i lavori solo nella memoria del server: un riavvio (deploy) li perdeva.
// Il 2026-10-22 tre deploy in serata hanno lasciato due Recap interni «in corso» per sempre e
// i RAID / Change Request mai partiti.
// Ora i passi da fare si scrivono su disco, un file per fila:
//   AI_TEMP_DIR/fila-riunioni/<id>.json = { user, idCalendar, ai, passi, riprese, creato }
// (fuori da backend/, che il deploy sincronizza con --delete). Un passo si toglie dal file solo
// quando è concluso (bene o male); all'avvio del server le file rimaste ripartono dal passo
// interrotto, una fila alla volta (sono lavori lunghi sulla stessa VM). Niente tabelle nuove:
// ogni server riprende solo le sue file (il backend locale ha la sua cartella).
// Passi (in ordine):
//   { tipo: 'recap', nome }                                recap per il cliente
//   { tipo: 'recap_interno', nome }                        recap interno (Immediato)
//   { tipo: 'lavoro', nome, operazione, path, body, titolo }  RAID / Change Request: crea il
//        lavoro AI (jobs/aiLavori.js), che da lì in poi ha la sua ripresa (tabella ai_lavori).
// notifica: true = in caso di errore avviso in campanella («AI Automatizza: X non generato»).
// Una fila riprende al massimo MAX_RIPRESE volte (un passo che fa cadere il server non deve
// girare all'infinito); le file più vecchie di MAX_GIORNI giorni si scartano.
// ============================================================================
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { AI_TEMP_DIR, creaLavoroAutomatico } from './aiLavori.js';
import { notificaAutomazioneAi } from './notifiche.js';

const DIR = path.join(AI_TEMP_DIR, 'fila-riunioni');
const MAX_RIPRESE = 3;
const MAX_GIORNI = 3;

// File in memoria (in esecuzione o in attesa della ripresa): nome file -> fila.
const attive = new Map();
const fileDi = (nome) => path.join(DIR, nome);

async function scrivi(nome, fila) {
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(fileDi(nome), JSON.stringify(fila), 'utf8');
  } catch (e) {
    // Senza disco la fila gira lo stesso, come prima: si perde solo la ripresa.
    console.warn(`[FILA RIUNIONE] ${fila.idCalendar}: fila non salvata su disco (${e.message})`);
  }
}

// File in corso o in attesa su questo server (aggiornamenti automatici della VM: niente riavvio).
export const fileRiunioniAttive = () => attive.size;

// true se per la riunione c'è un passo di quel tipo ancora da fare (o in corso) in una fila:
// la scheda Recap interno non lo mostra «interrotto» e «Genera» non lo raddoppia.
export function inFila(user, idCalendar, tipo) {
  for (const f of attive.values()) {
    if (f.user.tenant_id === user.tenant_id && f.user.user_id === user.user_id && f.idCalendar === idCalendar
      && f.passi.some((p) => p.tipo === tipo)) return true;
  }
  return false;
}

async function eseguiPasso(fila, passo) {
  const { user, idCalendar, ai } = fila;
  if (passo.tipo === 'recap') {
    // Import dinamici: meetingTranscription.js e recapInterno.js importano a loro volta questo file.
    const { generateRecap, segnaRecapAutomatico, ORIGINE_AUTOMATIZZA } = await import('./meetingTranscription.js');
    // Pulsante Recap arancione dalla prenotazione fino alla fine (pronto o errore).
    segnaRecapAutomatico(user, idCalendar, true);
    try {
      await generateRecap(user, idCalendar, { origine: passo.origine || ORIGINE_AUTOMATIZZA, ai: ai.nome });
    } finally {
      segnaRecapAutomatico(user, idCalendar, false);
    }
  } else if (passo.tipo === 'recap_interno') {
    const { recapInternoImmediato } = await import('../routes/recapInterno.js');
    await recapInternoImmediato(user, idCalendar, ai.nome);
  } else if (passo.tipo === 'lavoro') {
    await creaLavoroAutomatico(user, passo.operazione, { path: passo.path, body: passo.body, ai, titolo: passo.titolo || '' });
  } else {
    throw new Error(`passo sconosciuto: ${passo.tipo}`);
  }
}

async function esegui(nome, fila) {
  try {
    while (fila.passi.length) {
      const passo = fila.passi[0];
      try {
        await eseguiPasso(fila, passo);
      } catch (e) {
        console.error(`❌ [FILA RIUNIONE] ${fila.idCalendar}: ${passo.nome} non generato: ${e.message}`);
        if (passo.notifica) {
          await notificaAutomazioneAi({
            tenantId: fila.user.tenant_id, userId: fila.user.user_id, idCalendar: fila.idCalendar,
            titolo: `AI Automatizza: ${passo.nome} non generato`, righe: [String(e.message || e)]
          }).catch(() => {});
        }
      }
      fila.passi.shift();
      if (fila.passi.length) await scrivi(nome, fila);
    }
  } finally {
    attive.delete(nome);
    if (!fila.passi.length) await fs.rm(fileDi(nome), { force: true }).catch(() => {});
  }
}

// Nuova fila: si salva e parte subito (in background). Restituisce subito.
//   user = { tenant_id, user_id, email, id_roles }, ai = { nome, label }
export async function accodaRiunione(user, idCalendar, ai, passi) {
  if (!passi.length) return;
  const nome = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.json`;
  const fila = {
    user: { tenant_id: user.tenant_id, user_id: user.user_id, email: user.email || null, id_roles: user.id_roles ?? null },
    idCalendar, ai: { nome: ai.nome, label: ai.label || ai.nome }, passi: [...passi], riprese: 0, creato: Date.now()
  };
  attive.set(nome, fila);
  await scrivi(nome, fila);
  esegui(nome, fila).catch((e) => console.error(`❌ [FILA RIUNIONE] ${idCalendar}:`, e.message));
}

// All'avvio del server: riprende le file rimaste su disco, una alla volta.
export async function riprendiFileRiunioni() {
  let nomi;
  try { nomi = (await fs.readdir(DIR)).filter((n) => n.endsWith('.json')).sort(); } catch { return; }
  const daFare = [];
  for (const nome of nomi) {
    let fila;
    try { fila = JSON.parse(await fs.readFile(fileDi(nome), 'utf8')); } catch { fila = null; }
    const scaduta = !fila || !Array.isArray(fila.passi) || !fila.passi.length || Date.now() - Number(fila.creato || 0) > MAX_GIORNI * 86400000;
    if (scaduta || Number(fila.riprese || 0) >= MAX_RIPRESE) {
      if (fila && fila.passi && fila.passi.length) {
        console.warn(`[FILA RIUNIONE] ${fila.idCalendar}: ${fila.passi.map((p) => p.nome).join(', ')} non ripresi (${scaduta ? 'troppo vecchi' : `già ripresi ${MAX_RIPRESE} volte`})`);
        if (fila.passi.some((p) => p.notifica)) {
          await notificaAutomazioneAi({
            tenantId: fila.user.tenant_id, userId: fila.user.user_id, idCalendar: fila.idCalendar,
            titolo: 'AI Automatizza: lavori interrotti', righe: [`Non ripresi dopo il riavvio del server: ${fila.passi.map((p) => p.nome).join(', ')}. Avviali dai loro pulsanti.`]
          }).catch(() => {});
        }
      }
      await fs.rm(fileDi(nome), { force: true }).catch(() => {});
      continue;
    }
    fila.riprese = Number(fila.riprese || 0) + 1;
    await scrivi(nome, fila);
    attive.set(nome, fila);
    daFare.push([nome, fila]);
  }
  if (!daFare.length) return;
  console.log(`[FILA RIUNIONE] Riprendo ${daFare.length} fil${daFare.length === 1 ? 'a' : 'e'} di lavori interrotti dal riavvio`);
  (async () => {
    for (const [nome, fila] of daFare) {
      console.log(`[FILA RIUNIONE] ${fila.idCalendar}: riprendo ${fila.passi.map((p) => p.nome).join(', ')} (ripresa ${fila.riprese})`);
      await esegui(nome, fila).catch((e) => console.error(`❌ [FILA RIUNIONE] ${fila.idCalendar}:`, e.message));
    }
  })();
}
