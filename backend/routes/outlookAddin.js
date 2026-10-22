// ============================================================================
// ADD-IN DI OUTLOOK «ANALIZZA CON PROJEXA» (2026-10-22)
// ----------------------------------------------------------------------------
// Add-in nativo (manifest XML + pagine in sito/outlook/) che lavora SOLO sull'email aperta e
// SOLO quando il PM preme il pulsante: permesso «ReadItem», nessuna lettura della casella e
// nessuna approvazione dell'amministratore Microsoft 365.
// Flusso: pulsante in Outlook -> il pannello manda mittente, destinatari, oggetto e testo a
// POST /api/outlook/analizza -> lavoro AI in coda (jobs/aiLavori.js, operazione
// «outlook_analisi»: Immediato o Batch, più richieste insieme, ripresa dopo un riavvio) ->
// il pannello legge il risultato con GET /api/outlook/lavori/:id.
// L'analisi: dal mittente (o dai destinatari) ricava tenant e cliente tra quelli che l'utente
// vede; raccoglie i dati di QUEL cliente e progetto (progetto, Issue, ticket MySupport e Jira,
// quotazioni, release); l'AI scelta in «AI Add-in Outlook» classifica l'email, risponde sui
// ticket e scrive la bozza di risposta; le segnalazioni di errori nuove diventano Issue (con
// controllo dei doppioni) e arriva la notifica in campanella.
//
// SICUREZZA
//  - L'add-in non ha il cookie di sessione: usa un TOKEN dedicato (prefisso pxol_) ottenuto
//    collegando Outlook con un CODICE monouso (10 minuti) generato in Impostazioni › Profilo.
//    Sul database solo l'impronta SHA-256 (api_token, scopo «outlook_addin»), uno per utente.
//  - Il token è legato a: utente e tenant (ancora membro), casella di Outlook collegata
//    (header X-Projexa-Mailbox), password attuale (cambiandola il token decade), interruttore
//    «AI Add-in Outlook» acceso, scadenza 180 giorni. Revocabile da Profilo.
//  - Utente e tenant vengono SOLO dal token: il pannello non li manda mai. Ogni lavoro si legge
//    solo con il token del suo utente (stesso tenant e user_id): una risposta non può finire
//    nell'Outlook di un altro.
//  - Il testo dell'email è un dato non fidato: nel prompt sta tra delimitatori, l'AI vede solo
//    i dati di quel cliente e l'unica azione che può innescare è creare al massimo 3 Issue
//    (validate e senza doppioni). La bozza di risposta non parte mai da sola: la apre Outlook.
//  - Verso le AI esterne tutto passa dall'Anonymization Layer (config/pii.js, askAiProvider).
//  - Limiti: analisi in corso per utente e per tenant, analisi all'ora, tentativi di codice.
//  - Il testo dell'email si toglie dal lavoro appena concluso (cancellaInput); il risultato
//    resta cifrato 7 giorni come gli altri lavori AI.
// ============================================================================
import express from 'express';
import crypto from 'crypto';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import { currentSignature, currentMembership } from '../config/session.js';
import { contestoDaRichiesta } from '../config/auditContext.js';
import { encryptRowForWrite } from '../config/crypto.js';
import { getPromptFor } from '../config/prompts.js';
import { rottaAi } from '../jobs/aiLavori.js';
import { notificaOutlook } from '../jobs/notifiche.js';
import { chiediAi, leggiJson, contestoProgetto, progettiAperti, dataIt, oggiIso } from '../config/pmCore.js';

const router = express.Router();

const SCOPO = 'outlook_addin';
const PREFISSO = 'pxol_';
const CAMPO = 'ai add-in outlook';
const OPERAZIONE = 'outlook_analisi';
const TOKEN_GIORNI = 180;
const CODICE_MS = 10 * 60 * 1000;
const CODICE_ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // niente 0/O, 1/I
const MAX_TESTO = 60000;           // caratteri del corpo dell'email inviati all'analisi
const MAX_INDIRIZZI = 60;
const MAX_IN_CORSO_UTENTE = 5;
const MAX_IN_CORSO_TENANT = 40;
const MAX_ORA_UTENTE = 60;
const MAX_ISSUE_PER_EMAIL = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>"']{1,128}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i;

const errore = (status, message, code) => Object.assign(new Error(message), { status, code });
const impronta = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const pulisci = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const minuscola = (s) => String(s || '').trim().toLowerCase();
const dominio = (e) => minuscola(e).split('@')[1] || '';

function invia(res, e, cosa) {
  if (!e.status || e.status >= 500) console.error(`❌ [OUTLOOK] ${cosa}:`, e.message);
  const interno = !e.status || e.status >= 500;
  res.status(e.status || 500).json({ error: interno ? 'Errore interno: riprova tra poco' : e.message, code: interno ? undefined : e.code });
}

// Nessuna risposta dell'add-in va in cache (né nel browser né nei proxy).
router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// ----------------------------------------------------------------------------
// IMPOSTAZIONE «AI Add-in Outlook» (tipo 23: valore1 = attivo, valore2 = AI)
// ----------------------------------------------------------------------------
async function impostazione(user) {
  const r = (await db.query(
    `SELECT valore1, valore2 FROM settings
      WHERE tenant_id = $1 AND user_id = $2
        AND lower(btrim(regexp_replace(campo, '^\\(\\*\\)\\s*', ''))) = $3
        AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)
      ORDER BY id LIMIT 1`,
    [user.tenant_id, user.user_id, CAMPO])).rows[0];
  const attivo = !!r && (r.valore1 === true || r.valore1 === 't' || r.valore1 === 'true');
  return { attivo, ai: r && r.valore2 ? String(r.valore2).trim() : '' };
}

// ----------------------------------------------------------------------------
// LIMITI IN MEMORIA (un solo processo Node)
// ----------------------------------------------------------------------------
const finestre = new Map(); // chiave -> { inizio, n }
function oltreLimite(chiave, max, finestraMs) {
  const ora = Date.now();
  let c = finestre.get(chiave);
  if (!c || ora - c.inizio > finestraMs) { c = { inizio: ora, n: 0 }; finestre.set(chiave, c); }
  c.n += 1;
  if (finestre.size > 20000) for (const [k, v] of finestre) if (ora - v.inizio > 3600000) finestre.delete(k);
  return c.n > max;
}
const ipDi = (req) => String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim();

// ----------------------------------------------------------------------------
// CODICI DI COLLEGAMENTO (monouso, 10 minuti, solo impronta in memoria)
// ----------------------------------------------------------------------------
const codici = new Map(); // impronta del codice -> { tenant_id, user_id, email, scade }
function nuovoCodice() {
  const b = crypto.randomBytes(8);
  let c = '';
  for (let i = 0; i < 8; i++) c += CODICE_ALFABETO[b[i] % CODICE_ALFABETO.length];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
const normCodice = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
setInterval(() => { const ora = Date.now(); for (const [k, v] of codici) if (v.scade < ora) codici.delete(k); }, 60000).unref();

// ----------------------------------------------------------------------------
// AUTENTICAZIONE DELL'ADD-IN (Authorization: Bearer pxol_… + X-Projexa-Mailbox)
// ----------------------------------------------------------------------------
async function requireAddin(req, res, next) {
  try {
    const m = /^Bearer\s+(pxol_[A-Za-z0-9_-]{30,80})$/.exec(String(req.headers.authorization || ''));
    if (!m) return res.status(401).json({ error: 'Outlook non collegato a Projexa', code: 'NON_COLLEGATO' });
    if (oltreLimite(`tok|${ipDi(req)}`, 600, 10 * 60000)) return res.status(429).json({ error: 'Troppe richieste: riprova tra qualche minuto' });
    const t = (await db.query(
      `SELECT id, tenant_id::text AS tenant_id, user_id::text AS user_id, creato_il, ultimo_uso, ultimo_report
         FROM api_token WHERE token_hash = $1 AND scopo = $2`,
      [impronta(m[1]), SCOPO])).rows[0];
    if (!t) return res.status(401).json({ error: 'Collegamento non valido o revocato: ricollega Outlook da Projexa › Impostazioni › Profilo', code: 'NON_COLLEGATO' });
    const info = t.ultimo_report || {};
    if (new Date(t.creato_il).getTime() < Date.now() - TOKEN_GIORNI * 86400000) {
      return res.status(401).json({ error: 'Collegamento scaduto: ricollega Outlook da Projexa › Impostazioni › Profilo', code: 'NON_COLLEGATO' });
    }
    // La casella da cui arriva la richiesta deve essere quella collegata.
    const mailbox = minuscola(req.headers['x-projexa-mailbox']);
    if (!mailbox || mailbox !== minuscola(info.mailbox)) {
      return res.status(401).json({ error: 'Questa casella di Outlook non è quella collegata a Projexa', code: 'NON_COLLEGATO' });
    }
    const [mem, sig] = await Promise.all([currentMembership(t.user_id, t.tenant_id), currentSignature(t.user_id)]);
    if (!mem) return res.status(401).json({ error: 'Non hai più accesso a questo spazio di lavoro', code: 'NON_COLLEGATO' });
    if (Number(mem.id_roles) === 1 && !mem.projexa_admin) return res.status(401).json({ error: 'Ruolo non valido', code: 'NON_COLLEGATO' });
    // Password cambiata dopo il collegamento: il token decade come le sessioni.
    if (!sig || sig !== info.psig) return res.status(401).json({ error: 'Password cambiata: ricollega Outlook da Projexa › Impostazioni › Profilo', code: 'NON_COLLEGATO' });
    req.user = {
      user_id: t.user_id, tenant_id: t.tenant_id, email: info.email || '', id_roles: mem.id_roles, role_id: mem.role_id,
      role_name: mem.role_name, tenant_name: mem.tenant_name, typ: SCOPO
    };
    req.addinTokenId = t.id;
    if (!t.ultimo_uso || Date.now() - new Date(t.ultimo_uso).getTime() > 60000) {
      db.query('UPDATE api_token SET ultimo_uso = now() WHERE id = $1', [t.id]).catch(() => {});
    }
    contestoDaRichiesta(req, next);
  } catch (e) {
    invia(res, e, 'AUTENTICAZIONE');
  }
}

// ----------------------------------------------------------------------------
// ROTTE DI PROJEXA (sessione normale): stato, codice, scollega, manifest
// ----------------------------------------------------------------------------
router.get('/stato', requireAuth, async (req, res) => {
  try {
    const imp = await impostazione(req.user);
    const t = (await db.query(
      'SELECT creato_il, ultimo_uso, ultimo_report FROM api_token WHERE tenant_id = $1 AND user_id = $2 AND scopo = $3',
      [req.user.tenant_id, req.user.user_id, SCOPO])).rows[0];
    res.json({
      attivo: imp.attivo, ai: imp.ai,
      collegato: !!t, mailbox: t ? (t.ultimo_report || {}).mailbox || '' : '',
      creatoIl: t ? t.creato_il : null, ultimoUso: t ? t.ultimo_uso : null,
      scadeIl: t ? new Date(new Date(t.creato_il).getTime() + TOKEN_GIORNI * 86400000) : null
    });
  } catch (e) {
    if (e.code === '42P01') return res.status(503).json({ error: 'Tabella api_token mancante: eseguire Supporto/CreaDB/mysupport_push.sql' });
    invia(res, e, 'STATO');
  }
});

router.post('/codice', requireAuth, async (req, res) => {
  try {
    if (oltreLimite(`cod|${req.user.user_id}`, 10, 15 * 60000)) throw errore(429, 'Troppi codici richiesti: riprova tra qualche minuto');
    const imp = await impostazione(req.user);
    if (!imp.attivo) throw errore(403, 'Attiva prima «AI Add-in Outlook» in Impostazioni › AI');
    // Un solo codice valido per utente: il precedente non vale più.
    for (const [k, v] of codici) if (v.user_id === req.user.user_id) codici.delete(k);
    const codice = nuovoCodice();
    codici.set(impronta(normCodice(codice)), {
      tenant_id: req.user.tenant_id, user_id: req.user.user_id, email: req.user.email || '', scade: Date.now() + CODICE_MS
    });
    console.log(`[OUTLOOK] ${req.user.email || req.user.user_id}: codice di collegamento generato`);
    res.json({ codice, scadeTraSecondi: CODICE_MS / 1000 });
  } catch (e) { invia(res, e, 'CODICE'); }
});

router.delete('/collegamento', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM api_token WHERE tenant_id = $1 AND user_id = $2 AND scopo = $3', [req.user.tenant_id, req.user.user_id, SCOPO]);
    for (const [k, v] of codici) if (v.user_id === req.user.user_id) codici.delete(k);
    console.log(`[OUTLOOK] ${req.user.email || req.user.user_id}: Outlook scollegato`);
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'SCOLLEGA'); }
});

// Manifest dell'add-in (uguale per tutti, nessun segreto dentro): indirizzi presi dall'URL
// ufficiale di Projexa (APP_URL), così locale/staging/produzione hanno il proprio.
const MANIFEST_ID = 'b6f3c1d2-7a4e-4f5b-9c8d-2e1f0a3b4c5d';
const MANIFEST_VERSIONE = '1.0.0.0';
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function manifestXml(origine) {
  const o = xmlEsc(String(origine).replace(/\/+$/, ''));
  const icona = `${o}/Logo_Projexa_P.png`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
           xmlns:mailappor="http://schemas.microsoft.com/office/mailappversionoverrides/1.0"
           xsi:type="MailApp">
  <Id>${MANIFEST_ID}</Id>
  <Version>${MANIFEST_VERSIONE}</Version>
  <ProviderName>Projexa</ProviderName>
  <DefaultLocale>it-IT</DefaultLocale>
  <DisplayName DefaultValue="Projexa"/>
  <Description DefaultValue="Analizza con Projexa l'email aperta: cliente, segnalazioni, ticket, release e bozza di risposta."/>
  <IconUrl DefaultValue="${icona}"/>
  <HighResolutionIconUrl DefaultValue="${icona}"/>
  <SupportUrl DefaultValue="${o}/"/>
  <AppDomains>
    <AppDomain>${o}</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Mailbox"/>
  </Hosts>
  <Requirements>
    <Sets>
      <Set Name="Mailbox" MinVersion="1.5"/>
    </Sets>
  </Requirements>
  <FormSettings>
    <Form xsi:type="ItemRead">
      <DesktopSettings>
        <SourceLocation DefaultValue="${o}/outlook/taskpane.html"/>
        <RequestedHeight>450</RequestedHeight>
      </DesktopSettings>
    </Form>
  </FormSettings>
  <Permissions>ReadItem</Permissions>
  <Rule xsi:type="RuleCollection" Mode="Or">
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Read"/>
  </Rule>
  <DisableEntityHighlighting>true</DisableEntityHighlighting>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Requirements>
      <bt:Sets DefaultMinVersion="1.5">
        <bt:Set Name="Mailbox"/>
      </bt:Sets>
    </Requirements>
    <Hosts>
      <Host xsi:type="MailHost">
        <DesktopFormFactor>
          <FunctionFile resid="Commands.Url"/>
          <ExtensionPoint xsi:type="MessageReadCommandSurface">
            <OfficeTab id="TabDefault">
              <Group id="projexaGroup">
                <Label resid="Group.Label"/>
                <Control xsi:type="Button" id="projexaAnalizza">
                  <Label resid="Button.Label"/>
                  <Supertip>
                    <Title resid="Button.Label"/>
                    <Description resid="Button.Tooltip"/>
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Icon.16"/>
                    <bt:Image size="32" resid="Icon.32"/>
                    <bt:Image size="80" resid="Icon.80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <SourceLocation resid="Taskpane.Url"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
        <bt:Image id="Icon.16" DefaultValue="${icona}"/>
        <bt:Image id="Icon.32" DefaultValue="${icona}"/>
        <bt:Image id="Icon.80" DefaultValue="${icona}"/>
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Commands.Url" DefaultValue="${o}/outlook/commands.html"/>
        <bt:Url id="Taskpane.Url" DefaultValue="${o}/outlook/taskpane.html"/>
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="Group.Label" DefaultValue="Projexa"/>
        <bt:String id="Button.Label" DefaultValue="Analizza con Projexa"/>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="Button.Tooltip" DefaultValue="Analizza l'email aperta con i dati del cliente e del progetto in Projexa"/>
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>
`;
}
const origineProjexa = (req) => String(process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

router.get('/manifest.xml', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="projexa-outlook-manifest.xml"');
  res.send(manifestXml(origineProjexa(req)));
});

// ----------------------------------------------------------------------------
// ROTTE DELL'ADD-IN
// ----------------------------------------------------------------------------
// Scambio del codice monouso con il token (nessuna sessione: il codice È la prova).
router.post('/collega', async (req, res) => {
  try {
    if (oltreLimite(`col|${ipDi(req)}`, 10, 15 * 60000) || oltreLimite('col|tutti', 300, 15 * 60000)) {
      throw errore(429, 'Troppi tentativi: riprova tra qualche minuto');
    }
    const b = req.body || {};
    const mailbox = minuscola(b.mailbox);
    if (!EMAIL_RE.test(mailbox)) throw errore(400, 'Casella di Outlook non riconosciuta');
    const k = impronta(normCodice(b.codice));
    const c = codici.get(k);
    codici.delete(k); // monouso, anche se scaduto
    if (!c || c.scade < Date.now()) throw errore(400, 'Codice non valido o scaduto: generane uno nuovo in Projexa › Impostazioni › Profilo');
    const imp = await impostazione(c);
    if (!imp.attivo) throw errore(403, '«AI Add-in Outlook» non è attivo in Projexa › Impostazioni › AI');
    const psig = await currentSignature(c.user_id);
    const token = PREFISSO + crypto.randomBytes(32).toString('base64url');
    const info = { mailbox, email: c.email, psig, host: pulisci(b.host, 40), collegatoIl: new Date().toISOString() };
    // Uno per utente: collegando un'altra casella la precedente smette di funzionare.
    await db.query(
      `INSERT INTO api_token (tenant_id, user_id, scopo, token_hash, ultimo_report) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, user_id, scopo) DO UPDATE
         SET token_hash = EXCLUDED.token_hash, creato_il = now(), ultimo_uso = NULL, ultimo_report = EXCLUDED.ultimo_report`,
      [c.tenant_id, c.user_id, SCOPO, impronta(token), JSON.stringify(info)]);
    const mem = await currentMembership(c.user_id, c.tenant_id);
    console.log(`[OUTLOOK] ${c.email || c.user_id}: Outlook collegato (${mailbox})`);
    res.json({ token, tenant: mem ? mem.tenant_name : '' });
  } catch (e) { invia(res, e, 'COLLEGA'); }
});

router.get('/me', requireAddin, async (req, res) => {
  try {
    const imp = await impostazione(req.user);
    const u = (await db.query('SELECT name, cognome FROM users WHERE id = $1', [req.user.user_id])).rows[0] || {};
    res.json({ attivo: imp.attivo, ai: imp.ai, utente: [u.name, u.cognome].filter(Boolean).join(' '), tenant: req.user.tenant_name || '' });
  } catch (e) { invia(res, e, 'ME'); }
});

// Disattiva il collegamento dall'add-in stesso (pulsante «Scollega» nel pannello).
router.delete('/me', requireAddin, async (req, res) => {
  try {
    await db.query('DELETE FROM api_token WHERE id = $1', [req.addinTokenId]);
    res.json({ ok: true });
  } catch (e) { invia(res, e, 'SCOLLEGA ADD-IN'); }
});

// Email dal pannello -> dati puliti e limitati. Lanciata anche dentro il lavoro (dati già puliti).
function emailDaCorpo(b) {
  const indirizzo = (x) => {
    const email = minuscola(x && x.email);
    return EMAIL_RE.test(email) ? { nome: pulisci(x.nome, 120), email } : null;
  };
  const elenco = (v) => (Array.isArray(v) ? v : []).slice(0, MAX_INDIRIZZI).map(indirizzo).filter(Boolean);
  const mittente = indirizzo(b.mittente);
  if (!mittente) throw errore(400, 'Mittente dell\'email non leggibile');
  const testo = pulisci(b.testo, MAX_TESTO);
  if (!testo) throw errore(400, 'Email senza testo');
  const emailId = /^[0-9a-f]{64}$/.test(String(b.emailId || '')) ? b.emailId : '';
  const projectId = UUID_RE.test(String(b.projectId || '')) ? String(b.projectId) : '';
  return {
    mittente, a: elenco(b.a), cc: elenco(b.cc), oggetto: pulisci(b.oggetto, 500), testo,
    data: pulisci(b.data, 40), emailId, projectId, troncato: String(b.testo || '').length > MAX_TESTO
  };
}

// Limiti prima di mettere in coda un'analisi.
async function limitiAnalisi(req, res, next) {
  try {
    const imp = await impostazione(req.user);
    if (!imp.attivo) throw errore(403, '«AI Add-in Outlook» non è attivo in Projexa › Impostazioni › AI', 'NON_ATTIVO');
    if (!imp.ai) throw errore(400, 'Scegli l\'AI in Projexa › Impostazioni › AI › «AI Add-in Outlook»');
    if (/^chiedi/i.test(imp.ai)) throw errore(400, 'In «AI Add-in Outlook» scegli un\'AI precisa: dall\'add-in non si può chiedere ogni volta');
    const email = emailDaCorpo(req.body || {});
    if (oltreLimite(`ana|${req.user.user_id}`, MAX_ORA_UTENTE, 3600000)) throw errore(429, `Massimo ${MAX_ORA_UTENTE} analisi all'ora: riprova più tardi`);
    const r = (await db.query(
      `SELECT count(*) FILTER (WHERE user_id = $2)::int AS utente, count(*)::int AS tenant
         FROM ai_lavori WHERE tenant_id = $1 AND operazione = $3 AND stato = 'in_corso' AND creato_il > now() - interval '1 day'`,
      [req.user.tenant_id, req.user.user_id, OPERAZIONE])).rows[0];
    if (r.utente >= MAX_IN_CORSO_UTENTE) throw errore(429, `Hai già ${r.utente} analisi in corso: attendi che finiscano`);
    if (r.tenant >= MAX_IN_CORSO_TENANT) throw errore(429, 'Troppe analisi in corso nella tua azienda: riprova tra poco');
    // Solo i dati puliti vanno nel lavoro; il titolo (cifrato) è l'oggetto dell'email.
    req.body = { ...email, _titolo: email.oggetto ? `Email: ${email.oggetto}` : `Email di ${email.mittente.email}` };
    next();
  } catch (e) { invia(res, e, 'LIMITI'); }
}

router.post('/analizza', requireAddin, limitiAnalisi, ...rottaAi(OPERAZIONE, analizza));

// Stato e risultato di un'analisi: solo del proprio utente e tenant.
router.get('/lavori/:id', requireAddin, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!UUID_RE.test(id)) throw errore(400, 'Analisi non valida');
    const l = (await db.query(
      `SELECT id::text AS id, stato, risultato, errore, creato_il, concluso_il FROM ai_lavori
        WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND operazione = $4`,
      [id, req.user.tenant_id, req.user.user_id, OPERAZIONE])).rows[0];
    if (!l) throw errore(404, 'Analisi non trovata (forse già eliminata)');
    let risultato = null;
    try { risultato = l.risultato ? JSON.parse(l.risultato) : null; } catch { risultato = null; }
    res.json({ id: l.id, stato: l.stato, errore: l.errore || '', risultato, creato: l.creato_il, concluso: l.concluso_il });
  } catch (e) { invia(res, e, 'LAVORO'); }
});

// Ultima analisi della stessa email (riaprendo il pannello): emailId = impronta dell'id del
// messaggio calcolata dal pannello.
router.get('/lavori', requireAddin, async (req, res) => {
  try {
    const emailId = String(req.query.email || '');
    if (!/^[0-9a-f]{64}$/.test(emailId)) throw errore(400, 'Email non valida');
    const r = await db.query(
      `SELECT id::text AS id, stato, parametri, risultato, creato_il FROM ai_lavori
        WHERE tenant_id = $1 AND user_id = $2 AND operazione = $3 AND creato_il > now() - interval '7 days'
        ORDER BY creato_il DESC LIMIT 60`,
      [req.user.tenant_id, req.user.user_id, OPERAZIONE]);
    const trovato = r.rows.find((l) => {
      try {
        const ris = l.risultato ? JSON.parse(l.risultato) : null;
        if (ris && ris.emailId === emailId) return true;
        const p = l.parametri ? JSON.parse(l.parametri) : null;
        return !!(p && p.body && p.body.emailId === emailId);
      } catch { return false; }
    });
    res.json({ lavoro: trovato ? { id: trovato.id, stato: trovato.stato, creato: trovato.creato_il } : null });
  } catch (e) { invia(res, e, 'ELENCO LAVORI'); }
});

// ----------------------------------------------------------------------------
// ANALISI (gira nel lavoro AI, anche dopo un riavvio)
// ----------------------------------------------------------------------------
const DOMINI_PUBBLICI = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'outlook.it', 'hotmail.com', 'hotmail.it',
  'live.com', 'live.it', 'msn.com', 'yahoo.com', 'yahoo.it', 'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it', 'tim.it',
  'icloud.com', 'me.com', 'fastwebnet.it', 'pec.it', 'legalmail.it', 'aruba.it', 'email.it', 'inwind.it', 'tin.it',
  'protonmail.com', 'proton.me', 'teletu.it', 'katamail.com']);

async function righe(sql, params) {
  try { return (await db.query(sql, params)).rows; } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') console.warn(`[OUTLOOK] query non riuscita (${e.message})`);
    return [];
  }
}

// Cliente dal mittente (o, se il mittente è interno, dai destinatari): prima email esatta di
// un contatto o stakeholder, poi dominio. Solo clienti che l'utente vede (suoi o condivisi
// con lui) nei tenant di cui è membro.
async function trovaCliente(user, email) {
  const tenants = (await righe('SELECT tenant_id::text AS t FROM user_tenants WHERE user_id = $1', [user.user_id])).map((r) => r.t);
  if (!tenants.length) return null;
  const clienti = await righe(
    `SELECT c.id::text AS id, c.tenant_id::text AS tenant_id, c.valore2 AS nome, c.user_id::text AS owner,
            (c.scadenza IS NULL OR c.scadenza >= CURRENT_DATE) AS aperto
       FROM clients c
      WHERE c.tenant_id = ANY($1::uuid[]) AND c.argument = 'Cliente' AND c.campo = 'Cliente'
        AND (c.user_id = $2 OR EXISTS (SELECT 1 FROM client_shares s WHERE s.client_id = c.id AND s.shared_with_user_id = $2))`,
    [tenants, user.user_id]);
  if (!clienti.length) return null;
  const perId = new Map(clienti.map((c) => [c.id, c]));
  const ids = [...perId.keys()];
  const contatti = [
    ...(await righe('SELECT id::text AS id, client_id::text AS client_id, nome, cognome, email FROM contacts WHERE tenant_id = ANY($1::uuid[]) AND client_id::text = ANY($2::text[])', [tenants, ids]))
      .map((r) => ({ ...r, nominativo: [r.nome, r.cognome].filter(Boolean).join(' '), tipo: 'contatto' })),
    ...(await righe('SELECT client_id::text AS client_id, project_id::text AS project_id, nominativo, email FROM pm_stakeholder WHERE tenant_id = ANY($1::uuid[]) AND client_id::text = ANY($2::text[])', [tenants, ids]))
      .map((r) => ({ ...r, id: null, tipo: 'stakeholder' }))
  ].filter((c) => c.email && perId.has(c.client_id));
  // Domini interni (dell'utente e dei colleghi in rubrica): non identificano un cliente.
  const interni = new Set([dominio(user.email)]);
  for (const r of await righe('SELECT email FROM rubrica WHERE tenant_id = ANY($1::uuid[])', [tenants])) if (r.email) interni.add(dominio(r.email));
  const candidati = [email.mittente, ...email.a, ...email.cc].filter((x) => x && x.email);
  const preferito = (lista) => lista.sort((x, y) => (perId.get(y.client_id).aperto - perId.get(x.client_id).aperto)
    || ((perId.get(y.client_id).owner === user.user_id) - (perId.get(x.client_id).owner === user.user_id)))[0];
  for (const ind of candidati) {
    const esatti = contatti.filter((c) => minuscola(c.email) === ind.email);
    if (esatti.length) {
      const c = preferito(esatti);
      const cl = perId.get(c.client_id);
      return { tenantId: cl.tenant_id, clientId: cl.id, nome: cl.nome, come: ind === email.mittente ? 'mittente' : 'destinatario', indirizzo: ind.email,
        contattoId: c.tipo === 'contatto' ? c.id : null, contatto: c.nominativo || ind.nome, projectIdContatto: c.project_id || null };
    }
  }
  for (const ind of candidati) {
    const d = dominio(ind.email);
    if (!d || DOMINI_PUBBLICI.has(d) || interni.has(d)) continue;
    const perDominio = [...new Set(contatti.filter((c) => dominio(c.email) === d).map((c) => c.client_id))];
    if (perDominio.length === 1) {
      const cl = perId.get(perDominio[0]);
      return { tenantId: cl.tenant_id, clientId: cl.id, nome: cl.nome, come: 'dominio', indirizzo: ind.email, contattoId: null, contatto: ind.nome, projectIdContatto: null };
    }
  }
  return null;
}

// Progetto: quello scelto nel pannello, quello dello stakeholder, quello con più parole del
// nome nell'oggetto/testo, altrimenti il più recente.
function scegliProgetto(progetti, email, trovato) {
  if (!progetti.length) return null;
  const perId = (id) => progetti.find((p) => p.id === id);
  if (email.projectId && perId(email.projectId)) return perId(email.projectId);
  if (trovato.projectIdContatto && perId(trovato.projectIdContatto)) return perId(trovato.projectIdContatto);
  const testo = minuscola(`${email.oggetto} ${email.testo.slice(0, 5000)}`);
  let migliore = null;
  let punti = 0;
  for (const p of progetti) {
    const parole = minuscola(p.nome).split(/[^a-z0-9àèéìòù]+/).filter((w) => w.length > 3);
    const n = parole.filter((w) => testo.includes(w)).length;
    if (n > punti) { punti = n; migliore = p; }
  }
  return migliore || progetti[0];
}

const corto = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const giorno = (d) => (d ? dataIt(String(d instanceof Date ? d.toISOString() : d).slice(0, 10)) : '');
const tokenParole = (t) => new Set(minuscola(t).split(/[^a-z0-9àèéìòù]+/).filter((w) => w.length > 3));
function similitudine(a, b) {
  const A = tokenParole(a); const B = tokenParole(b);
  if (!A.size || !B.size) return 0;
  let comuni = 0;
  for (const w of A) if (B.has(w)) comuni += 1;
  return comuni / Math.min(A.size, B.size);
}
const chiusa = (stato) => /chius|risolt|annull|complet|done|closed|resolved/i.test(String(stato || ''));

// Dati del cliente (righe di tutti gli utenti per quel cliente: il cliente è dell'utente o
// condiviso con lui). I campi possono essere cifrati: confronti e ordinamenti in JS.
async function datiCliente(tenantId, clientId) {
  const p = [tenantId, clientId];
  const [issue, mysupport, jira, quotazioni] = await Promise.all([
    righe(`SELECT id::text AS id, project_id::text AS project_id, data_segnalazione, descrizione, categoria, stato, priorita, owner, mysupport, tkt_jira, deadline, data_chiusura
             FROM issue WHERE tenant_id = $1 AND client_id::text = $2 LIMIT 3000`, p),
    righe(`SELECT codice_quesito, stato_finale, operatore, data_apertura, data_chiusura, modulo, urgenza, procedura
             FROM mysupport WHERE tenant_id = $1 AND client_id::text = $2 LIMIT 5000`, p),
    righe(`SELECT cod_task, tipo, stato, assegnatario, versione, priorita, data_apertura, data_chiusura, descrizione, ticket_correlati
             FROM task_app WHERE tenant_id = $1 AND client_id::text = $2 LIMIT 5000`, p),
    righe(`SELECT codice, stato, versione_proposta, assegnatario, data_richiesta, descrizione, tkt_apertura
             FROM cl_quotazioni WHERE tenant_id = $1 AND client_id::text = $2 LIMIT 2000`, p)
  ]);
  const recenti = (l, campo) => [...l].sort((x, y) => String(y[campo] || '').localeCompare(String(x[campo] || '')));
  return { issue: recenti(issue, 'data_segnalazione'), mysupport: recenti(mysupport, 'data_apertura'), jira: recenti(jira, 'data_apertura'), quotazioni: recenti(quotazioni, 'data_richiesta') };
}

function testoDatiCliente(d) {
  const L = [];
  const aperte = d.issue.filter((x) => !chiusa(x.stato));
  L.push(`ISSUE DEL CLIENTE (aperte ${aperte.length}, ultime chiuse comprese fino a 40)`);
  for (const x of [...aperte, ...d.issue.filter((y) => chiusa(y.stato))].slice(0, 40)) {
    L.push(`- ${giorno(x.data_segnalazione)} [${x.stato}] ${x.categoria || ''}/${x.priorita || ''}: ${corto(x.descrizione, 220)}${x.owner ? ` | owner ${x.owner}` : ''}${x.mysupport ? ` | MySupport ${x.mysupport}` : ''}${x.tkt_jira ? ` | Jira ${x.tkt_jira}` : ''}${x.deadline ? ` | scadenza ${giorno(x.deadline)}` : ''}`);
  }
  L.push('', 'TICKET MYSUPPORT DEL CLIENTE (più recenti, fino a 40)');
  for (const x of d.mysupport.slice(0, 40)) {
    L.push(`- ${x.codice_quesito} | ${x.stato_finale || '-'} | in carico: ${x.operatore || '-'} | aperto ${giorno(x.data_apertura)}${x.data_chiusura ? ` | chiuso ${giorno(x.data_chiusura)}` : ''}${x.modulo ? ` | ${x.modulo}` : ''}${x.urgenza ? ` | urgenza ${x.urgenza}` : ''}`);
  }
  L.push('', 'TICKET JIRA DEL CLIENTE (più recenti, fino a 40)');
  for (const x of d.jira.slice(0, 40)) {
    L.push(`- ${x.cod_task} (${x.tipo || 'task'}) | ${x.stato || '-'} | in carico: ${x.assegnatario || '-'} | versione/release: ${x.versione || 'non indicata'} | aperto ${giorno(x.data_apertura)}${x.data_chiusura ? ` | chiuso ${giorno(x.data_chiusura)}` : ''} | ${corto(x.descrizione, 160)}${x.ticket_correlati ? ` | ticket collegati: ${corto(x.ticket_correlati, 80)}` : ''}`);
  }
  if (d.quotazioni.length) {
    L.push('', 'QUOTAZIONI JIRA DEL CLIENTE (fino a 20)');
    for (const x of d.quotazioni.slice(0, 20)) {
      L.push(`- ${x.codice} | ${x.stato || '-'} | versione proposta: ${x.versione_proposta || '-'} | in carico: ${x.assegnatario || '-'} | ${corto(x.descrizione, 140)}`);
    }
  }
  return L.join('\n');
}

// Ticket citati nell'email cercati SOLO tra quelli del cliente: chiavi Jira (ABC-123) e numeri
// MySupport. Fatti di Projexa, non dell'AI.
function ticketCitati(testo, d) {
  const chiavi = [...new Set((testo.match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g) || []))].slice(0, 30);
  const numeri = [...new Set((testo.match(/\b\d{5,10}\b/g) || []))].slice(0, 60);
  const parole = (s) => String(s || '').toUpperCase().split(/[^A-Z0-9-]+/);
  const out = [];
  const visti = new Set();
  const add = (t) => { if (!visti.has(`${t.sistema}|${t.codice}`)) { visti.add(`${t.sistema}|${t.codice}`); out.push(t); } };
  for (const k of chiavi) {
    const j = d.jira.find((x) => String(x.cod_task || '').toUpperCase() === k);
    if (j) add({ codice: k, sistema: 'Jira', stato: j.stato || '', inCarico: j.assegnatario || '', release: j.versione || '', apertura: giorno(j.data_apertura), chiusura: giorno(j.data_chiusura), descrizione: corto(j.descrizione, 200) });
    const q = d.quotazioni.find((x) => String(x.codice || '').toUpperCase() === k);
    if (q) add({ codice: k, sistema: 'Quotazione Jira', stato: q.stato || '', inCarico: q.assegnatario || '', release: q.versione_proposta || '', apertura: giorno(q.data_richiesta), chiusura: '', descrizione: corto(q.descrizione, 200) });
    if (!j && !q) add({ codice: k, sistema: 'Jira', nonTrovato: true });
  }
  for (const n of numeri) {
    const m = d.mysupport.find((x) => String(x.codice_quesito || '').trim() === n);
    if (m) {
      add({ codice: n, sistema: 'MySupport', stato: m.stato_finale || '', inCarico: m.operatore || '', release: '', apertura: giorno(m.data_apertura), chiusura: giorno(m.data_chiusura), descrizione: corto(m.procedura || m.modulo, 160) });
      // Ticket Jira collegati al MySupport (stesso legame di jobs/issueTicketJira.js).
      for (const j of d.jira.filter((x) => parole(x.ticket_correlati).includes(n))) {
        add({ codice: j.cod_task, sistema: 'Jira', stato: j.stato || '', inCarico: j.assegnatario || '', release: j.versione || '', apertura: giorno(j.data_apertura), chiusura: giorno(j.data_chiusura), descrizione: `collegato al MySupport ${n}: ${corto(j.descrizione, 160)}` });
      }
    }
  }
  return out;
}

async function releaseTenant(tenantId) {
  const r = await righe(
    `SELECT release, data_release FROM release_prodotto
      WHERE tenant_id = $1 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE) AND data_release >= CURRENT_DATE - 90
      ORDER BY data_release LIMIT 15`, [tenantId]);
  return r.filter((x) => String(x.release || '').trim()).map((x) => ({ release: String(x.release).trim(), data: giorno(x.data_release), futura: String(x.data_release instanceof Date ? x.data_release.toISOString() : x.data_release).slice(0, 10) >= oggiIso() }));
}

const FORMATO_JSON = `

FORMATO DELLA RISPOSTA (obbligatorio)
Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, con questa struttura:
{
  "tipi": ["errore" | "stato_ticket" | "data_rilascio" | "informazioni" | "altro"],
  "sintesi": "2-4 frasi: che cosa chiede o segnala l'email",
  "segnalazioni": [{"descrizione": "problema distinto, breve e chiaro", "categoria": "Bug|Richiesta|Configurazione|Altro", "priorita": "Alta|Media|Bassa", "mysupport": "codice o stringa vuota", "jira": "codice o stringa vuota"}],
  "ticket": [{"codice": "codice del ticket citato", "risposta": "cosa rispondere su questo ticket, SOLO dai dati"}],
  "release": "risposta sulla data di rilascio (stringa vuota se l'email non la chiede)",
  "punti_attenzione": ["cose che il PM deve verificare prima di rispondere"],
  "risposta_email": "testo completo della bozza di risposta, senza oggetto"
}
"segnalazioni" è vuoto se l'email non segnala errori o malfunzionamenti.`;

const CATEGORIE = ['Bug', 'Richiesta', 'Configurazione', 'Altro'];
const PRIORITA = ['Alta', 'Media', 'Bassa'];
const TIPI = ['errore', 'stato_ticket', 'data_rilascio', 'informazioni', 'altro'];
const voce = (v, ammessi, base) => ammessi.find((a) => a.toLowerCase() === minuscola(v)) || base;

// Issue nuove dalle segnalazioni (al massimo 3): già presente se un'issue aperta del cliente
// ha lo stesso ticket o una descrizione molto simile.
async function creaIssue(user, ctx, segnalazioni) {
  const out = [];
  const aperte = ctx.dati.issue.filter((x) => !chiusa(x.stato));
  for (const s of segnalazioni.slice(0, MAX_ISSUE_PER_EMAIL)) {
    const doppione = aperte.find((x) => (s.mysupport && String(x.mysupport || '').includes(s.mysupport))
      || (s.jira && String(x.tkt_jira || '').toUpperCase().includes(s.jira.toUpperCase()))
      || similitudine(x.descrizione, s.descrizione) >= 0.6);
    if (doppione) {
      out.push({ ...s, esito: 'gia_presente', issueId: doppione.id, issueDescrizione: corto(doppione.descrizione, 200), issueStato: doppione.stato });
      continue;
    }
    try {
      const riga = {
        tenant_id: ctx.tenantId, user_id: user.user_id, client_id: ctx.clientId, project_id: ctx.progetto ? ctx.progetto.id : null,
        visibilita: 'Cliente', categoria: s.categoria, stato: 'Aperto', priorita: s.priorita, descrizione: s.descrizione,
        note: corto(`Creata da Projexa (Add-in Outlook) dall'email di ${ctx.email.mittente.nome || ctx.email.mittente.email}${ctx.email.data ? ` del ${giorno(ctx.email.data)}` : ''}${ctx.email.oggetto ? `, oggetto «${ctx.email.oggetto}»` : ''}`, 1000),
        mysupport: s.mysupport || null, tkt_jira: s.jira || null, data_segnalazione: oggiIso(), richiedente: ctx.contattoId || null
      };
      const { data } = await encryptRowForWrite(db, 'issue', riga);
      const cols = Object.keys(data);
      const r = await db.query(
        `INSERT INTO issue (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::text AS id`,
        cols.map((c) => data[c]));
      const id = r.rows[0].id;
      aperte.push({ id, descrizione: s.descrizione, mysupport: s.mysupport, tkt_jira: s.jira, stato: 'Aperto' });
      out.push({ ...s, esito: 'creata', issueId: id });
      await notificaOutlook({
        tenantId: ctx.tenantId, userId: user.user_id,
        titolo: `Issue creata da email: ${ctx.clienteNome}`,
        messaggio: `${s.priorita} · ${s.categoria}: ${corto(s.descrizione, 400)}`, tabella: 'issue', rigaId: id
      });
    } catch (e) {
      console.error('[OUTLOOK] Issue non creata:', e.message);
      out.push({ ...s, esito: 'errore', errore: 'Issue non creata: riprova o inseriscila a mano' });
    }
  }
  return out;
}

async function analizza(req, res) {
  try {
    const user = req.user;
    const email = emailDaCorpo(req.body || {});
    const base = { versione: 1, emailId: email.emailId, oggetto: email.oggetto, mittente: email.mittente };
    const trovato = await trovaCliente(user, email);
    if (!trovato) {
      return res.json({ ...base, esito: 'cliente_non_trovato',
        messaggio: 'Il mittente (e i destinatari) non corrispondono a nessun contatto o stakeholder dei tuoi clienti in Projexa. Aggiungi il contatto alla scheda del cliente e riprova.' });
    }
    const u = { ...user, tenant_id: trovato.tenantId };
    const progetti = (await progettiAperti(u).catch(() => [])).filter((p) => p.clientId === trovato.clientId)
      .map((p) => ({ id: p.projectId, nome: p.nome }));
    const progetto = scegliProgetto(progetti, email, trovato);
    const [dati, release, contesto] = await Promise.all([
      datiCliente(trovato.tenantId, trovato.clientId),
      releaseTenant(trovato.tenantId),
      progetto ? contestoProgetto(u, progetto.id, { riunioni: 3, maxRecap: 1500 }).then((c) => c.testo).catch(() => '') : Promise.resolve('')
    ]);
    const ticket = ticketCitati(`${email.oggetto}\n${email.testo}`, dati);
    const testoEmail = [
      `Da: ${email.mittente.nome ? `${email.mittente.nome} <${email.mittente.email}>` : email.mittente.email}`,
      email.a.length ? `A: ${email.a.map((x) => x.email).join(', ')}` : '',
      email.cc.length ? `Cc: ${email.cc.map((x) => x.email).join(', ')}` : '',
      email.data ? `Data: ${email.data}` : '',
      `Oggetto: ${email.oggetto || '(senza oggetto)'}`,
      '',
      email.testo + (email.troncato ? '\n[... email troncata per lunghezza ...]' : '')
    ].filter((x) => x !== '').join('\n');
    const testoTicket = ticket.length
      ? ticket.map((t) => (t.nonTrovato ? `- ${t.codice} (${t.sistema}): NON presente tra i ticket di questo cliente in Projexa`
        : `- ${t.codice} (${t.sistema}) | stato: ${t.stato || '-'} | in carico: ${t.inCarico || '-'} | release/versione: ${t.release || 'non indicata'} | aperto ${t.apertura || '-'}${t.chiusura ? ` | chiuso ${t.chiusura}` : ''}${t.descrizione ? ` | ${t.descrizione}` : ''}`)).join('\n')
      : '(nessun ticket citato nell\'email trovato tra quelli del cliente)';
    const testoRelease = release.length
      ? release.map((r) => `- ${r.release}: ${r.data}${r.futura ? '' : ' (già rilasciata)'}`).join('\n')
      : '(nessuna release pianificata in Projexa)';
    const nomeUtente = (await righe('SELECT name, cognome FROM users WHERE id = $1', [user.user_id])).map((x) => [x.name, x.cognome].filter(Boolean).join(' '))[0] || '';
    const tpl = (await getPromptFor('OUTLOOK_ANALISI', u)).testo;
    const valori = {
      EMAIL: testoEmail, CLIENTE: trovato.nome || '', PROGETTO: progetto ? progetto.nome : 'non determinato', TICKET: testoTicket,
      RELEASE: testoRelease, DATA: dataIt(oggiIso()), UTENTE: nomeUtente || 'il project manager'
    };
    const datiTesto = [contesto ? `${contesto}\n` : '', testoDatiCliente(dati)].join('\n');
    const build = (d) => {
      const testo = tpl.includes('{{DATI}}') ? tpl : `${tpl}\n\nDATI\n{{DATI}}`;
      return testo.replace(/\{\{(EMAIL|CLIENTE|PROGETTO|TICKET|RELEASE|DATA|UTENTE|DATI)\}\}/g, (x, k) => (k === 'DATI' ? d : valori[k])) + FORMATO_JSON;
    };
    const r = await chiediAi(u, build, datiTesto, { json: true, ai: req.aiScelta });
    const j = leggiJson(r.testo);
    if (!j || typeof j !== 'object') throw errore(502, `${r.label || 'L\'AI'} non ha restituito un'analisi leggibile: riprova`);

    const segnalazioni = (Array.isArray(j.segnalazioni) ? j.segnalazioni : []).slice(0, MAX_ISSUE_PER_EMAIL)
      .map((s) => ({
        descrizione: corto(s && s.descrizione, 1000), categoria: voce(s && s.categoria, CATEGORIE, 'Bug'), priorita: voce(s && s.priorita, PRIORITA, 'Media'),
        mysupport: /^\d{5,10}$/.test(String(s && s.mysupport || '').trim()) ? String(s.mysupport).trim() : '',
        jira: /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/i.test(String(s && s.jira || '').trim()) ? String(s.jira).trim().toUpperCase() : ''
      }))
      .filter((s) => s.descrizione.length >= 10);
    const ctx = { tenantId: trovato.tenantId, clientId: trovato.clientId, clienteNome: trovato.nome, contattoId: trovato.contattoId, progetto, dati, email };
    const esitiIssue = segnalazioni.length ? await creaIssue(user, ctx, segnalazioni) : [];
    const risposteTicket = new Map((Array.isArray(j.ticket) ? j.ticket : []).slice(0, 30)
      .map((t) => [String(t && t.codice || '').trim().toUpperCase(), corto(t && t.risposta, 600)]));

    res.json({
      ...base, esito: 'ok',
      cliente: { id: trovato.clientId, nome: trovato.nome, come: trovato.come, indirizzo: trovato.indirizzo, contatto: trovato.contatto || '' },
      progetto, progetti,
      tipi: (Array.isArray(j.tipi) ? j.tipi : []).map((t) => minuscola(t)).filter((t) => TIPI.includes(t)).slice(0, 5),
      sintesi: corto(j.sintesi, 1500),
      segnalazioni: esitiIssue,
      ticket: ticket.map((t) => ({ ...t, risposta: risposteTicket.get(String(t.codice).toUpperCase()) || '' })),
      release: corto(j.release, 800),
      releasePianificate: release.filter((x) => x.futura).slice(0, 5),
      puntiAttenzione: (Array.isArray(j.punti_attenzione) ? j.punti_attenzione : []).slice(0, 8).map((x) => corto(x, 300)).filter(Boolean),
      rispostaEmail: String(j.risposta_email || '').slice(0, 8000).trim(),
      ai: { label: r.label || '', model: r.model || '', locale: !!r.locale }
    });
  } catch (e) {
    if (!e.status || e.status >= 500) console.error('❌ [OUTLOOK] analisi:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
}

export default router;
