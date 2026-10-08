// Export del Gantt (tipo_valore = 13) nel template Excel Documentazione/Template/Gantt_template.xlsx.
//
// Il template si legge ogni volta da disco e NON viene mai modificato: si lavora su una copia in
// memoria (JSZip) e il risultato torna al browser come Buffer, senza salvare file sul server.
//
// Foglio «Gantt Chart»:
//   - D3 nome progetto, D4/D5 inizio/fine (min/max delle date delle attività): da D4 il foglio
//     calcola da solo la timeline (colonne H…SC) e colora le barre con la formattazione
//     condizionale, che usa Stato (E), Inizio (F) e Fine (G) di ogni riga;
//   - righe dati dalla 11: argomenti di 1° livello = righe di sezione (stile della riga 11/19
//     del template), livelli inferiori = righe attività numerate 1.1, 1.1.1… (stile riga 12/18).
//     Il template ha 38 righe dati (11-48): con più attività le righe di servizio nascoste
//     (49-58, formule delle settimane) scendono e ogni riferimento viene spostato di conseguenza.
// Lo stato di Projexa è testo libero: si usa se coincide con uno stato del template, altrimenti
// si deduce da avanzamento e date (le barre si colorano solo con uno stato del template).
import JSZip from 'jszip';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

export const GANTT_TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'Documentazione', 'Template', 'Gantt_template.xlsx');

const SHEET = 'xl/worksheets/sheet2.xml';
const FIRST_DATA_ROW = 11;
const TEMPLATE_LAST_DATA_ROW = 48;   // ultima riga dati del template
const TEMPLATE_DATA_ROWS = TEMPLATE_LAST_DATA_ROW - FIRST_DATA_ROW + 1;
// Righe del template usate come modello di stile.
const ROW_HEADER_FIRST = 11, ROW_HEADER = 19, ROW_ITEM = 12, ROW_ITEM_LAST = 18;
// Stati del foglio «Setup» (E7:E12): solo questi colorano la barra.
const STATI = ['Completata', 'Programmata', 'In corso', 'Da pianificare', 'Da iniziare', 'In Revisione'];

function httpError(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

// 'AAAA-MM-GG' -> numero di serie Excel (giorni dal 30/12/1899).
function excelSerial(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) + 25569;
}

function statoExcel(node) {
  const raw = String(node.stato || '').trim().toLowerCase();
  const match = STATI.find((s) => s.toLowerCase() === raw);
  if (match) return match;
  const avanz = Number(node.avanzamento);
  if (avanz >= 100) return 'Completata';
  if (avanz > 0) return 'In corso';
  if (node.data_inizio || node.data_fine) return 'Programmata';
  return 'Da pianificare';
}

// ---- Gestione dei riferimenti di cella nelle formule ----
// Sposta di "delta" le righe >= "fromRow" dei riferimenti allo stesso foglio. Le stringhe
// tra virgolette e i riferimenti ad altri fogli ('Setup ⚙️'!…, anche a intervallo) restano.
const REF_RE = /(?<![A-Za-z0-9_.])((?:'(?:[^']|'')*'|[A-Za-z_][\w.]*)!)?(\$?[A-Z]{1,3}\$?)(\d+)(?::(\$?[A-Z]{1,3}\$?)(\d+))?(?![\w(])/g;
function shiftFormula(formula, fromRow, delta) {
  return formula.split(/("(?:[^"]|"")*")/).map((part, i) => {
    if (i % 2 === 1) return part; // stringa letterale
    return part.replace(REF_RE, (all, sheet, c1, r1, c2, r2) => {
      if (sheet) return all;
      const sh = (r) => (Number(r) >= fromRow ? Number(r) + delta : Number(r));
      return `${c1}${sh(r1)}${c2 ? `:${c2}${sh(r2)}` : ''}`;
    });
  }).join('');
}
// Intervallo/elenco di intervalli ("A1:B2 C3") senza nomi di foglio.
function shiftSqref(sqref, fromRow, delta) {
  return sqref.replace(/([A-Z]{1,3})(\d+)/g, (all, c, r) => `${c}${Number(r) >= fromRow ? Number(r) + delta : r}`);
}

// Riscrive una riga del foglio con un nuovo numero (r della riga e di ogni cella, formule
// spostate). "cells" (facoltativo) sostituisce il contenuto delle celle indicate per colonna.
function rewriteRow(rowXml, newNum, { fromRow, delta } = {}, cells = null) {
  let out = rowXml.replace(/^<row r="\d+"/, `<row r="${newNum}"`);
  out = out.replace(/<c r="([A-Z]{1,3})\d+"/g, (all, col) => `<c r="${col}${newNum}"`);
  if (delta) {
    out = out.replace(/<f([^>]*)>([^<]*)<\/f>/g, (all, attrs, text) => {
      const a = attrs.replace(/ref="([^"]+)"/, (m, ref) => `ref="${shiftSqref(ref, fromRow, delta)}"`);
      return `<f${a}>${xmlEsc(shiftFormula(unesc(text), fromRow, delta))}</f>`;
    }).replace(/<f([^>]*)\/>/g, (all, attrs) =>
      `<f${attrs.replace(/ref="([^"]+)"/, (m, ref) => `ref="${shiftSqref(ref, fromRow, delta)}"`)}/>`);
  }
  if (cells) {
    out = out.replace(/<c r="([A-Z]{1,3})(\d+)"([^>]*?)(\/>|>[\s\S]*?<\/c>)/g, (all, col, num, attrs) => {
      if (!(col in cells)) return all;
      const style = (/ s="(\d+)"/.exec(attrs) || [])[0] || '';
      return cellXml(`${col}${num}`, style, cells[col]);
    });
  }
  return out;
}
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Cella con valore: numero, testo (inline, senza toccare sharedStrings) o vuota.
function cellXml(ref, styleAttr, value) {
  if (value == null || value === '') return `<c r="${ref}"${styleAttr}/>`;
  if (typeof value === 'number') return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
  return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
}

// Nodi (albero del Gantt) -> righe del foglio, in ordine, con numerazione 1.1, 1.1.1…
function flatten(tree) {
  const out = [];
  const walk = (nodes, prefix, level) => nodes.forEach((n, i) => {
    const num = [...prefix, i + 1];
    out.push({ node: n, level, num });
    walk(n.children || [], num, level + 1);
  });
  walk(tree, [], 1);
  return out;
}

// rows = righe di proj_activity già in ordine gerarchico (come le legge la pagina Gantt).
function buildTree(rows) {
  const tree = [];
  const last = [null, null, null, null];
  for (const r of rows) {
    let level = 1;
    for (let i = 4; i >= 1; i--) {
      if (r[`argomento${i}`] != null && String(r[`argomento${i}`]).trim() !== '') { level = i; break; }
    }
    const node = { ...r, name: String(r[`argomento${level}`] ?? ''), children: [] };
    const parent = level > 1 ? last[level - 2] : null;
    if (parent) parent.children.push(node); else tree.push(node);
    last[level - 1] = node;
    for (let i = level; i < 4; i++) last[i] = null;
  }
  return tree;
}

export async function buildGanttXlsx({ projectName, rows }) {
  let templateBuf;
  try {
    templateBuf = await fs.readFile(GANTT_TEMPLATE_PATH);
  } catch (e) {
    throw httpError(500, 'Template Gantt non trovato sul server (Documentazione/Template/Gantt_template.xlsx)');
  }
  const zip = await JSZip.loadAsync(templateBuf);
  let xml = await zip.file(SHEET).async('string');

  const items = flatten(buildTree(rows || []));
  const dataRows = Math.max(items.length, TEMPLATE_DATA_ROWS);
  const delta = dataRows - TEMPLATE_DATA_ROWS;           // righe aggiunte (>= 0)
  const lastData = FIRST_DATA_ROW + dataRows - 1;
  const fromRow = TEMPLATE_LAST_DATA_ROW + 1;            // da qui in giù le righe scendono
  const shift = { fromRow, delta };

  const sdStart = xml.indexOf('<sheetData>');
  const sdEnd = xml.indexOf('</sheetData>');
  if (sdStart < 0 || sdEnd < 0) throw httpError(500, 'Template Gantt non valido');
  const rowXmls = xml.slice(sdStart + '<sheetData>'.length, sdEnd).match(/<row [^>]*?(?:\/>|>[\s\S]*?<\/row>)/g) || [];
  const byNum = new Map(rowXmls.map((r) => [Number(/<row r="(\d+)"/.exec(r)[1]), r]));

  // Date del progetto: dalla più vecchia alla più recente fra tutte le attività.
  const starts = items.map((it) => excelSerial(it.node.data_inizio)).filter((v) => v != null);
  const ends = items.map((it) => excelSerial(it.node.data_fine ?? it.node.data_inizio)).filter((v) => v != null);
  const projStart = starts.length ? Math.min(...starts) : null;
  const projEnd = ends.length ? Math.max(...ends, ...(starts.length ? starts : [])) : projStart;

  const out = [];
  const headerMerges = [];
  for (const [num, rowXml] of [...byNum.entries()].sort((a, b) => a[0] - b[0])) {
    if (num < FIRST_DATA_ROW) {
      // Intestazione: nome progetto e date; le formule che puntano alle righe di servizio scendono.
      const cells = num === 3 ? { D: projectName || '' } : num === 4 ? { D: projStart } : num === 5 ? { D: projEnd } : null;
      out.push(rewriteRow(rowXml, num, shift, cells));
    } else if (num === FIRST_DATA_ROW) {
      // Righe dati generate al posto delle 38 righe di esempio del template.
      for (let i = 0; i < dataRows; i++) {
        const rowNum = FIRST_DATA_ROW + i;
        const it = items[i];
        if (!it) { out.push(rewriteRow(byNum.get(ROW_ITEM), rowNum, {}, { A: null, B: null })); continue; }
        const n = it.node;
        const next = items[i + 1];
        const isHeader = it.level === 1;
        const hasDates = !!(n.data_inizio || n.data_fine);
        const values = {
          C: n.rischio || null,
          D: n.owner || n.nominativo || null,
          E: (hasDates || !isHeader) ? statoExcel(n) : null,
          F: excelSerial(n.data_inizio),
          G: excelSerial(n.data_fine ?? n.data_inizio)
        };
        if (isHeader) {
          values.A = n.name;
          values.B = null;
          headerMerges.push(`A${rowNum}:B${rowNum}`);
          out.push(rewriteRow(byNum.get(i === 0 ? ROW_HEADER_FIRST : ROW_HEADER), rowNum, {}, values));
        } else {
          values.A = it.num.join('.');
          values.B = '    '.repeat(it.level - 2) + n.name; // rientro per i livelli più profondi
          const lastOfSection = !next || next.level === 1;
          out.push(rewriteRow(byNum.get(lastOfSection ? ROW_ITEM_LAST : ROW_ITEM), rowNum, {}, values));
        }
      }
    } else if (num <= TEMPLATE_LAST_DATA_ROW) {
      continue; // righe di esempio del template: già sostituite
    } else {
      out.push(rewriteRow(rowXml, num + delta, shift));
    }
  }
  xml = xml.slice(0, sdStart) + '<sheetData>' + out.join('') + xml.slice(sdEnd);

  // Formattazioni condizionali e convalide: intervalli estesi alle nuove righe dati.
  xml = xml.replace(/<conditionalFormatting sqref="([^"]+)"/g, (all, sq) => `<conditionalFormatting sqref="${shiftSqref(sq, fromRow, delta).replace(/([A-Z]+)48\b/g, `$1${lastData}`)}"`);
  xml = xml.replace(/(<cfRule[^>]*>)([\s\S]*?)(<\/cfRule>)/g, (all, open, body, close) =>
    open + body.replace(/<formula>([^<]*)<\/formula>/g, (m, f) => `<formula>${xmlEsc(shiftFormula(unesc(f), fromRow, delta))}</formula>`) + close);
  xml = xml.replace(/<dataValidation ([^>]*?)sqref="([^"]+)"/g, (all, attrs, sq) =>
    `<dataValidation ${attrs}sqref="${sq === 'D4:D5 F11:F48 G11:G49' ? `D4:D5 F${FIRST_DATA_ROW}:F${lastData} G${FIRST_DATA_ROW}:G${lastData + 1}` : shiftSqref(sq, fromRow, delta)}"`);
  xml = xml.replace(/<xm:sqref>([CDE])\d+:[CDE]\d+[^<]*<\/xm:sqref>/g, (all, col) =>
    `<xm:sqref>${col}${FIRST_DATA_ROW}:${col}${lastData}</xm:sqref>`);

  // Celle unite: via quelle delle sezioni di esempio, aggiunte quelle delle nuove sezioni.
  xml = xml.replace(/<mergeCells count="\d+">([\s\S]*?)<\/mergeCells>/, (all, body) => {
    const refs = [...body.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((m) => m[1])
      .filter((ref) => { const r = Number(/\d+/.exec(ref)[0]); return r < FIRST_DATA_ROW || r > TEMPLATE_LAST_DATA_ROW; })
      .map((ref) => shiftSqref(ref, fromRow, delta))
      .concat(headerMerges);
    return `<mergeCells count="${refs.length}">${refs.map((r) => `<mergeCell ref="${r}"/>`).join('')}</mergeCells>`;
  });

  xml = xml.replace(/<dimension ref="([^"]+)"\/>/, (all, ref) => `<dimension ref="${shiftSqref(ref, fromRow, delta)}"/>`)
    .replace(/<protectedRange sqref="A1:G48"/, `<protectedRange sqref="A1:G${lastData}"`)
    // Apertura in cima al foglio (il template era salvato scorrendo a metà).
    .replace(/(<sheetView [^>]*?)topLeftCell="[^"]*"/, '$1topLeftCell="A1"')
    .replace(/(<pane [^>]*?)topLeftCell="[^"]*"/, '$1topLeftCell="H1"')
    .replace(/<selection activeCell="[^"]*" sqref="[^"]*"\/>/, '<selection activeCell="A1" sqref="A1"/>')
    .replace(/<selection pane="topRight" activeCell="[^"]*" sqref="[^"]*"\/>/, '<selection pane="topRight" activeCell="H11" sqref="H11"/>');
  zip.file(SHEET, xml);

  // Catena di calcolo: si toglie (Excel la ricostruisce) e si chiede il ricalcolo all'apertura,
  // così timeline e barre partono dalle nuove date.
  zip.remove('xl/calcChain.xml');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  zip.file('xl/_rels/workbook.xml.rels', rels.replace(/<Relationship [^>]*Target="calcChain\.xml"\/>/, ''));
  const ct = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', ct.replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ''));
  const wb = await zip.file('xl/workbook.xml').async('string');
  zip.file('xl/workbook.xml', wb.replace(/<calcPr ([^>]*?)\/>/, (all, attrs) =>
    `<calcPr ${attrs.replace(/\s*fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
