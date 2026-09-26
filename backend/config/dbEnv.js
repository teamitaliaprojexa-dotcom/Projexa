// Scelta del database: produzione o staging.
//
// APP_ENV=staging  -> i pool usano i branch Neon di staging (variabili STAGING_*).
// altrimenti       -> i normali URL di produzione, come prima.
//
// In staging, se un STAGING_<NAME> non è impostato si usa l'URL di produzione, ma con un
// AVVISO ben visibile nel log che nomina quel database: così sai sempre quali pool stanno
// puntando alla produzione (per ora Licen e Notif, che la trascrizione non tocca).
import dotenv from 'dotenv';

dotenv.config();

export const IS_STAGING = String(process.env.APP_ENV || '').toLowerCase() === 'staging';
const onProd = [];

export function resolveDbUrl(name) {
  if (!IS_STAGING) return process.env[name];
  const staging = process.env['STAGING_' + name];
  if (staging && staging.trim()) return staging;
  if (!onProd.includes(name)) {
    onProd.push(name);
    console.warn(`⚠️  APP_ENV=staging ma STAGING_${name} è vuota: questo database resta sulla PRODUZIONE. Attenzione alle scritture.`);
  }
  return process.env[name];
}

if (IS_STAGING) {
  console.log('🧪 APP_ENV=staging: dove impostati (STAGING_*) si usano i branch di staging, non la produzione.');
}
