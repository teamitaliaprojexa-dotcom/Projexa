// Eventi da registrare nei log che avvengono nel browser, non sul server.
// Oggi: l'email del recap/trascrizione di una riunione, che Projexa prepara e apre nel
// programma di posta dell'utente (Gmail web o Outlook). Projexa non sa se poi viene
// inviata davvero: si registra che è stata aperta, con destinatari e oggetto.
// Tutti gli utenti autenticati; utente e tenant si prendono dalla sessione, mai dal corpo.
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { registraEmail } from '../config/audit.js';

const router = express.Router();
router.use(requireAuth);

// L'email «Attività a tuo carico» della To-Do List NON si registra: Projexa ne prepara solo il
// testo, l'invio lo fa l'utente.
const TIPI = new Set(['recap', 'trascrizione', 'recap_interno']);
const SERVIZI = new Set(['gmail_web', 'programma_posta']);

router.post('/email', (req, res) => {
  const b = req.body || {};
  if (!TIPI.has(b.tipo)) return res.status(400).json({ error: 'Tipo non valido' });
  registraEmail(req, {
    tipo: b.tipo,
    modalita: 'client',
    esito: 'ok',
    a: Array.isArray(b.a) ? b.a.slice(0, 100) : b.a,
    cc: Array.isArray(b.cc) ? b.cc.slice(0, 100) : b.cc,
    mittente: b.mittente || req.user.email || null,
    oggetto: b.oggetto,
    riferimento: b.riferimento,
    servizio: SERVIZI.has(b.servizio) ? b.servizio : null
  });
  res.status(204).end();
});

export default router;
