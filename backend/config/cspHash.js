// Impronte (sha256) degli script inline delle pagine di Projexa, per la Content-Security-Policy
// (2026-10-17). Con le impronte in script-src il browser esegue SOLO gli script inline scritti
// nelle pagine di sito/: uno script iniettato (XSS) ha un'impronta diversa e viene bloccato.
// Per questo 'unsafe-inline' è stato tolto da script-src. Gli attributi onclick="..." non sono
// più ammessi: i pulsanti usano data-click (sito/js/azioni.js).
//
// Le impronte si ricalcolano quando cambia una pagina (data di modifica dei file), così una
// pagina modificata senza riavviare il server funziona lo stesso. Il browser calcola
// l'impronta sul testo dello script con i fine riga normalizzati a \n (parser HTML).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

let cache = { firma: '', valori: [], controllo: 0 };
const RICONTROLLO_MS = 5000; // date dei file riguardate al massimo ogni 5 secondi

function pagine(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.html')).map((f) => path.join(dir, f));
  } catch (e) {
    return [];
  }
}

// Elenco delle sorgenti 'sha256-…' per script-src.
export function impronteScriptInline(sitoPath) {
  // Emergenza: CSP_UNSAFE_INLINE=true nel .env riammette tutti gli script inline (come prima).
  if (process.env.CSP_UNSAFE_INLINE === 'true') return ["'unsafe-inline'"];
  if (cache.firma && Date.now() - cache.controllo < RICONTROLLO_MS) return cache.valori;
  cache.controllo = Date.now();
  const file = pagine(sitoPath);
  const firma = file.map((f) => { try { return `${f}:${fs.statSync(f).mtimeMs}`; } catch (e) { return f; } }).join('|');
  if (firma === cache.firma) return cache.valori;
  const valori = new Set();
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi;
  for (const f of file) {
    let html;
    try { html = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const m of html.matchAll(re)) {
      const attr = m[1] || '';
      if (/\ssrc\s*=/i.test(attr)) continue;                       // script esterno: vale l'origine
      if (/type\s*=\s*["']?application\/(ld\+)?json/i.test(attr)) continue; // dati, non codice
      const testo = m[2].replace(/\r\n?/g, '\n');
      valori.add(`'sha256-${crypto.createHash('sha256').update(testo, 'utf8').digest('base64')}'`);
    }
  }
  cache = { firma, valori: [...valori], controllo: Date.now() };
  return cache.valori;
}
