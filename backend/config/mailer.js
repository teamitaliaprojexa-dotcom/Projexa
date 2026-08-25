import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

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

export function isMailerConfigured() {
  return !!transporter;
}

export async function sendMail({ to, subject, html, text }) {
  if (!transporter) throw new Error('Email non configurata (GMAIL_APP_PASSWORD mancante).');
  return transporter.sendMail({
    from: `Team Projexa <${GMAIL_USER}>`,
    to, subject, html, text
  });
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
