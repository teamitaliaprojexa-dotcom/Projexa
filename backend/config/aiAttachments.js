// === ALLEGATI DELLA FINESTRA AI (ingresso) E FILE DA SCARICARE (uscita) ===
//
// Nessun salvataggio: i file arrivano dal browser in base64 dentro la richiesta, restano
// solo in memoria per il tempo della chiamata al fornitore AI e poi vengono scartati.
// Anche i file da scaricare (Word, PDF, Excel, testo) vengono generati al volo dal testo
// della risposta e rispediti al browser, senza passare da disco o database.
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } from 'docx';

export const MAX_FILES = 5;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;   // somma degli allegati (il JSON base64 resta sotto i 15 MB del server)
const MAX_TEXT_CHARS = 300000;                        // testo estratto da tutti i file insieme

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const TEXT_EXT = new Set(['txt', 'csv', 'tsv', 'md', 'json', 'vtt', 'srt', 'xml', 'html', 'htm', 'log', 'sql', 'js', 'ts', 'py', 'css', 'yaml', 'yml', 'ini']);
export const ACCEPTED_EXT = [...Object.keys(IMAGE_TYPES), 'pdf', 'docx', 'xlsx', ...TEXT_EXT];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

async function xlsxToText(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  wb.eachSheet((sheet) => {
    out.push(`[Foglio: ${sheet.name}]`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = (row.values || []).slice(1).map((v) => {
        if (v == null) return '';
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === 'object') return v.text ?? v.result ?? (v.richText ? v.richText.map((r) => r.text).join('') : '');
        return String(v);
      });
      out.push(cells.join('\t'));
    });
  });
  return out.join('\n');
}

// Converte i file ricevuti dal browser ({ name, data: base64 }) in allegati normalizzati:
//   { kind: 'image' | 'pdf', name, mime, data }   -> passati al fornitore così come sono
//   { kind: 'text', name, text }                  -> Word/Excel/testo: si invia il contenuto
// Il tipo viene deciso dall'estensione e verificato sul contenuto, non dal browser.
export async function prepareAttachments(files) {
  if (files == null) return [];
  if (!Array.isArray(files)) throw httpError(400, 'Allegati non validi');
  if (files.length > MAX_FILES) throw httpError(400, `Massimo ${MAX_FILES} allegati per richiesta`);
  let total = 0;
  let textChars = 0;
  const out = [];
  for (const f of files) {
    const name = String((f && f.name) || 'file').replace(/[\r\n]/g, ' ').slice(0, 200);
    const ext = extOf(name);
    const buffer = Buffer.from(String((f && f.data) || ''), 'base64');
    if (!buffer.length) throw httpError(400, `Il file "${name}" è vuoto`);
    total += buffer.length;
    if (total > MAX_TOTAL_BYTES) throw httpError(413, `Allegati troppo grandi (massimo ${MAX_TOTAL_BYTES / 1024 / 1024} MB in tutto)`);

    if (IMAGE_TYPES[ext]) {
      out.push({ kind: 'image', name, mime: IMAGE_TYPES[ext], data: buffer.toString('base64') });
      continue;
    }
    if (ext === 'pdf') {
      if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw httpError(400, `Il file "${name}" non è un PDF valido`);
      out.push({ kind: 'pdf', name, mime: 'application/pdf', data: buffer.toString('base64'), buffer });
      continue;
    }
    let text;
    try {
      if (ext === 'docx') text = (await mammoth.extractRawText({ buffer })).value;
      else if (ext === 'xlsx') text = await xlsxToText(buffer);
      else if (TEXT_EXT.has(ext)) text = buffer.toString('utf8').replace(/^﻿/, '');
      else throw httpError(415, `Tipo di file non supportato: "${name}" (ammessi: ${ACCEPTED_EXT.join(', ')})`);
    } catch (error) {
      if (error.status) throw error;
      throw httpError(400, `Impossibile leggere il file "${name}": ${error.message}`);
    }
    text = String(text || '').trim();
    const room = MAX_TEXT_CHARS - textChars;
    if (room <= 0) throw httpError(413, 'Il testo degli allegati è troppo lungo: riduci il numero o la dimensione dei file');
    if (text.length > room) text = text.slice(0, room) + '\n[... contenuto troncato per lunghezza ...]';
    textChars += text.length;
    out.push({ kind: 'text', name, text });
  }
  return out;
}

// Testo dei PDF per i fornitori che non li leggono direttamente (Mistral).
export async function pdfToText(att) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(att.buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return String(text || '').trim();
}

// Blocchi di testo dei file (Word, Excel, testo) da mettere prima della richiesta.
export function attachmentsText(atts) {
  return atts.filter((a) => a.kind === 'text')
    .map((a) => `--- Inizio file allegato: ${a.name} ---\n${a.text}\n--- Fine file allegato: ${a.name} ---`)
    .join('\n\n');
}

// ==========================================
// FILE DA SCARICARE (risposta dell'AI)
// ==========================================

// Righe della risposta classificate: titoli (#), elenchi (- * • 1.) con rientro, testo.
function parseLines(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n').map((raw) => {
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) return { type: 'heading', level: heading[1].length, text: heading[2] };
    const bullet = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(raw);
    if (bullet) return { type: 'bullet', level: Math.min(Math.floor(bullet[1].replace(/\t/g, '  ').length / 2), 5), marker: bullet[2], text: bullet[3] };
    return { type: 'text', text: raw };
  });
}

// **grassetto** -> segmenti { text, bold }
function inlineRuns(text) {
  return String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean)
    .map((part) => (/^\*\*[^*]+\*\*$/.test(part) ? { text: part.slice(2, -2), bold: true } : { text: part, bold: false }));
}

// Tabelle in formato Markdown (| a | b |) presenti nella risposta.
function markdownTables(text) {
  const tables = [];
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/\*\*/g, ''));
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // riga di separazione |---|
      if (!current) { current = []; tables.push(current); }
      current.push(cells);
    } else {
      current = null;
    }
  }
  return tables;
}

async function buildDocx(text, title) {
  const headingLevels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  let tableRows = null;
  const flushTable = () => {
    if (!tableRows) return;
    const width = Math.max(...tableRows.map((r) => r.length));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: tableRows.map((cells, i) => new TableRow({
        tableHeader: i === 0,
        children: Array.from({ length: width }, (_, c) => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: cells[c] || '', bold: i === 0 })] })]
        }))
      }))
    }));
    children.push(new Paragraph({ text: '' }));
    tableRows = null;
  };
  for (const line of parseLines(text)) {
    // Righe di tabella Markdown (| a | b |) -> tabella Word.
    if (line.type === 'text' && /^\s*\|.*\|\s*$/.test(line.text)) {
      const cells = line.text.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/\*\*/g, ''));
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) (tableRows || (tableRows = [])).push(cells);
      continue;
    }
    flushTable();
    const runs = inlineRuns(line.text).map((r) => new TextRun({ text: r.text, bold: r.bold }));
    if (line.type === 'heading') children.push(new Paragraph({ children: runs, heading: headingLevels[line.level - 1] }));
    else if (line.type === 'bullet') children.push(new Paragraph({ children: runs, bullet: { level: line.level } }));
    else children.push(new Paragraph({ children: runs }));
  }
  flushTable();
  return Packer.toBuffer(new Document({ creator: 'Projexa', title, sections: [{ children }] }));
}

// I font standard del PDF coprono solo i caratteri dell'Europa occidentale: gli altri
// (emoji, simboli) vengono sostituiti per non stampare caratteri illeggibili.
function pdfSafe(text) {
  return String(text)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/…/g, '...').replace(/€/g, 'EUR')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
}

function buildPdf(text, title) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: title, Creator: 'Projexa' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(16).text(pdfSafe(title));
    doc.moveDown(0.8);
    const writeRuns = (runs, options) => {
      runs.forEach((r, i) => {
        doc.font(r.bold ? 'Helvetica-Bold' : 'Helvetica').text(pdfSafe(r.text), { ...options, continued: i < runs.length - 1 });
      });
    };
    for (const line of parseLines(text)) {
      if (line.type === 'heading') {
        doc.moveDown(0.4).font('Helvetica-Bold').fontSize(Math.max(15 - line.level, 11)).text(pdfSafe(line.text.replace(/\*\*/g, '')));
        doc.fontSize(10.5);
      } else if (line.type === 'bullet') {
        doc.fontSize(10.5);
        const marker = /\d/.test(line.marker) ? line.marker : '-';
        writeRuns([{ text: `${marker} `, bold: false }, ...inlineRuns(line.text)], { indent: 14 + line.level * 16 });
      } else if (!line.text.trim()) {
        doc.moveDown(0.5);
      } else {
        doc.fontSize(10.5);
        writeRuns(inlineRuns(line.text), {});
      }
    }
    doc.end();
  });
}

async function buildXlsx(text, title) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Projexa';
  const tables = markdownTables(text);
  if (tables.length) {
    // Una tabella per foglio, prima riga in grassetto come intestazione.
    tables.forEach((rows, i) => {
      const ws = wb.addWorksheet(tables.length > 1 ? `Tabella ${i + 1}` : 'Tabella');
      rows.forEach((cells) => ws.addRow(cells.map((c) => (/^-?\d+([.,]\d+)?$/.test(c) ? Number(c.replace(',', '.')) : c))));
      ws.getRow(1).font = { bold: true };
      ws.columns.forEach((col) => { col.width = Math.min(60, Math.max(10, ...col.values.filter(Boolean).map((v) => String(v).length + 2))); });
    });
  } else {
    // Nessuna tabella: una riga del foglio per ogni riga della risposta.
    const ws = wb.addWorksheet('Risposta');
    ws.addRow([title]).font = { bold: true };
    String(text || '').split(/\r?\n/).forEach((line) => ws.addRow([line]));
    ws.getColumn(1).width = 120;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const EXPORT_FORMATS = {
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', build: buildDocx },
  pdf: { mime: 'application/pdf', build: buildPdf },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', build: buildXlsx },
  txt: { mime: 'text/plain; charset=utf-8', build: async (text) => Buffer.from('﻿' + String(text || '').replace(/\r?\n/g, '\r\n'), 'utf8') },
  md: { mime: 'text/markdown; charset=utf-8', build: async (text) => Buffer.from(String(text || ''), 'utf8') }
};
