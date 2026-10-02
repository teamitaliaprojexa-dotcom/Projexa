import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import { registraEmail } from './audit.js';

dotenv.config();

// Invio email via SMTP Gmail. Richiede una "App Password" (con 2FA attivo) dell'account
// team.italia.projexa@gmail.com, impostata in GMAIL_APP_PASSWORD. GMAIL_USER opzionale.
const GMAIL_USER = process.env.GMAIL_USER || 'team.italia.projexa@gmail.com';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

let transporter = null;
if (GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // SSL
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });
} else {
  console.warn('⚠️  GMAIL_APP_PASSWORD non impostata: l\'invio email è disabilitato (le registrazioni non invieranno l\'email di conferma).');
}

// Casella del team Projexa (mittente di tutte le email e destinataria delle richieste privacy).
export const EMAIL_PROJEXA = GMAIL_USER;

export function isMailerConfigured() {
  return !!transporter;
}

// log (facoltativo) = { req, tipo, userId, tenantId }: l'invio, riuscito o no, viene
// registrato nel log email (config/audit.js -> Oracle LOG_EMAIL), senza il testo.
export async function sendMail({ to, subject, html, text, log = null }) {
  const traccia = (esito, errore = null) => {
    if (!log) return;
    registraEmail(log.req, {
      tipo: log.tipo, modalita: 'server', esito, a: to, mittente: GMAIL_USER, oggetto: subject,
      servizio: 'gmail_smtp', errore, userId: log.userId, tenantId: log.tenantId
    });
  };
  if (!transporter) {
    traccia('ko', 'Email non configurata sul server');
    throw new Error('Email non configurata (GMAIL_APP_PASSWORD mancante).');
  }
  try {
    const info = await transporter.sendMail({
      from: `Team Projexa <${GMAIL_USER}>`,
      to, subject, html, text
    });
    traccia('ok');
    return info;
  } catch (e) {
    traccia('ko', e.message);
    throw e;
  }
}

// Costruisce l'HTML dell'email di conferma iscrizione con il pulsante "Conferma iscrizione".
export function buildConfirmEmail({ nome, confirmUrl }) {
  const saluto = nome ? `Ciao ${nome},` : 'Ciao,';
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif; max-width:520px; margin:0 auto; color:#111827;">
    <div style="text-align:center; padding:16px 0;">
      <div style="font-size:22px; font-weight:700; color:#059669;">Projexa</div>
    </div>
    <div style="background:#ffffff; border:1px solid #E5E7EB; border-radius:12px; padding:24px;">
      <p>${saluto}</p>
      <p>Il <strong>team Projexa</strong> ti ringrazia per esserti iscritto. 🎉</p>
      <p>Per <strong>completare l'iscrizione</strong> e attivare la tua prova gratuita di 1 mese, clicca sul pulsante qui sotto:</p>
      <div style="text-align:center; margin:28px 0;">
        <a href="${confirmUrl}" style="background:#10B981; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:700; display:inline-block;">Conferma iscrizione</a>
      </div>
      <p style="font-size:13px; color:#6B7280;">Se il pulsante non funziona, copia e incolla questo link nel browser:<br>
      <a href="${confirmUrl}" style="color:#059669; word-break:break-all;">${confirmUrl}</a></p>
      <p style="font-size:13px; color:#6B7280;">Se non hai richiesto tu questa iscrizione, ignora questa email.</p>
    </div>
    <p style="text-align:center; font-size:12px; color:#9CA3AF; margin-top:16px;">© Projexa</p>
  </div>`;
  const text = `${saluto}\n\nIl team Projexa ti ringrazia per esserti iscritto.\nPer completare l'iscrizione e attivare la prova gratuita di 1 mese, apri questo link:\n${confirmUrl}\n\nSe non hai richiesto tu questa iscrizione, ignora questa email.`;
  return { html, text };
}

// Costruisce l'HTML dell'email di reimpostazione password ("Password dimenticata").
// Il link porta a reset-password.html con un token a scadenza breve.
export function buildResetPasswordEmail({ nome, resetUrl, validHours = 1 }) {
  const saluto = nome ? `Ciao ${nome},` : 'Ciao,';
  const durata = validHours === 1 ? '1 ora' : `${validHours} ore`;
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif; max-width:520px; margin:0 auto; color:#111827;">
    <div style="text-align:center; padding:16px 0;">
      <div style="font-size:22px; font-weight:700; color:#059669;">Projexa</div>
    </div>
    <div style="background:#ffffff; border:1px solid #E5E7EB; border-radius:12px; padding:24px;">
      <p>${saluto}</p>
      <p>Abbiamo ricevuto una richiesta di <strong>reimpostazione della password</strong> del tuo account Projexa.</p>
      <p>Clicca sul pulsante qui sotto per scegliere una nuova password:</p>
      <div style="text-align:center; margin:28px 0;">
        <a href="${resetUrl}" style="background:#10B981; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:700; display:inline-block;">Imposta nuova password</a>
      </div>
      <p style="font-size:13px; color:#6B7280;">Se il pulsante non funziona, copia e incolla questo link nel browser:<br>
      <a href="${resetUrl}" style="color:#059669; word-break:break-all;">${resetUrl}</a></p>
      <p style="font-size:13px; color:#6B7280;">Il link è valido per <strong>${durata}</strong> e può essere usato una sola volta.</p>
      <p style="font-size:13px; color:#6B7280;">Se non hai richiesto tu il cambio password, ignora questa email: la tua password attuale resta valida.</p>
    </div>
    <p style="text-align:center; font-size:12px; color:#9CA3AF; margin-top:16px;">© Projexa</p>
  </div>`;
  const text = `${saluto}\n\nAbbiamo ricevuto una richiesta di reimpostazione della password del tuo account Projexa.\nApri questo link per scegliere una nuova password:\n${resetUrl}\n\nIl link è valido per ${durata} e può essere usato una sola volta.\nSe non hai richiesto tu il cambio password, ignora questa email.`;
  return { html, text };
}

// Costruisce l'email del "Magic link": accesso a Projexa senza password.
// Il link porta a magic-link.html con un token valido pochi secondi e monouso.
export function buildMagicLinkEmail({ nome, magicUrl, validSeconds = 60 }) {
  const saluto = nome ? `Ciao ${nome},` : 'Ciao,';
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif; max-width:520px; margin:0 auto; color:#111827;">
    <div style="text-align:center; padding:16px 0;">
      <div style="font-size:22px; font-weight:700; color:#059669;">Projexa</div>
    </div>
    <div style="background:#ffffff; border:1px solid #E5E7EB; border-radius:12px; padding:24px;">
      <p>${saluto}</p>
      <p>Ecco il tuo <strong>link di accesso</strong> a Projexa. Clicca sul pulsante per entrare senza password:</p>
      <div style="text-align:center; margin:28px 0;">
        <a href="${magicUrl}" style="background:#10B981; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:700; display:inline-block;">Accedi a Projexa</a>
      </div>
      <p style="font-size:13px; color:#6B7280;">Se il pulsante non funziona, copia e incolla questo link nel browser:<br>
      <a href="${magicUrl}" style="color:#059669; word-break:break-all;">${magicUrl}</a></p>
      <p style="font-size:13px; color:#6B7280;">Il link è valido per <strong>${validSeconds} secondi</strong> e può essere usato una sola volta. Se è scaduto, richiedine uno nuovo dalla pagina di accesso.</p>
      <p style="font-size:13px; color:#6B7280;">Se non hai richiesto tu l'accesso, ignora questa email: nessuno può entrare senza aprire questo link.</p>
    </div>
    <p style="text-align:center; font-size:12px; color:#9CA3AF; margin-top:16px;">© Projexa</p>
  </div>`;
  const text = `${saluto}\n\nEcco il tuo link di accesso a Projexa (senza password):\n${magicUrl}\n\nIl link è valido per ${validSeconds} secondi e può essere usato una sola volta.\nSe non hai richiesto tu l'accesso, ignora questa email.`;
  return { html, text };
}

// Richiesta di cancellazione dell'account (Privacy e dati personali, art. 17 GDPR): email
// da Projexa a Projexa, gestita a mano dal team entro 30 giorni.
export function buildRichiestaCancellazioneEmail({ nome, email, tenant, userId, tenantId, motivo, quando }) {
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const righe = [
    ['Utente', nome || '—'], ['Email', email || '—'], ['Spazio di lavoro', tenant || '—'],
    ['ID utente', userId], ['ID tenant', tenantId || '—'], ['Data richiesta', quando]
  ];
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif; max-width:560px; margin:0 auto; color:#111827;">
    <div style="text-align:center; padding:16px 0;"><div style="font-size:22px; font-weight:700; color:#059669;">Projexa</div></div>
    <div style="background:#ffffff; border:1px solid #E5E7EB; border-radius:12px; padding:24px;">
      <p style="font-size:16px; font-weight:700; margin-top:0;">Richiesta di cancellazione dell'account (art. 17 GDPR)</p>
      <p>Un utente ha chiesto la cancellazione del proprio account dalla dashboard (Privacy e dati personali). Va gestita <strong>entro 30 giorni</strong> dalla richiesta.</p>
      <table style="border-collapse:collapse; width:100%; font-size:14px;">
        ${righe.map(([k, v]) => `<tr><td style="padding:6px 8px; border-bottom:1px solid #F3F4F6; color:#6B7280; width:38%;">${e(k)}</td><td style="padding:6px 8px; border-bottom:1px solid #F3F4F6;">${e(v)}</td></tr>`).join('')}
      </table>
      <p style="margin-bottom:4px;"><strong>Motivo / note dell'utente:</strong></p>
      <p style="white-space:pre-line; background:#F9FAFB; border-radius:8px; padding:10px; margin-top:0;">${e(motivo || 'nessuna nota')}</p>
      <p style="font-size:13px; color:#6B7280;">Prima di cancellare, verificare con l'azienda (spazio di lavoro) quali dati appartengono all'organizzazione e vanno conservati.</p>
    </div>
  </div>`;
  const text = 'Richiesta di cancellazione dell\'account (art. 17 GDPR) - da gestire entro 30 giorni\n\n' +
    righe.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\nMotivo / note: ${motivo || 'nessuna nota'}`;
  return { html, text };
}
