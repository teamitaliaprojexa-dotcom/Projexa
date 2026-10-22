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
//    (validate e senza doppioni; mai per le email tra colleghi). Rischi, dipendenze, To-Do e
//    azioni del cliente proposti dall'AI si registrano solo quando il PM preme «Crea».
//    La bozza di risposta non parte mai da sola: la apre Outlook.
//  - Email interne (2026-10-22): se nessun indirizzo porta a un cliente, il cliente si ricava
//    dai ticket citati e dal nome scritto nel testo, tra i soli clienti dell'utente; se resta
//    il dubbio lo sceglie il PM nel pannello.
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
import { encryptRowForWrite, encryptValue, isEncrypted, hasEncryptionKey } from '../config/crypto.js';
import { cercaDoppione, todoAperte } from '../config/dedupVoci.js';
import { chiaveAzioneCliente } from '../config/azioniCliente.js';
import { getPromptFor } from '../config/prompts.js';
import { rottaAi } from '../jobs/aiLavori.js';
import { notificaOutlook } from '../jobs/notifiche.js';
import { chiediAi, leggiJson, contestoProgetto, progettiAperti, dataIt, oggiIso } from '../config/pmCore.js';
import { oraItaliana, salvaInfoOutlook, applicaARiunioni } from '../config/riunioniOutlook.js';

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
// 1.1 (2026-10-22): pulsante «Collega a Projexa» anche sugli appuntamenti (invitato e organizzatore).
// Stesso Id: ricaricando il file in Outlook l'add-in si aggiorna, non se ne crea un altro.
const MANIFEST_VERSIONE = '1.1.0.0';
// Pulsante del gruppo Projexa su una superficie di Outlook (email in lettura, appuntamenti).
const puntoComandi = (superficie, sigla, etichetta, descrizione) => `          <ExtensionPoint xsi:type="${superficie}">
            <OfficeTab id="TabDefault">
              <Group id="projexaGroup${sigla}">
                <Label resid="Group.Label"/>
                <Control xsi:type="Button" id="projexaPulsante${sigla}">
                  <Label resid="${etichetta}"/>
                  <Supertip>
                    <Title resid="${etichetta}"/>
                    <Description resid="${descrizione}"/>
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
          </ExtensionPoint>`;
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
    <Form xsi:type="ItemEdit">
      <DesktopSettings>
        <SourceLocation DefaultValue="${o}/outlook/taskpane.html"/>
      </DesktopSettings>
    </Form>
  </FormSettings>
  <Permissions>ReadItem</Permissions>
  <Rule xsi:type="RuleCollection" Mode="Or">
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Read"/>
    <Rule xsi:type="ItemIs" ItemType="Appointment" FormType="ReadOrEdit"/>
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
${puntoComandi('MessageReadCommandSurface', 'Msg', 'Button.Label', 'Button.Tooltip')}
${puntoComandi('AppointmentAttendeeCommandSurface', 'AppInv', 'App.Label', 'App.Tooltip')}
${puntoComandi('AppointmentOrganizerCommandSurface', 'AppOrg', 'App.Label', 'App.Tooltip')}
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
        <bt:String id="App.Label" DefaultValue="Collega a Projexa"/>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="Button.Tooltip" DefaultValue="Analizza l'email aperta con i dati del cliente e del progetto in Projexa"/>
        <bt:String id="App.Tooltip" DefaultValue="Porta in Projexa organizzatore e partecipanti della riunione, con cliente e progetto riconosciuti"/>
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
  // Cliente scelto dal PM nel pannello (cliente non riconosciuto o sbagliato) e «nessun
  // progetto» (tema del solo cliente).
  const clientId = UUID_RE.test(String(b.clientId || '')) ? String(b.clientId).toLowerCase() : '';
  return {
    mittente, a: elenco(b.a), cc: elenco(b.cc), oggetto: pulisci(b.oggetto, 500), testo,
    data: pulisci(b.data, 40), emailId, projectId, clientId, senzaProgetto: !projectId && b.senzaProgetto === true,
    troncato: String(b.testo || '').length > MAX_TESTO
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

// ----------------------------------------------------------------------------
// APPUNTAMENTI DEL CALENDARIO (2026-10-22): «Collega a Projexa» su un appuntamento aperto.
// Organizzatore e partecipanti -> cliente e progetto (come per il mittente di un'email) ->
// salvati in rec_meeting_outlook (config/riunioniOutlook.js) e passati subito alle riunioni di
// Projexa dello stesso giorno, ora e titolo (solo i campi vuoti). Niente AI.
// ----------------------------------------------------------------------------
router.post('/appuntamento', requireAddin, async (req, res) => {
  try {
    if (oltreLimite(`app|${req.user.user_id}`, 120, 3600000)) throw errore(429, 'Troppe richieste: riprova tra poco');
    const imp = await impostazione(req.user);
    if (!imp.attivo) throw errore(403, '«AI Add-in Outlook» non è attivo in Projexa › Impostazioni › AI', 'NON_ATTIVO');
    const b = req.body || {};
    const persona = (x, tipo) => {
      const email = minuscola(x && x.email);
      return EMAIL_RE.test(email) ? { nome: pulisci(x.nome, 120), email, tipo } : null;
    };
    const organizzatore = persona(b.organizzatore, 'organizzatore');
    const lista = (v, tipo) => (Array.isArray(v) ? v : []).slice(0, 200).map((x) => persona(x, tipo)).filter(Boolean);
    const obbligatori = lista(b.obbligatori, 'obbligatorio');
    const facoltativi = lista(b.facoltativi, 'facoltativo');
    const oggetto = pulisci(b.oggetto, 500);
    const inizio = oraItaliana(b.inizio);
    const fine = b.fine ? oraItaliana(b.fine) : null;
    if (!inizio) throw errore(400, 'Data e ora dell\'appuntamento non leggibili');
    if (!oggetto) throw errore(400, 'Appuntamento senza oggetto');
    // Partecipanti senza doppioni (l'organizzatore a volte compare anche tra gli obbligatori).
    const visti = new Set(organizzatore ? [organizzatore.email] : []);
    const partecipanti = [...obbligatori, ...facoltativi].filter((p) => !visti.has(p.email) && visti.add(p.email));

    // Cliente e progetto: dall'organizzatore e dai partecipanti, come per le email.
    const email = { mittente: organizzatore || partecipanti[0] || null, a: obbligatori, cc: facoltativi, oggetto, testo: pulisci(b.luogo, 300), projectId: UUID_RE.test(String(b.projectId || '')) ? String(b.projectId) : '' };
    let trovato = email.mittente ? await trovaCliente(req.user, email) : null;
    // Tenant del cliente diverso da quello del collegamento: i dati restano nel tenant del token.
    if (trovato && trovato.tenantId !== req.user.tenant_id) trovato = null;
    let progetti = [];
    let progetto = null;
    if (trovato) {
      progetti = (await progettiAperti(req.user).catch(() => [])).filter((p) => p.clientId === trovato.clientId).map((p) => ({ id: p.projectId, nome: p.nome }));
      progetto = scegliProgetto(progetti, email, trovato);
    }
    const info = {
      data: inizio.data, ora: inizio.ora, fine: fine ? fine.ora : null, oggetto,
      organizzatore: organizzatore || {}, partecipanti,
      clientId: trovato ? trovato.clientId : null, projectId: progetto ? progetto.id : null
    };
    try {
      await salvaInfoOutlook(req.user, info);
    } catch (e) {
      if (e.code === '42P01') throw errore(503, 'Funzione non ancora attiva: va eseguito lo script Supporto/CreaDB/rec_meeting_outlook.sql');
      throw e;
    }
    const riunioni = await applicaARiunioni(req.user, info);
    console.log(`[OUTLOOK] ${req.user.email || req.user.user_id}: appuntamento collegato (${partecipanti.length + (organizzatore ? 1 : 0)} persone, cliente ${trovato ? 'riconosciuto' : 'non trovato'}, riunioni Projexa ${riunioni.length})`);
    res.json({
      oggetto, data: dataIt(inizio.data), ora: inizio.ora, fine: fine ? fine.ora : '',
      organizzatore, partecipanti,
      cliente: trovato ? { id: trovato.clientId, nome: trovato.nome, come: trovato.come, indirizzo: trovato.indirizzo } : null,
      progetto, progetti,
      riunioni: riunioni.map((r) => ({ oggetto: r.oggetto, campi: r.campi }))
    });
  } catch (e) { invia(res, e, 'APPUNTAMENTO'); }
});

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

// «Crea» su un'azione proposta dall'analisi (2026-10-22): rischio o dipendenza -> pm_raid (serve
// un progetto), To-Do -> tasks, azione a carico del cliente -> pm_azioni_cliente. Il contenuto
// arriva dal risultato salvato dell'analisi, non dal pannello: il pannello sceglie solo quale
// (n) e, al massimo, il progetto tra quelli aperti del cliente. Doppioni: To-Do aperte simili
// (config/dedupVoci.js), RAID aperti con titolo molto simile, azioni del cliente con lo stesso
// testo. L'azione creata resta segnata nel risultato (niente doppio clic).
router.post('/lavori/:id/azioni/:n', requireAddin, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const n = Number(req.params.n);
    if (!UUID_RE.test(id) || !Number.isInteger(n) || n < 0 || n >= MAX_AZIONI) throw errore(400, 'Azione non valida');
    if (oltreLimite(`azi|${req.user.user_id}`, 60, 3600000)) throw errore(429, 'Troppe richieste: riprova tra poco');
    const l = (await db.query(
      `SELECT risultato FROM ai_lavori WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND operazione = $4 AND stato = 'pronto'`,
      [id, req.user.tenant_id, req.user.user_id, OPERAZIONE])).rows[0];
    if (!l) throw errore(404, 'Analisi non trovata (forse già eliminata): rianalizza l\'email');
    let ris = null;
    try { ris = JSON.parse(l.risultato); } catch { ris = null; }
    const a = ris && Array.isArray(ris.azioni) ? ris.azioni.find((x) => x && x.n === n) : null;
    if (!a || !TIPI_AZIONE.includes(a.tipo)) throw errore(404, 'Azione non trovata');
    if (a.creata) return res.json({ esito: 'gia_creata', ...a.creata });
    // Cliente dell'analisi: ancora visibile all'utente e nel tenant del collegamento.
    const clientId = ris.cliente && ris.cliente.id;
    const cl = clientId && (await clientiUtente(req.user)).clienti.find((c) => c.id === clientId && c.tenant_id === req.user.tenant_id);
    if (!cl) throw errore(403, 'Il cliente dell\'analisi non è tra i tuoi clienti di questo spazio di lavoro');
    const aperti = (await progettiAperti(req.user).catch(() => [])).filter((p) => p.clientId === clientId);
    const voluto = UUID_RE.test(String((req.body || {}).projectId || '')) ? String(req.body.projectId) : (ris.progetto && ris.progetto.id) || '';
    const prog = aperti.find((p) => p.projectId === voluto) || null;
    const ruolo = Number.isFinite(Number(req.user.id_roles)) ? String(Number(req.user.id_roles)) : null;
    const base = { tenant_id: req.user.tenant_id, user_id: req.user.user_id, client_id: clientId, project_id: prog ? prog.projectId : null, crypto: 1 };
    const fonte = `Da email${ris.mittente && ris.mittente.email ? ` di ${ris.mittente.nome || ris.mittente.email}` : ''}${ris.oggetto ? ` «${corto(ris.oggetto, 120)}»` : ''} (${dataIt(oggiIso())})`;
    const descrizione = corto([a.descrizione, fonte].filter(Boolean).join('\n'), 4000);
    let creata;

    if (a.tipo === 'rischio' || a.tipo === 'dipendenza') {
      if (!prog) throw errore(400, 'Rischi e dipendenze stanno nel RAID di un progetto: scegli il progetto e premi di nuovo «Crea»');
      const esistenti = await righe(
        `SELECT id::text AS id, titolo FROM pm_raid WHERE tenant_id = $1 AND user_id = $2 AND project_id = $3 AND tipo = $4
            AND stato <> 'chiuso' AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
        [req.user.tenant_id, req.user.user_id, prog.projectId, a.tipo]);
      const doppione = esistenti.find((x) => similitudine(x.titolo, a.titolo) >= 0.8);
      if (doppione) creata = { tabella: 'pm_raid', id: doppione.id, giaPresente: true };
      else {
        const riga = { ...base, tipo: a.tipo, titolo: a.titolo, descrizione, owner: a.owner || null, mitigazione: a.mitigazione || null,
          data_revisione: a.scadenza || null, stato: 'aperto', origine: 'manuale', id_roles_write: ruolo };
        creata = { tabella: 'pm_raid', id: await inserisciRiga('pm_raid', riga) };
      }
    } else if (a.tipo === 'todo') {
      const owner = a.owner || '';
      const esistenti = await todoAperte(req.user, { projectId: base.project_id, clientId });
      const doppione = cercaDoppione({ registro: 'todo', titolo: a.titolo, descrizione, owner }, esistenti);
      if (doppione) creata = { tabella: 'tasks', id: doppione.id, giaPresente: true };
      else {
        const colTasks = new Set((await db.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks'")).rows.map((x) => x.column_name));
        const ruoloN = ruolo != null ? Number(ruolo) : 90;
        const riga = { ...base, tipo_task: 'Automatica', titile: a.titolo, description: descrizione, status: 'in_progress', priority: 'medium',
          due_date: a.scadenza || null, data_inizio: oggiIso(), scadenza: '2099-12-31', id_roles: ruoloN, id_roles_write: ruoloN, created_by: req.user.user_id };
        if (owner) riga.assigned_to_text = owner;
        creata = { tabella: 'tasks', id: await inserisciRiga('tasks', riga, colTasks) };
      }
    } else {
      const testoAzione = corto(`${a.titolo}${a.descrizione ? `: ${a.descrizione}` : ''}`, 4000);
      const chiave = chiaveAzioneCliente(testoAzione);
      const doppione = (await righe(
        `SELECT id::text AS id, chiave FROM pm_azioni_cliente WHERE tenant_id = $1 AND user_id = $2 AND client_id = $3
            AND stato = 'aperta' AND (scadenza IS NULL OR scadenza >= CURRENT_DATE)`,
        [req.user.tenant_id, req.user.user_id, clientId])).find((x) => x.chiave === chiave);
      if (doppione) creata = { tabella: 'pm_azioni_cliente', id: doppione.id, giaPresente: true };
      else {
        const riga = { ...base, id_calendar: null, referente: a.owner || null, descrizione: testoAzione, data_scadenza: a.scadenza || null,
          stato: 'aperta', origine: 'manuale', chiave, modificata: true, note: fonte, id_roles_write: ruolo };
        creata = { tabella: 'pm_azioni_cliente', id: await inserisciRiga('pm_azioni_cliente', riga) };
      }
    }
    creata = { ...creata, progetto: prog ? prog.nome : '' };
    ris.azioni = ris.azioni.map((x) => (x && x.n === n ? { ...x, creata } : x));
    await db.query('UPDATE ai_lavori SET risultato = $2 WHERE id = $1', [id, cifraTesto(JSON.stringify(ris))]);
    console.log(`[OUTLOOK] ${req.user.email || req.user.user_id}: azione proposta ${a.tipo} ${creata.giaPresente ? 'già presente' : 'creata'} (${creata.tabella})`);
    res.status(creata.giaPresente ? 200 : 201).json({ esito: creata.giaPresente ? 'gia_presente' : 'creata', ...creata });
  } catch (e) {
    if (e.code === '42P01') return invia(res, errore(503, 'Registro non ancora attivo in Projexa: va eseguito lo script SQL del registro (pm_senior.sql o azioni_cliente.sql)'), 'AZIONE');
    invia(res, e, 'AZIONE');
  }
});

async function inserisciRiga(tabella, riga, colonne = null) {
  const { data } = await encryptRowForWrite(db, tabella, riga);
  const cols = Object.keys(data).filter((c) => !colonne || colonne.has(c));
  const r = await db.query(
    `INSERT INTO ${tabella} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::text AS id`,
    cols.map((c) => data[c]));
  return r.rows[0].id;
}
// Come jobs/aiLavori.js: il risultato dei lavori AI resta cifrato.
const cifraTesto = (v) => (!hasEncryptionKey() || isEncrypted(v) ? v : encryptValue(String(v)));

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

// Clienti che l'utente vede (suoi o condivisi con lui) nei tenant di cui è membro.
async function clientiUtente(user) {
  const tenants = (await righe('SELECT tenant_id::text AS t FROM user_tenants WHERE user_id = $1', [user.user_id])).map((r) => r.t);
  if (!tenants.length) return { tenants, clienti: [] };
  const clienti = await righe(
    `SELECT c.id::text AS id, c.tenant_id::text AS tenant_id, c.valore2 AS nome, c.user_id::text AS owner,
            (c.scadenza IS NULL OR c.scadenza >= CURRENT_DATE) AS aperto
       FROM clients c
      WHERE c.tenant_id = ANY($1::uuid[]) AND c.argument = 'Cliente' AND c.campo = 'Cliente'
        AND (c.user_id = $2 OR EXISTS (SELECT 1 FROM client_shares s WHERE s.client_id = c.id AND s.shared_with_user_id = $2))`,
    [tenants, user.user_id]);
  return { tenants, clienti };
}

// Cliente dal mittente (o, se il mittente è interno, dai destinatari): prima email esatta di
// un contatto o stakeholder, poi dominio. Solo clienti che l'utente vede.
// Cliente scelto dal PM nel pannello (email.clientId): vince su tutto.
// daTesto (solo email, 2026-10-22): se nessun indirizzo porta a un cliente (scambio tra
// colleghi, inoltri), il cliente si cerca dai ticket citati e dal nome scritto nel testo.
// Il risultato dice anche se l'email è interna (tutti gli indirizzi su domini interni).
async function trovaCliente(user, email, { daTesto = false } = {}) {
  const { tenants, clienti } = await clientiUtente(user);
  if (!clienti.length) return null;
  const perId = new Map(clienti.map((c) => [c.id, c]));
  const ids = [...perId.keys()];
  // Domini interni (dell'utente e dei colleghi in rubrica): non identificano un cliente.
  const interni = new Set([dominio(user.email)]);
  for (const r of await righe('SELECT email FROM rubrica WHERE tenant_id = ANY($1::uuid[])', [tenants])) if (r.email) interni.add(dominio(r.email));
  interni.delete('');
  const candidati = [email.mittente, ...email.a, ...email.cc].filter((x) => x && x.email);
  const interna = candidati.length > 0 && candidati.every((x) => interni.has(dominio(x.email)));
  if (email.clientId && perId.has(email.clientId)) {
    const cl = perId.get(email.clientId);
    return { tenantId: cl.tenant_id, clientId: cl.id, nome: cl.nome, come: 'scelto', indirizzo: '', contattoId: null, contatto: '', projectIdContatto: null, interna };
  }
  const contatti = [
    ...(await righe('SELECT id::text AS id, client_id::text AS client_id, nome, cognome, email FROM contacts WHERE tenant_id = ANY($1::uuid[]) AND client_id::text = ANY($2::text[])', [tenants, ids]))
      .map((r) => ({ ...r, nominativo: [r.nome, r.cognome].filter(Boolean).join(' '), tipo: 'contatto' })),
    ...(await righe('SELECT client_id::text AS client_id, project_id::text AS project_id, nominativo, email FROM pm_stakeholder WHERE tenant_id = ANY($1::uuid[]) AND client_id::text = ANY($2::text[])', [tenants, ids]))
      .map((r) => ({ ...r, id: null, tipo: 'stakeholder' }))
  ].filter((c) => c.email && perId.has(c.client_id));
  const preferito = (lista) => lista.sort((x, y) => (perId.get(y.client_id).aperto - perId.get(x.client_id).aperto)
    || ((perId.get(y.client_id).owner === user.user_id) - (perId.get(x.client_id).owner === user.user_id)))[0];
  for (const ind of candidati) {
    const esatti = contatti.filter((c) => minuscola(c.email) === ind.email);
    if (esatti.length) {
      const c = preferito(esatti);
      const cl = perId.get(c.client_id);
      return { tenantId: cl.tenant_id, clientId: cl.id, nome: cl.nome, come: ind === email.mittente ? 'mittente' : 'destinatario', indirizzo: ind.email,
        contattoId: c.tipo === 'contatto' ? c.id : null, contatto: c.nominativo || ind.nome, projectIdContatto: c.project_id || null, interna };
    }
  }
  for (const ind of candidati) {
    const d = dominio(ind.email);
    if (!d || DOMINI_PUBBLICI.has(d) || interni.has(d)) continue;
    const perDominio = [...new Set(contatti.filter((c) => dominio(c.email) === d).map((c) => c.client_id))];
    if (perDominio.length === 1) {
      const cl = perId.get(perDominio[0]);
      return { tenantId: cl.tenant_id, clientId: cl.id, nome: cl.nome, come: 'dominio', indirizzo: ind.email, contattoId: null, contatto: ind.nome, projectIdContatto: null, interna };
    }
  }
  if (!daTesto) return null;
  const t = await clienteDaTesto(tenants, clienti, interni, email, contatti);
  return t ? { ...t, interna } : null;
}

// Cliente dal testo dell'email (oggetto e corpo, risposte citate comprese): ticket citati che
// Projexa conosce (task e quotazioni Jira, MySupport, Issue: 3 punti, 2 per le Issue), contatti
// del cliente scritti nelle email citate (righe «Da:»/«A:»/«Cc:» del thread: 1 punto per
// contatto, +2 per chi ha aperto la conversazione, cioè l'ultimo «Da:» esterno in fondo) e nome
// del cliente scritto per esteso (2 punti, cercato nel testo senza gli indirizzi email: il
// dominio di un indirizzo non è il nome scritto). Vince solo un cliente con più punti di tutti
// gli altri: a pari merito il PM lo sceglie nel pannello. I codici possono essere cifrati: il
// confronto si fa qui, non in SQL. Il progetto viene dai ticket se sono tutti di un progetto.
// Il cliente che porta il nome dell'azienda interna (radice dei domini interni) non conta mai.
const FORME_SOCIETARIE = new Set(['srl', 'spa', 'sas', 'snc', 'srls', 'sapa', 'scarl', 'scrl', 'coop', 'societa', 'gruppo', 'group', 'italia', 'italy', 'the', 'and']);
const paroleNome = (s) => senzaAccenti(minuscola(s)).replace(/\b([a-z])\.(?=[a-z]\.)/g, '$1').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const INDIRIZZO_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
async function clienteDaTesto(tenants, clienti, interni, email, contatti = []) {
  const testo = `${email.oggetto}\n${email.testo}`;
  const radiciInterne = new Set([...interni].map((d) => d.split('.')[0]));
  const interno = (c) => paroleNome(c.nome).some((w) => radiciInterne.has(w));
  const chiavi = new Set((testo.toUpperCase().match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g) || []).slice(0, 30));
  const numeri = new Set((testo.match(/\b\d{5,10}\b/g) || []).slice(0, 60));
  const perId = new Map(clienti.filter((c) => !interno(c)).map((c) => [c.id, c]));
  const voti = new Map(); // client_id -> { punti, motivi, progetti }
  const segna = (clientId, punti, motivo, projectId) => {
    if (!perId.has(clientId)) return;
    const v = voti.get(clientId) || { punti: 0, motivi: [], progetti: new Set() };
    if (v.motivi.includes(motivo)) return;
    v.punti += punti;
    v.motivi.push(motivo);
    if (projectId) v.progetti.add(projectId);
    voti.set(clientId, v);
  };
  if (chiavi.size || numeri.size) {
    const p = [tenants, [...perId.keys()]];
    const dove = 'WHERE tenant_id = ANY($1::uuid[]) AND client_id::text = ANY($2::text[])';
    const [jira, quotazioni, mysupport, issue] = await Promise.all([
      chiavi.size ? righe(`SELECT client_id::text AS client_id, project_id::text AS project_id, cod_task AS codice FROM task_app ${dove} LIMIT 50000`, p) : [],
      chiavi.size ? righe(`SELECT client_id::text AS client_id, project_id::text AS project_id, codice FROM cl_quotazioni ${dove} LIMIT 20000`, p) : [],
      numeri.size ? righe(`SELECT client_id::text AS client_id, project_id::text AS project_id, codice_quesito AS codice FROM mysupport ${dove} LIMIT 50000`, p) : [],
      righe(`SELECT client_id::text AS client_id, project_id::text AS project_id, mysupport, tkt_jira FROM issue ${dove} LIMIT 20000`, p)
    ]);
    const cod = (x) => String(x.codice || '').trim().toUpperCase();
    for (const x of jira) if (chiavi.has(cod(x))) segna(x.client_id, 3, `ticket ${cod(x)}`, x.project_id);
    for (const x of quotazioni) if (chiavi.has(cod(x))) segna(x.client_id, 3, `quotazione ${cod(x)}`, x.project_id);
    for (const x of mysupport) if (numeri.has(cod(x))) segna(x.client_id, 3, `MySupport ${cod(x)}`, x.project_id);
    for (const x of issue) {
      const c = [...codiciIn(x.tkt_jira).filter((k) => chiavi.has(k)), ...codiciIn(x.mysupport).filter((k) => numeri.has(k))][0];
      if (c) segna(x.client_id, 2, `Issue con ${c}`, x.project_id);
    }
  }
  // Contatti del cliente scritti nel thread (indirizzi esterni). Autore = ultimo «Da:»/«From:»
  // con un indirizzo esterno: la prima email della conversazione, in fondo al testo.
  const esterno = (e) => !interni.has(dominio(e)) && !DOMINI_PUBBLICI.has(dominio(e));
  const indirizzi = new Set((testo.match(INDIRIZZO_RE) || []).map(minuscola).filter(esterno));
  const autori = [...testo.matchAll(/(?:^|\n)[ \t*>]*(?:Da|From)\s*:[^\n]*/gi)]
    .map((r) => (r[0].match(INDIRIZZO_RE) || []).map(minuscola).find(esterno)).filter(Boolean);
  const autore = autori[autori.length - 1] || '';
  const perCliente = new Map(); // client_id -> { punti, nomi }
  for (const ind of indirizzi) {
    for (const clientId of new Set(contatti.filter((c) => minuscola(c.email) === ind && perId.has(c.client_id)).map((c) => c.client_id))) {
      const c = contatti.find((x) => x.client_id === clientId && minuscola(x.email) === ind);
      const v = perCliente.get(clientId) || { punti: 0, nomi: [] };
      v.punti += ind === autore ? 3 : 1;
      v.nomi.push(`${c.nominativo || ind}${ind === autore ? ' (autore)' : ''}`);
      perCliente.set(clientId, v);
    }
  }
  for (const [clientId, v] of perCliente) {
    v.nomi.sort((a, b) => b.endsWith('(autore)') - a.endsWith('(autore)'));
    segna(clientId, v.punti, `contatti nel thread: ${v.nomi.slice(0, 3).join(', ')}${v.nomi.length > 3 ? ` e altri ${v.nomi.length - 3}` : ''}`);
  }
  // Nome del cliente per esteso, senza forme societarie («LEROY MERLIN ITALIA SRL» -> «leroy
  // merlin»). Una sola parola solo se lunga almeno 5 lettere.
  const base = ` ${paroleNome(testo.replace(INDIRIZZO_RE, ' ')).join(' ')} `;
  for (const c of perId.values()) {
    const parole = paroleNome(c.nome).filter((w) => !FORME_SOCIETARIE.has(w));
    if (!parole.length) continue;
    for (let k = parole.length; k >= 1; k--) {
      const v = parole.slice(0, k).join(' ');
      if (v.length < 5 || (k === 1 && parole.length > 1)) continue;
      if (base.includes(` ${v} `)) { segna(c.id, 2, `nome «${v}» nel testo`); break; }
    }
  }
  const ordinati = [...voti.entries()].sort((a, b) => b[1].punti - a[1].punti
    || (perId.get(b[0]).aperto - perId.get(a[0]).aperto));
  if (!ordinati.length || (ordinati[1] && ordinati[1][1].punti === ordinati[0][1].punti)) return null;
  const [clientId, v] = ordinati[0];
  const cl = perId.get(clientId);
  return { tenantId: cl.tenant_id, clientId, nome: cl.nome, come: 'testo', indirizzo: '', motivo: v.motivi.slice(0, 4).join(', '),
    contattoId: null, contatto: '', projectIdContatto: v.progetti.size === 1 ? [...v.progetti][0] : null };
}

// Progetto: quello scelto nel pannello, quello dello stakeholder (o dei ticket citati), quello
// con più parole del nome nell'oggetto/testo, quello delle riunioni dove si è parlato dello
// stesso argomento (voti: project_id -> punti), l'unico progetto aperto; altrimenti nessuno
// (tema del cliente: meglio «non determinato» che il primo della lista, 2026-10-22).
function scegliProgetto(progetti, email, trovato, voti = new Map()) {
  if (!progetti.length || email.senzaProgetto) return null;
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
  if (migliore) return migliore;
  const votato = progetti.filter((p) => voti.get(p.id) > 0).sort((a, b) => voti.get(b.id) - voti.get(a.id))[0];
  return votato || (progetti.length === 1 ? progetti[0] : null);
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

// ----------------------------------------------------------------------------
// RELEASE: la «Versione» di un task Jira (o la versione proposta di una quotazione) si cerca
// nella tabella delle release del tenant per avere la data. Le release si mostrano SOLO
// collegate a un ticket: senza ticket sullo stesso problema il calendario non serve.
// ----------------------------------------------------------------------------
async function releaseTenant(tenantId) {
  const r = await righe(
    `SELECT release, data_release FROM release_prodotto
      WHERE tenant_id = $1 AND (scadenza IS NULL OR scadenza >= CURRENT_DATE) AND NULLIF(btrim(release), '') IS NOT NULL
      ORDER BY data_release LIMIT 500`, [tenantId]);
  return r.map((x) => {
    const iso = String(x.data_release instanceof Date ? x.data_release.toISOString() : (x.data_release || '')).slice(0, 10);
    return { release: String(x.release).trim(), data: giorno(iso), futura: !!iso && iso >= oggiIso() };
  });
}
const normVersione = (v) => minuscola(v).replace(/^(release|rel\.?|versione|ver\.?|v)\s*/, '').replace(/[\s_]+/g, '');
// Numero di versione («5.26 Hotfix» -> 5.26): confronto esatto, così 5.2 non va con 5.27.
const numeroVersione = (v) => (String(v || '').match(/\d+(?:\.\d+)+/) || [''])[0];
function releaseDi(versione, release) {
  const v = normVersione(versione);
  if (v.length < 2) return null;
  const num = numeroVersione(versione);
  return release.find((r) => normVersione(r.release) === v)
    || (num ? release.find((r) => numeroVersione(r.release) === num) : null)
    || null;
}

// ----------------------------------------------------------------------------
// TICKET: fatti di Projexa, non dell'AI. Catena MySupport -> task Jira che lo citano nei
// «Ticket correlati» (come jobs/issueTicketJira.js) -> «Versione» -> data della release.
// origine: 'citato' (codice scritto nell'email), 'argomento' (task o issue sullo stesso
// problema trovati dalla ricerca per argomento).
// ----------------------------------------------------------------------------
const codiciIn = (s) => String(s || '').toUpperCase().split(/[^A-Z0-9-]+/).filter(Boolean);
function fattoJira(j, rel, origine, nota = '') {
  const r = releaseDi(j.versione, rel);
  return { codice: String(j.cod_task || '').trim(), sistema: 'Jira', origine, stato: j.stato || '', inCarico: j.assegnatario || '',
    versione: j.versione || '', release: r ? r.release : '', releaseData: r ? r.data : '',
    apertura: giorno(j.data_apertura), chiusura: giorno(j.data_chiusura), descrizione: (nota ? `${nota}: ` : '') + corto(j.descrizione, 200) };
}
function fattoMySupport(m, origine, nota = '') {
  return { codice: String(m.codice_quesito || '').trim(), sistema: 'MySupport', origine, stato: m.stato_finale || '', inCarico: m.operatore || '',
    versione: '', release: '', releaseData: '', apertura: giorno(m.data_apertura), chiusura: giorno(m.data_chiusura),
    descrizione: (nota ? `${nota}: ` : '') + corto([m.procedura, m.modulo].filter(Boolean).join(' · '), 160) };
}
function fattoQuotazione(q, rel, origine) {
  const r = releaseDi(q.versione_proposta, rel);
  return { codice: String(q.codice || '').trim(), sistema: 'Quotazione Jira', origine, stato: q.stato || '', inCarico: q.assegnatario || '',
    versione: q.versione_proposta || '', release: r ? r.release : '', releaseData: r ? r.data : '',
    apertura: giorno(q.data_richiesta), chiusura: '', descrizione: corto(q.descrizione, 200) };
}

function raccoltaTicket(d, rel) {
  const out = [];
  const visti = new Set();
  const add = (t) => { const k = `${t.sistema}|${t.codice}`; if (t.codice && !visti.has(k)) { visti.add(k); out.push(t); } };
  const mysupportDi = (codice) => d.mysupport.find((x) => String(x.codice_quesito || '').trim().toUpperCase() === String(codice).toUpperCase());
  const daMySupport = (m, origine, nota) => {
    add(fattoMySupport(m, origine, nota));
    for (const j of d.jira.filter((x) => codiciIn(x.ticket_correlati).includes(String(m.codice_quesito).trim().toUpperCase()))) {
      add(fattoJira(j, rel, origine, `collegato al MySupport ${m.codice_quesito}`));
    }
  };
  const daJira = (j, origine, nota) => {
    add(fattoJira(j, rel, origine, nota));
    for (const c of codiciIn(j.ticket_correlati)) { const m = mysupportDi(c); if (m) add(fattoMySupport(m, origine, `collegato a ${j.cod_task}`)); }
  };
  return { out, add, mysupportDi, daMySupport, daJira };
}

// Ticket citati nell'email, cercati SOLO tra quelli del cliente: chiavi Jira (ABC-123) e numeri
// MySupport (e i ticket collegati a loro).
function ticketCitati(testo, d, rel, raccolta) {
  const chiavi = [...new Set((testo.match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g) || []))].slice(0, 30);
  const numeri = [...new Set((testo.match(/\b\d{5,10}\b/g) || []))].slice(0, 60);
  for (const k of chiavi) {
    const j = d.jira.find((x) => String(x.cod_task || '').toUpperCase() === k);
    if (j) raccolta.daJira(j, 'citato');
    const q = d.quotazioni.find((x) => String(x.codice || '').toUpperCase() === k);
    if (q) raccolta.add(fattoQuotazione(q, rel, 'citato'));
    if (!j && !q) raccolta.add({ codice: k, sistema: 'Jira', origine: 'citato', nonTrovato: true });
  }
  for (const n of numeri) {
    const m = raccolta.mysupportDi(n);
    if (m) raccolta.daMySupport(m, 'citato');
  }
}

// ----------------------------------------------------------------------------
// RICERCA PER ARGOMENTO (2026-10-22, richiesta utente): l'analisi guarda TUTTI i dati del
// cliente dell'utente (tenant + utente + cliente) e prende i pezzi che parlano dello stesso
// problema dell'email: recap cliente, recap interno e trascrizioni delle riunioni del cliente
// (ultimi 18 mesi), task e quotazioni Jira, Issue, dati degli altri progetti del cliente.
// Punteggio: parole dell'email (radici di 6 lettere, senza parole vuote) presenti nel pezzo,
// pesate per rarità (le parole rare contano di più). Almeno 2 parole in comune, oppure una
// parola rara.
// ----------------------------------------------------------------------------
const PAROLE_VUOTE = new Set(('ciao buongiorno buonasera salve grazie saluti cordiali distinti tutti tutto tutte questa questo '
  + 'questi queste quello quella quelli quelle sono essere stato stata stati state come anche ancora sempre infatti pero perche '
  + 'quindi allora mentre dove quando quale quali della delle dello degli dalla dalle dallo dagli nella nelle nello negli sulla '
  + 'sulle sullo sugli alla alle allo agli fino verso dopo prima sopra sotto ogni altro altra altri altre loro nostro nostra '
  + 'vostro vostra suoi sue avere hanno abbiamo avete fare fatto fatta fanno viene vengono continua continuano permane buona '
  + 'giornata esempio aspetto messa disposizione indicato indicata indicazione correttamente problema problemi dati dato invece '
  + 'possibile possibili verificare verifica grazie ancora molto anche oggi domani ieri mail email allegato allegati riguardo '
  + 'quanto cosa cose essere potete potresti potrebbe sarebbe vorrei volevo chiedo chiedere sapere '
  // articoli e preposizioni apostrofati («dell'indicazione» -> dell)
  + 'dell sull nell dall quell coll dagl dall degl nell sull').split(' '));
const senzaAccenti = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
function termini(testo) {
  const out = new Set();
  for (const w of senzaAccenti(minuscola(testo)).match(/[a-z0-9]+/g) || []) {
    if (w.length < 4 || /^\d+$/.test(w) || PAROLE_VUOTE.has(w)) continue;
    out.add(w.length > 6 ? w.slice(0, 6) : w);
  }
  return out;
}
// Segna ogni pezzo con punti, parole trovate e ok (abbastanza pertinente). La rarità di una
// parola si misura DENTRO il gruppo passato (righe dei recap, pezzi di trascrizione, task
// Jira…): «qualifica» può essere comune nelle trascrizioni ma rara tra le righe dei recap.
// forti: parole dell'oggetto dell'email (riassume l'argomento), che pesano il doppio.
// soloDuePiu: almeno 2 parole in comune, senza l'eccezione della parola rara (ticket e Issue:
// da loro dipendono release e doppioni, serve precisione).
function valutaPertinenza(chiavi, pezzi, forti = new Set(), soloDuePiu = false) {
  const df = new Map();
  for (const p of pezzi) {
    p.t = termini(p.testo);
    for (const k of chiavi) if (p.t.has(k)) df.set(k, (df.get(k) || 0) + 1);
  }
  const n = pezzi.length || 1;
  for (const p of pezzi) {
    const trovate = [...chiavi].filter((k) => p.t.has(k));
    p.trovate = trovate;
    p.punti = trovate.reduce((s, k) => s + Math.log(1 + n / df.get(k)) * (forti.has(k) ? 2 : 1), 0);
    // Una sola parola basta se è specifica (almeno 5 lettere) e rara nel gruppo: al massimo 3
    // pezzi o il 3% del gruppo.
    p.ok = trovate.length >= 2
      || (!soloDuePiu && trovate.length === 1 && trovate[0].length >= 5 && df.get(trovate[0]) <= Math.max(3, Math.round(n * 0.03)));
    delete p.t;
  }
  return pezzi;
}
const migliori = (pezzi, tipi, max) => pezzi.filter((p) => p.ok && tipi.includes(p.tipo)).sort((a, b) => b.punti - a.punti).slice(0, max);

// Estratto leggibile: senza orari [hh:mm:ss] e codici HTML (&#39;), centrato sulla prima parola
// dell'email trovata nel pezzo invece che tagliato a caso.
const ENTITA_HTML = { '&#39;': "'", '&apos;': "'", '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
function estrattoPulito(testo, trovate = [], max = 320) {
  const t = String(testo || '').replace(/&#39;|&apos;|&quot;|&amp;|&lt;|&gt;|&nbsp;/g, (x) => ENTITA_HTML[x])
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const base = senzaAccenti(t.toLowerCase());
  const pos = trovate.map((k) => base.search(new RegExp(`\\b${k}`))).filter((i) => i >= 0);
  const centro = pos.length ? Math.min(...pos) : 0;
  const da = Math.max(0, Math.min(centro - Math.round(max / 3), t.length - max));
  return `${da > 0 ? '…' : ''}${t.slice(da, da + max).trim()}${da + max < t.length ? '…' : ''}`;
}

// Fonti per il pannello: UNA scheda per riunione (o per voce di registro), con al massimo 2
// estratti di tipo diverso. La pertinenza si confronta in proporzione al migliore del suo
// gruppo (i punteggi di trascrizioni, recap e registri non sono confrontabili) e a parità
// vengono prima attività e registri, poi recap, poi trascrizioni.
const PRIORITA_TIPO = (tipo) => (tipo === 'attività recap interno' ? 0 : TIPI_REGISTRO.includes(tipo) ? 1 : tipo === 'trascrizione' ? 3 : 2);
function fontiPerScheda(gruppi, max = 6) {
  const candidati = [];
  for (const g of gruppi) {
    const top = Math.max(1e-9, ...g.map((p) => p.punti));
    for (const p of g) candidati.push({ ...p, rel: p.punti / top });
  }
  candidati.sort((a, b) => (b.rel - a.rel) || (PRIORITA_TIPO(a.tipo) - PRIORITA_TIPO(b.tipo)));
  const schede = new Map();
  for (const p of candidati) {
    const chiave = p.oggetto ? `${p.data}|${p.oggetto}` : `${p.tipo}|${p.testo}`;
    let s = schede.get(chiave);
    if (!s) {
      if (schede.size >= max) continue;
      s = { data: p.data || '', oggetto: p.oggetto || '', tipi: [], estratti: [], rel: p.rel, prio: PRIORITA_TIPO(p.tipo) };
      schede.set(chiave, s);
    }
    if (s.estratti.length >= 2 || s.tipi.includes(p.tipo)) continue;
    s.tipi.push(p.tipo);
    s.estratti.push(estrattoPulito(p.tipo === 'trascrizione' ? p.testo : (p.estratto || p.testo), p.trovate));
    s.prio = Math.min(s.prio, PRIORITA_TIPO(p.tipo));
  }
  return [...schede.values()].sort((a, b) => (b.rel - a.rel) || (a.prio - b.prio))
    .map(({ data, oggetto, tipi, estratti }) => ({ data, oggetto, tipi, estratti, tipo: tipi[0], estratto: estratti[0] }));
}

// Riunioni del cliente dell'utente (recap, recap interno, trascrizione), ultimi 18 mesi.
async function riunioniCliente(tenantId, userId, clientId) {
  return righe(
    `SELECT id_calendar, project_id::text AS project_id, oggetto, data_calendar, recap, recap_interno, trascrizione
       FROM rec_meeting
      WHERE tenant_id = $1 AND user_id = $2 AND client_id::text = $3 AND data_calendar >= CURRENT_DATE - 540
      ORDER BY data_calendar DESC NULLS LAST, orario_calendar DESC NULLS LAST
      LIMIT 150`, [tenantId, userId, clientId]);
}

function pezziRiunioni(riunioni) {
  const pezzi = [];
  for (const m of riunioni) {
    const etichetta = `${giorno(m.data_calendar)} «${corto(m.oggetto || 'Riunione', 80)}»`;
    const base = { data: giorno(m.data_calendar), oggetto: corto(m.oggetto || 'Riunione', 120), projectId: m.project_id || null, etichetta };
    for (const [campo, tipo] of [['recap', 'recap cliente'], ['recap_interno', 'recap interno']]) {
      const righeTesto = String(m[campo] || '').split(/\r?\n/).map((r) => r.replace(/^[#*\s>-]+/, '').trim()).filter((r) => r.length >= 15);
      righeTesto.forEach((r, i) => {
        const vicine = [righeTesto[i - 1], r, righeTesto[i + 1]].filter(Boolean).join(' / ');
        pezzi.push({ ...base, tipo, testo: r, estratto: corto(vicine, 450) });
      });
    }
    const t = String(m.trascrizione || '');
    for (let i = 0; i < t.length; i += 450) {
      const pezzo = t.slice(i, i + 650);
      pezzi.push({ ...base, tipo: 'trascrizione', testo: pezzo, estratto: corto(pezzo, 650) });
    }
  }
  return pezzi;
}

// Registri del cliente dell'utente: attività del recap interno (rec_meeting_attivita, le righe
// «[Argomento] Descrizione» con owner e scadenza), To-Do, RAID, azioni a carico del cliente e
// Change Request. Un pezzo per riga.
const TIPI_REGISTRO = ['attività recap interno', 'To-Do', 'rischio', 'azione', 'issue RAID', 'decisione', 'dipendenza', 'assunzione', 'azione cliente', 'change request'];
async function pezziRegistri(tenantId, userId, clientId, riunioni) {
  const perCalendario = new Map(riunioni.map((m) => [m.id_calendar, m]));
  const ids = [...perCalendario.keys()].filter(Boolean);
  const p = [tenantId, userId, clientId];
  const [attivita, todo, raid, azioni, cr] = await Promise.all([
    ids.length ? righe(`SELECT id_calendar, argomento, descrizione, owner_nominativo, scadenza, completata FROM rec_meeting_attivita
                         WHERE tenant_id = $1 AND user_id = $2 AND id_calendar = ANY($3::text[])`, [tenantId, userId, ids]) : Promise.resolve([]),
    righe(`SELECT project_id::text AS project_id, titile, description, status, due_date, assigned_to_text FROM tasks
            WHERE tenant_id = $1 AND user_id = $2 AND client_id::text = $3 LIMIT 2000`, p),
    righe(`SELECT project_id::text AS project_id, tipo, titolo, descrizione, mitigazione, owner, stato, data_revisione FROM pm_raid
            WHERE tenant_id = $1 AND user_id = $2 AND client_id::text = $3 LIMIT 2000`, p),
    righe(`SELECT project_id::text AS project_id, referente, descrizione, stato, data_scadenza, note FROM pm_azioni_cliente
            WHERE tenant_id = $1 AND user_id = $2 AND client_id::text = $3 LIMIT 2000`, p),
    righe(`SELECT project_id::text AS project_id, codice, titolo, descrizione, stato, data_richiesta, rif_jira FROM pm_change_request
            WHERE tenant_id = $1 AND user_id = $2 AND client_id::text = $3 LIMIT 1000`, p)
  ]);
  const pezzi = [];
  for (const a of attivita) {
    const m = perCalendario.get(a.id_calendar) || {};
    const testo = `${a.argomento ? `[${a.argomento}] ` : ''}${a.descrizione || ''}`;
    pezzi.push({ tipo: 'attività recap interno', testo, data: giorno(m.data_calendar), oggetto: corto(m.oggetto || 'Riunione', 120), projectId: m.project_id || null,
      etichetta: `${giorno(m.data_calendar)} «${corto(m.oggetto || 'Riunione', 80)}»`,
      estratto: corto(`${testo}${a.owner_nominativo ? ` | owner ${a.owner_nominativo}` : ''}${a.scadenza ? ` | scadenza ${giorno(a.scadenza)}` : ''}${a.completata ? ' | completata' : ''}`, 450) });
  }
  const reg = (tipo, testo, extra, data, projectId) => pezzi.push({ tipo, testo, data, oggetto: '', projectId, etichetta: tipo, estratto: corto(`${testo}${extra}`, 450) });
  for (const t of todo) reg('To-Do', `${t.titile || ''} ${t.description || ''}`, ` | ${t.status || ''}${t.assigned_to_text ? ` | ${t.assigned_to_text}` : ''}${t.due_date ? ` | scadenza ${giorno(t.due_date)}` : ''}`, giorno(t.due_date), t.project_id);
  for (const r of raid) {
    const tipo = { rischio: 'rischio', azione: 'azione', issue: 'issue RAID', decisione: 'decisione', dipendenza: 'dipendenza', assunzione: 'assunzione' }[minuscola(r.tipo)] || 'rischio';
    reg(tipo, `${r.titolo || ''} ${r.descrizione || ''} ${r.mitigazione || ''}`, ` | ${r.stato || ''}${r.owner ? ` | owner ${r.owner}` : ''}`, giorno(r.data_revisione), r.project_id);
  }
  for (const a of azioni) reg('azione cliente', `${a.descrizione || ''} ${a.note || ''}`, ` | ${a.stato || ''}${a.referente ? ` | ${a.referente}` : ''}${a.data_scadenza ? ` | scadenza ${giorno(a.data_scadenza)}` : ''}`, giorno(a.data_scadenza), a.project_id);
  for (const c of cr) reg('change request', `${c.codice || ''} ${c.titolo || ''} ${c.descrizione || ''}`, ` | ${c.stato || ''}${c.rif_jira ? ` | Jira ${c.rif_jira}` : ''}`, giorno(c.data_richiesta), c.project_id);
  return pezzi;
}

const FORMATO_JSON = `

FORMATO DELLA RISPOSTA (obbligatorio)
Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, con questa struttura:
{
  "tipi": ["errore" | "stato_ticket" | "data_rilascio" | "informazioni" | "altro"],
  "sintesi": "2-4 frasi: che cosa chiede o segnala l'email",
  "segnalazioni": [{"descrizione": "problema distinto, breve e chiaro", "categoria": "Bug|Richiesta|Configurazione|Altro", "priorita": "Alta|Media|Bassa", "mysupport": "codice o stringa vuota", "jira": "codice o stringa vuota"}],
  "ticket": [{"codice": "codice del ticket citato", "risposta": "cosa rispondere su questo ticket, SOLO dai dati"}],
  "riunioni": "cosa è già stato detto o deciso nelle riunioni su questo argomento, con data (stringa vuota se nei PASSAGGI non c'è nulla di pertinente)",
  "release": "release e data di rilascio della correzione SOLO se ricavate dai TICKET COLLEGATI (stringa vuota se nessun ticket collegato ha una release)",
  "punti_attenzione": ["cose che il PM deve verificare prima di rispondere"],
  "azioni": [{"tipo": "rischio" | "dipendenza" | "todo" | "azione_cliente", "titolo": "breve", "descrizione": "contesto, con codici e date", "scadenza": "AAAA-MM-GG o stringa vuota", "owner": "chi la segue (nome) o stringa vuota", "mitigazione": "solo per i rischi, altrimenti stringa vuota"}],
  "risposta_email": "testo completo della bozza di risposta, senza oggetto"
}
"segnalazioni" è vuoto se l'email non segnala errori o malfunzionamenti. "azioni" è vuoto se l'email non porta impegni, scadenze o rischi da registrare (al massimo 5).`;

// Azioni proposte dall'AI (rischi, dipendenze, To-Do, azioni a carico del cliente): solo
// mostrate nel pannello; si registrano in Projexa quando il PM preme «Crea» (POST
// /lavori/:id/azioni/:n). n = posizione nell'elenco salvato nel risultato.
const TIPI_AZIONE = ['rischio', 'dipendenza', 'todo', 'azione_cliente'];
const MAX_AZIONI = 5;
function dataValida(v) {
  const s = String(v || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(`${s}T00:00:00Z`);
  const anno = Number(s.slice(0, 4));
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s || anno < 2000 || anno > 2100 ? '' : s;
}
function azioniProposte(lista) {
  return (Array.isArray(lista) ? lista : [])
    .map((a) => ({
      tipo: voce(a && a.tipo, TIPI_AZIONE, ''), titolo: corto(a && a.titolo, 300), descrizione: corto(a && a.descrizione, 1500),
      scadenza: dataValida(a && a.scadenza), owner: corto(a && a.owner, 200), mitigazione: corto(a && a.mitigazione, 1000)
    }))
    .filter((a) => a.tipo && a.titolo.length >= 5)
    .slice(0, MAX_AZIONI)
    .map((a, n) => ({ ...a, n, mitigazione: a.tipo === 'rischio' ? a.mitigazione : '' }));
}

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
    const trovato = await trovaCliente(user, email, { daTesto: true });
    if (!trovato) {
      // Il PM sceglie il cliente nel pannello e rianalizza (clientId).
      const clienti = (await clientiUtente(user)).clienti.filter((c) => c.aperto && c.tenant_id === user.tenant_id)
        .map((c) => ({ id: c.id, nome: String(c.nome || '').trim() })).filter((c) => c.nome)
        .sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
      return res.json({ ...base, esito: 'cliente_non_trovato', clienti,
        messaggio: 'Né gli indirizzi (contatti e stakeholder dei tuoi clienti) né i ticket o i nomi scritti nell\'email portano a un solo cliente. Scegli il cliente qui sotto, oppure aggiungi il contatto alla scheda del cliente in Projexa.' });
    }
    const u = { ...user, tenant_id: trovato.tenantId };
    const progetti = (await progettiAperti(u).catch(() => [])).filter((p) => p.clientId === trovato.clientId)
      .map((p) => ({ id: p.projectId, nome: p.nome }));
    const [dati, release, riunioni] = await Promise.all([
      datiCliente(trovato.tenantId, trovato.clientId),
      releaseTenant(trovato.tenantId),
      riunioniCliente(trovato.tenantId, user.user_id, trovato.clientId)
    ]);

    // Ricerca per argomento su riunioni, task/quotazioni Jira e Issue del cliente. I nomi di chi
    // scrive e dell'utente non sono parole chiave: compaiono in quasi tutte le riunioni.
    const nomeUtente = (await righe('SELECT name, cognome FROM users WHERE id = $1', [user.user_id])).map((x) => [x.name, x.cognome].filter(Boolean).join(' '))[0] || '';
    const chiavi = termini(`${email.oggetto}\n${email.testo}`);
    for (const k of termini(`${email.mittente.nome} ${email.mittente.email.split('@')[0].replace(/[._-]+/g, ' ')} ${nomeUtente}`)) chiavi.delete(k);
    const forti = new Set([...termini(email.oggetto)].filter((k) => chiavi.has(k)));
    const pezziR = pezziRiunioni(riunioni);
    const pezzi = [
      ...valutaPertinenza(chiavi, await pezziRegistri(trovato.tenantId, user.user_id, trovato.clientId, riunioni), forti),
      ...valutaPertinenza(chiavi, pezziR.filter((p) => p.tipo !== 'trascrizione'), forti),
      ...valutaPertinenza(chiavi, pezziR.filter((p) => p.tipo === 'trascrizione'), forti),
      ...valutaPertinenza(chiavi, dati.jira.map((x) => ({ tipo: 'jira', testo: `${x.cod_task || ''} ${x.tipo || ''} ${x.descrizione || ''}`, ref: x })), forti, true),
      ...valutaPertinenza(chiavi, dati.quotazioni.map((x) => ({ tipo: 'quotazione', testo: `${x.codice || ''} ${x.descrizione || ''}`, ref: x })), forti, true),
      ...valutaPertinenza(chiavi, dati.issue.map((x) => ({ tipo: 'issue', testo: `${x.descrizione || ''}`, ref: x })), forti, true)
    ];
    const daRiunioni = migliori(pezzi, ['recap cliente', 'recap interno'], 14);
    const daTrascrizioni = migliori(pezzi, ['trascrizione'], 5);
    const daRegistri = migliori(pezzi, TIPI_REGISTRO, 12);
    // Progetto: riunioni e registri pertinenti votano per il loro progetto.
    const voti = new Map();
    for (const p of [...daRiunioni, ...daTrascrizioni, ...daRegistri]) if (p.projectId) voti.set(p.projectId, (voti.get(p.projectId) || 0) + p.punti);
    const progetto = scegliProgetto(progetti, email, trovato, voti);

    // Ticket: citati nell'email + collegati per argomento (task Jira, quotazioni e Issue simili).
    const raccolta = raccoltaTicket(dati, release);
    ticketCitati(`${email.oggetto}\n${email.testo}`, dati, release, raccolta);
    for (const p of migliori(pezzi, ['jira'], 5)) raccolta.daJira(p.ref, 'argomento', `stesso argomento (${p.trovate.slice(0, 4).join(', ')})`);
    for (const p of migliori(pezzi, ['quotazione'], 3)) raccolta.add(fattoQuotazione(p.ref, release, 'argomento'));
    const issueSimili = migliori(pezzi, ['issue'], 5);
    for (const p of issueSimili) {
      for (const c of codiciIn(p.ref.mysupport)) { const m = raccolta.mysupportDi(c); if (m) raccolta.daMySupport(m, 'argomento', 'dalla Issue simile'); }
      for (const c of codiciIn(p.ref.tkt_jira)) { const j = dati.jira.find((x) => String(x.cod_task || '').toUpperCase() === c); if (j) raccolta.daJira(j, 'argomento', 'dalla Issue simile'); }
    }
    const ticket = raccolta.out.slice(0, 25);

    // Contesto: progetto scelto completo; degli altri progetti del cliente solo le righe pertinenti.
    const contesto = progetto ? await contestoProgetto(u, progetto.id, { riunioni: 3, maxRecap: 3000 }).then((c) => c.testo).catch(() => '') : '';
    const altri = [];
    for (const p of progetti.filter((x) => !progetto || x.id !== progetto.id).slice(0, 4)) {
      const t = await contestoProgetto(u, p.id, { riunioni: 0 }).then((c) => c.testo).catch(() => '');
      for (const riga of t.split('\n')) if (riga.trim().length >= 15) altri.push({ tipo: 'progetto', testo: riga, etichetta: p.nome });
    }
    const righeAltri = migliori(valutaPertinenza(chiavi, altri), ['progetto'], 10);
    // Ultimi recap del cliente (anche di altri progetti), completi: il contesto più recente.
    const ultimiRecap = riunioni.filter((m) => String(m.recap || '').trim()).slice(0, 2);

    const testoCorrelati = [
      'PASSAGGI SULLO STESSO ARGOMENTO DALLE RIUNIONI DEL CLIENTE (recap e recap interno, dal più pertinente)',
      daRiunioni.length ? daRiunioni.map((p) => `- ${p.etichetta} [${p.tipo}]: ${p.estratto}`).join('\n') : '(nessuno)',
      '',
      'ATTIVITÀ DEL RECAP INTERNO, TO-DO, RAID, AZIONI DEL CLIENTE E CHANGE REQUEST SULLO STESSO ARGOMENTO',
      daRegistri.length ? daRegistri.map((p) => `- ${p.tipo}${p.data ? ` (${p.data})` : ''}${p.oggetto ? ` «${p.oggetto}»` : ''}: ${p.estratto}`).join('\n') : '(nessuno)',
      '',
      'PASSAGGI SULLO STESSO ARGOMENTO DALLE TRASCRIZIONI DELLE RIUNIONI DEL CLIENTE',
      daTrascrizioni.length ? daTrascrizioni.map((p) => `- ${p.etichetta}: «${estrattoPulito(p.testo, p.trovate, 650)}»`).join('\n') : '(nessuno)',
      '',
      'ISSUE DEL CLIENTE SULLO STESSO ARGOMENTO',
      issueSimili.length ? issueSimili.map((p) => `- ${giorno(p.ref.data_segnalazione)} [${p.ref.stato}] ${corto(p.ref.descrizione, 300)}${p.ref.mysupport ? ` | MySupport ${p.ref.mysupport}` : ''}${p.ref.tkt_jira ? ` | Jira ${p.ref.tkt_jira}` : ''}`).join('\n') : '(nessuna)',
      '',
      'ALTRI PROGETTI DEL CLIENTE: RIGHE SULLO STESSO ARGOMENTO',
      righeAltri.length ? righeAltri.map((p) => `- [${p.etichetta}] ${corto(p.testo, 300)}`).join('\n') : '(nessuna)',
      '',
      'ULTIMI RECAP DEL CLIENTE (completi)',
      ultimiRecap.length ? ultimiRecap.map((m) => `--- ${giorno(m.data_calendar)} «${corto(m.oggetto || 'Riunione', 80)}»\n${String(m.recap).slice(0, 3000)}`).join('\n\n') : '(nessuno)'
    ].join('\n');
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
      ? ticket.map((t) => (t.nonTrovato ? `- ${t.codice} (${t.sistema}, citato nell'email): NON presente tra i ticket di questo cliente in Projexa`
        : `- ${t.codice} (${t.sistema}, ${t.origine === 'citato' ? 'citato nell\'email' : 'stesso argomento'}) | stato: ${t.stato || '-'} | in carico: ${t.inCarico || '-'} | versione: ${t.versione || 'non indicata'}${t.release ? ` | release ${t.release} del ${t.releaseData}` : ''} | aperto ${t.apertura || '-'}${t.chiusura ? ` | chiuso ${t.chiusura}` : ''}${t.descrizione ? ` | ${t.descrizione}` : ''}`)).join('\n')
      : '(nessun ticket citato nell\'email né sullo stesso argomento tra quelli del cliente)';
    // Release solo dai ticket collegati; il calendario completo serve solo se l'email chiede
    // esplicitamente quando esce la prossima release.
    const releaseCollegate = ticket.filter((t) => t.release).map((t) => `- ${t.codice}: release ${t.release} del ${t.releaseData}`);
    const prossime = release.filter((r) => r.futura).slice(0, 3).map((r) => `${r.release} (${r.data})`).join(', ');
    const testoRelease = [
      releaseCollegate.length ? `Release dei ticket collegati:\n${releaseCollegate.join('\n')}` : 'Nessun ticket collegato ha una release: NON indicare date di rilascio.',
      prossime ? `Calendario (usalo SOLO se l'email chiede esplicitamente quando esce la prossima release): ${prossime}` : ''
    ].filter(Boolean).join('\n');
    const tpl = (await getPromptFor('OUTLOOK_ANALISI', u)).testo;
    const tipoEmail = trovato.interna
      ? `EMAIL INTERNA: scambio tra colleghi (nessun indirizzo del cliente). Il cliente ${trovato.nome} è stato ricavato da: ${trovato.motivo || (trovato.come === 'scelto' ? 'scelta del PM' : `indirizzo ${trovato.indirizzo}`)}. La bozza è per i colleghi, non per il cliente.`
      : `EMAIL CON IL CLIENTE: almeno un indirizzo è del cliente o di un esterno. La bozza è per il cliente.`;
    const valori = {
      EMAIL: testoEmail, CLIENTE: trovato.nome || '', PROGETTO: progetto ? progetto.nome : 'non determinato (tema del cliente)', TICKET: testoTicket,
      RELEASE: testoRelease, CORRELATI: testoCorrelati, DATA: dataIt(oggiIso()), UTENTE: nomeUtente || 'il project manager', TIPO_EMAIL: tipoEmail
    };
    const datiTesto = [contesto ? `${contesto}\n` : '', testoDatiCliente(dati)].join('\n');
    const build = (d) => {
      let testo = tpl.includes('{{DATI}}') ? tpl : `${tpl}\n\nDATI\n{{DATI}}`;
      // Prompt salvato prima del 22/10 (senza {{CORRELATI}} o {{TIPO_EMAIL}}): in coda.
      if (!testo.includes('{{CORRELATI}}')) testo += '\n\nPASSAGGI DI PROJEXA SULLO STESSO ARGOMENTO\n{{CORRELATI}}';
      if (!testo.includes('{{TIPO_EMAIL}}')) testo += '\n\nTIPO DI EMAIL\n{{TIPO_EMAIL}}';
      return testo.replace(/\{\{(EMAIL|CLIENTE|PROGETTO|TICKET|RELEASE|CORRELATI|DATA|UTENTE|TIPO_EMAIL|DATI)\}\}/g, (x, k) => (k === 'DATI' ? d : valori[k])) + FORMATO_JSON;
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
    // Email tra colleghi: nessuna Issue automatica (il problema lo segnala il cliente, non un
    // collega): le segnalazioni si mostrano e basta.
    const esitiIssue = !segnalazioni.length ? []
      : trovato.interna ? segnalazioni.map((s) => ({ ...s, esito: 'interna' }))
        : await creaIssue(user, ctx, segnalazioni);
    const azioni = azioniProposte(j.azioni);
    const risposteTicket = new Map((Array.isArray(j.ticket) ? j.ticket : []).slice(0, 30)
      .map((t) => [String(t && t.codice || '').trim().toUpperCase(), corto(t && t.risposta, 600)]));

    res.json({
      ...base, esito: 'ok', interna: !!trovato.interna,
      cliente: { id: trovato.clientId, nome: trovato.nome, come: trovato.come, indirizzo: trovato.indirizzo, contatto: trovato.contatto || '', motivo: trovato.motivo || '' },
      progetto, progetti, azioni,
      tipi: (Array.isArray(j.tipi) ? j.tipi : []).map((t) => minuscola(t)).filter((t) => TIPI.includes(t)).slice(0, 5),
      sintesi: corto(j.sintesi, 1500),
      segnalazioni: esitiIssue,
      ticket: ticket.map((t) => ({ ...t, risposta: risposteTicket.get(String(t.codice).toUpperCase()) || '' })),
      // Release solo se un ticket collegato ne ha una (niente calendario generico).
      release: releaseCollegate.length ? corto(j.release, 800) : '',
      riunioni: corto(j.riunioni, 1500),
      riunioniCorrelate: fontiPerScheda([daRegistri, daRiunioni, daTrascrizioni], 6),
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
