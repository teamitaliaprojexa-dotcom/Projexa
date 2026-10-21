// ============================================================================
// LAVORI DI «PROJEXA» IN CORSO SULLA VM (2026-10-21)
// ----------------------------------------------------------------------------
// Recap cliente, recap interno e lavori AI in background con il modello locale girano dentro il
// backend (non sono righe di una coda): qui si annotano mentre lavorano, per la pagina Monitor
// (routes/vm-monitor.js, «Lavori di Projexa in corso») e per la barra di avanzamento della
// finestra Recap (routes/recapInterno.js, GET /avanzamento). Solo in memoria: un riavvio li
// perde, come perde i lavori stessi. Leggerli non costa nulla alla VM.
// Modulo senza dipendenze: lo usano routes/ai.js e jobs/aiLavori.js.
// ============================================================================

const lavori = new Map();
let seq = 0;
let attesa = ''; // motivo per cui Projexa aspetta la VM (config/ollamaPrecedenza.js), '' = lavora

// info = { cosa, titolo, modello, chiave?, tipo? } (chiave = «tenant|utente|id_calendar» della
// riunione, tipo = 'recap' | 'interno'). Restituisce { fase(testo, fatti, totale), fine() }:
// fatti/totale = passi finiti e passi in tutto, per la percentuale.
export function iniziaLavoro(info) {
  const id = ++seq;
  lavori.set(id, { ...info, dal: new Date().toISOString(), fase: '', fatti: 0, totale: 0 });
  return {
    fase: (testo, fatti = 0, totale = 0) => {
      const l = lavori.get(id);
      if (l) Object.assign(l, { fase: String(testo || ''), fatti, totale });
    },
    fine: () => lavori.delete(id)
  };
}

export const segnaAttesaProjexa = (motivo) => { attesa = String(motivo || ''); };

const pubblico = (l) => {
  const { chiave, ...resto } = l;
  return { ...resto, percento: l.totale ? Math.min(99, Math.round(100 * l.fatti / l.totale)) : null, inAttesa: attesa };
};

export const lavoriProjexaInCorso = () => [...lavori.values()].map(pubblico);

// Lavori di una riunione (finestra Recap).
export const avanzamentoRiunione = (chiave) => [...lavori.values()].filter((l) => l.chiave === chiave).map(pubblico);
