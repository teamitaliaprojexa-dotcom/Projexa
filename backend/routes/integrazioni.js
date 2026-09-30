// === AGGIORNAMENTO INTEGRAZIONI ===
//
// Endpoint del pulsante «Aggiorna Integrazioni» della pagina Jira. Non contiene
// logica: lancia i programmi di sincronizzazione tramite jobs/aggiornaIntegrazioni.js
// (lo stesso modulo usato dallo schedulatore, jobs/scheduler.js) e ne restituisce
// il report.
//
// PERIMETRO: il lancio vale per l'intero TENANT. Qualunque utente prema il
// pulsante, un solo passaggio aggiorna i dati di tutti gli utenti del tenant, con la
// configurazione Jira (mappatura + account) di chi preme o, se non ce l'ha, di un
// altro utente del tenant configurato.
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { PROGRAMMI, eseguiAggiornaIntegrazioni } from '../jobs/aggiornaIntegrazioni.js';

const router = express.Router();

// Elenco dei programmi disponibili (usato dalla UI per mostrare cosa verrà eseguito).
router.get('/programmi', requireAuth, (req, res) => {
  res.json({ programmi: PROGRAMMI.map(({ nome, etichetta }) => ({ nome, etichetta })) });
});

// Esegue tutti i programmi (o solo quelli indicati in body.programmi).
// Un programma che fallisce NON blocca gli altri: l'errore finisce nel suo report.
router.post('/aggiorna', requireAuth, async (req, res) => {
  const programmi = Array.isArray(req.body?.programmi) ? req.body.programmi : undefined;
  try {
    res.json(await eseguiAggiornaIntegrazioni(req.user.tenant_id, { programmi, utentePreferito: req.user.user_id }));
  } catch (error) {
    if (error.code === 'IN_CORSO') {
      return res.status(409).json({ error: 'Aggiornamento già in corso per questo tenant (lanciato da un altro utente o dalla schedulazione): riprova tra qualche minuto' });
    }
    if (error.code === 'NESSUN_PROGRAMMA') return res.status(400).json({ error: error.message });
    res.status(500).json({ error: error.message });
  }
});

export default router;
