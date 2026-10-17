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

// Limite per utente (2026-10-17): l'evento lo dichiara il browser, quindi senza limite si
// potevano riempire i log con righe inventate. 30 email aperte in 10 minuti sono già tante.
const FINESTRA_MS = 10 * 60 * 1000;
const MAX_EVENTI = 30;
const contatori = new Map();
function limitato(chiave) {
  const ora = Date.now();
  let c = contatori.get(chiave);
  if (!c || ora - c.inizio > FINESTRA_MS) { c = { inizio: ora, n: 0 }; contatori.set(chiave, c); }
  c.n += 1;
  if (contatori.size > 5000) for (const [k, v] of contatori) if (ora - v.inizio > FINESTRA_MS) contatori.delete(k);
  return c.n > MAX_EVENTI;
}
const corto = (v, max) => (v == null ? null : String(v).slice(0, max));
const elenco = (v) => (Array.isArray(v) ? v.slice(0, 50).map((x) => corto(x, 320)) : corto(v, 4000));

router.post('/email', (req, res) => {
  const b = req.body || {};
  if (!TIPI.has(b.tipo)) return res.status(400).json({ error: 'Tipo non valido' });
  if (limitato(`${req.user.tenant_id}|${req.user.user_id}`)) return res.status(429).json({ error: 'Troppe richieste' });
  registraEmail(req, {
    tipo: b.tipo,
    modalita: 'client',
    esito: 'ok',
    a: elenco(b.a),
    cc: elenco(b.cc),
    mittente: corto(b.mittente || req.user.email || null, 320),
    oggetto: corto(b.oggetto, 500),
    riferimento: corto(b.riferimento, 300),
    servizio: SERVIZI.has(b.servizio) ? b.servizio : null
  });
  res.status(204).end();
});

export default router;
