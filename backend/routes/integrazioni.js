// === AGGIORNAMENTO INTEGRAZIONI ===
//
// Endpoint del pulsante «Aggiorna Integrazioni» della dashboard. Non contiene
// logica: si limita a lanciare, uno dopo l'altro, i programmi di sincronizzazione
// che stanno in backend/jobs/ e a restituire il loro report.
//
// Ogni programma è un file a sé, richiamabile anche da riga di comando: per
// aggiungerne uno basta importarlo e metterlo nell'elenco PROGRAMMI.
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { aggiornaJiraQuotazioni, NOME_PROGRAMMA as NOME_QUOTAZIONI } from '../jobs/aggiornaJiraQuotazioni.js';
import { aggiornaJiraTask, NOME_PROGRAMMA as NOME_TASK } from '../jobs/aggiornaJiraTask.js';

const router = express.Router();

const PROGRAMMI = [
  { nome: NOME_QUOTAZIONI, etichetta: 'Quotazioni Jira', esegui: aggiornaJiraQuotazioni },
  { nome: NOME_TASK, etichetta: 'Task Jira', esegui: aggiornaJiraTask }
];

// Elenco dei programmi disponibili (usato dalla UI per mostrare cosa verrà eseguito).
router.get('/programmi', requireAuth, (req, res) => {
  res.json({ programmi: PROGRAMMI.map(({ nome, etichetta }) => ({ nome, etichetta })) });
});

// Esegue tutti i programmi (o solo quelli indicati in body.programmi).
// Un programma che fallisce NON blocca gli altri: l'errore finisce nel suo report.
router.post('/aggiorna', requireAuth, async (req, res) => {
  const richiesti = Array.isArray(req.body?.programmi) ? req.body.programmi : null;
  const daEseguire = richiesti
    ? PROGRAMMI.filter((p) => richiesti.includes(p.nome))
    : PROGRAMMI;

  if (daEseguire.length === 0) {
    return res.status(400).json({ error: 'Nessun programma da eseguire' });
  }

  const ctx = { tenantId: req.user.tenant_id, userId: req.user.user_id };
  const risultati = [];

  for (const programma of daEseguire) {
    const avvio = Date.now();
    try {
      const report = await programma.esegui(ctx);
      risultati.push({ ...report, etichetta: programma.etichetta, ok: true, durataMs: Date.now() - avvio });
    } catch (error) {
      console.error(`❌ ${programma.nome}:`, error.message);
      risultati.push({
        programma: programma.nome,
        etichetta: programma.etichetta,
        ok: false,
        errore: error.message,
        code: error.code || null,
        durataMs: Date.now() - avvio
      });
    }
  }

  res.json({ ok: risultati.every((r) => r.ok), risultati });
});

export default router;
