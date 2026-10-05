// Offerta economica del progetto: lettura e modifica del template Word (.docx), tutto in memoria.
//
// Il .docx è uno zip di file XML (word/document.xml, intestazioni e piè di pagina): si apre con
// JSZip e si legge con @xmldom/xmldom, come il PowerPoint del Kick-off (config/kickoffPptx.js).
//   - leggiTemplate(buffer): paragrafi e tabelle del documento, ognuno con un codice da mandare
//     all'AI: P12 = paragrafo 12 del corpo, T2 = tabella 2, H3 = paragrafo 3 di intestazioni e
//     piè di pagina;
//   - applicaModifiche(template, modifiche): applica le modifiche dell'AI e restituisce il nuovo
//     .docx come Buffer:
//       { id: "P12", testo }      nuovo testo del paragrafo (\n = più paragrafi con lo stesso stile);
//       { id: "T2", righe }       nuove righe della tabella (le righe in più copiano l'ultima);
//       { id: "P12", elimina }    toglie il paragrafo o la tabella.
// Stile di paragrafo (titoli, elenchi, allineamento) e carattere del primo pezzo di testo
// restano quelli del template.
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const figli = (el, nome) => Array.from(el.childNodes || []).filter((n) => n.nodeType === 1 && n.namespaceURI === NS_W && n.localName === nome);
const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');

// Testo di un paragrafo: pezzi <w:t>, tabulazioni e a capo (non il testo cancellato con revisioni).
function testoParagrafo(p) {
  let s = '';
  const visita = (n) => {
    for (const c of Array.from(n.childNodes || [])) {
      if (c.nodeType !== 1) continue;
      if (c.namespaceURI === NS_W) {
        if (c.localName === 't') { s += c.textContent; continue; }
        if (c.localName === 'tab') { s += '\t'; continue; }
        if (c.localName === 'br' || c.localName === 'cr') { s += '\n'; continue; }
        if (c.localName === 'del' || c.localName === 'pPr' || c.localName === 'rPr') continue;
        if (c.localName === 'p' || c.localName === 'tbl') continue; // contenuti annidati (caselle di testo)
      }
      visita(c);
    }
  };
  visita(p);
  return s;
}

// Primo stile di carattere del paragrafo (rPr di un run, non quello del paragrafo).
function primoRPr(p) {
  for (const r of Array.from(p.getElementsByTagNameNS(NS_W, 'r'))) {
    const rPr = figli(r, 'rPr')[0];
    if (rPr) return rPr;
  }
  return null;
}

// Riscrive il testo di un paragrafo: resta pPr, il testo con lo stile del primo run.
// Il testo tra ~~ e ~~ si scrive barrato (es. importo di listino barrato prima dello scontato).
function riempiParagrafo(p, testo, rPr) {
  const doc = p.ownerDocument;
  for (const n of Array.from(p.childNodes)) {
    if (!(n.nodeType === 1 && n.namespaceURI === NS_W && n.localName === 'pPr')) p.removeChild(n);
  }
  if (testo === '') return;
  String(testo).split(/(~~[^~]+~~)/).filter((s) => s !== '').forEach((parte) => {
    const barrato = /^~~[^~]+~~$/.test(parte);
    const r = doc.createElementNS(NS_W, 'w:r');
    const stile = rPr ? rPr.cloneNode(true) : (barrato ? doc.createElementNS(NS_W, 'w:rPr') : null);
    if (stile && barrato) {
      // w:strike va dopo gli elementi di carattere già presenti (ordine non vincolante per Word).
      figli(stile, 'strike').forEach((x) => stile.removeChild(x));
      stile.appendChild(doc.createElementNS(NS_W, 'w:strike'));
    }
    if (stile) r.appendChild(stile);
    (barrato ? parte.slice(2, -2) : parte).split('\t').forEach((pezzo, i) => {
      if (i > 0) r.appendChild(doc.createElementNS(NS_W, 'w:tab'));
      if (pezzo === '') return;
      const t = doc.createElementNS(NS_W, 'w:t');
      t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
      t.appendChild(doc.createTextNode(pezzo));
      r.appendChild(t);
    });
    p.appendChild(r);
  });
}

// Nuovo testo di un paragrafo: le righe in più diventano paragrafi copiati dal primo.
function scriviParagrafo(p, testo) {
  const righe = String(testo == null ? '' : testo).replace(/\r\n?/g, '\n').split('\n');
  const rPr = primoRPr(p);
  const modello = p.cloneNode(true);
  riempiParagrafo(p, righe[0], rPr);
  let dopo = p;
  for (const riga of righe.slice(1)) {
    const nuovo = modello.cloneNode(true);
    riempiParagrafo(nuovo, riga, rPr);
    dopo.parentNode.insertBefore(nuovo, dopo.nextSibling);
    dopo = nuovo;
  }
}

// Testo di una cella: i suoi paragrafi, uno per riga.
const testoCella = (tc) => figli(tc, 'p').map(testoParagrafo).join('\n');

function scriviCella(tc, testo) {
  const ps = figli(tc, 'p');
  if (!ps.length) {
    const p = tc.ownerDocument.createElementNS(NS_W, 'w:p');
    tc.appendChild(p);
    ps.push(p);
  }
  ps.slice(1).forEach((p) => tc.removeChild(p));
  scriviParagrafo(ps[0], testo);
}

// Elementi di un contenitore (corpo, intestazione): paragrafi e tabelle nell'ordine, anche
// dentro i controlli contenuto (w:sdt). Non entra nelle tabelle (le tabelle sono un elemento).
function elementiDi(contenitore, visita) {
  for (const c of Array.from(contenitore.childNodes || [])) {
    if (c.nodeType !== 1 || c.namespaceURI !== NS_W) continue;
    if (c.localName === 'p' || c.localName === 'tbl') visita(c);
    else if (c.localName === 'sdt') {
      const contenuto = figli(c, 'sdtContent')[0];
      if (contenuto) elementiDi(contenuto, visita);
    }
  }
}

const stileDi = (p) => {
  const pPr = figli(p, 'pPr')[0];
  const st = pPr && figli(pPr, 'pStyle')[0];
  return st ? st.getAttributeNS(NS_W, 'val') || st.getAttribute('w:val') || '' : '';
};

// Apre il template. Restituisce { zip, parti: [{ file, doc }], elementi: [...] }.
export async function leggiTemplate(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw httpError(400, 'Il file non è un .docx: i vecchi file .doc vanno prima salvati come .docx da Word');
  }
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch { throw httpError(400, 'File .docx danneggiato o non leggibile'); }
  const principale = zip.file('word/document.xml');
  if (!principale) throw httpError(400, 'Il file non è un documento Word (.docx) valido');
  const parti = [{ file: 'word/document.xml', doc: parseXml(await principale.async('string')) }];
  const altri = Object.keys(zip.files).filter((f) => /^word\/(header|footer)\d*\.xml$/.test(f)).sort();
  for (const f of altri) parti.push({ file: f, doc: parseXml(await zip.file(f).async('string')) });

  const elementi = [];
  let np = 0, nt = 0, nh = 0;
  const body = parti[0].doc.getElementsByTagNameNS(NS_W, 'body')[0];
  if (!body) throw httpError(400, 'Il documento Word non ha contenuto');
  elementiDi(body, (el) => {
    if (el.localName === 'p') {
      np += 1;
      elementi.push({ id: `P${np}`, tipo: 'paragrafo', el, parte: parti[0], testo: testoParagrafo(el), stile: stileDi(el) });
    } else {
      nt += 1;
      const righe = figli(el, 'tr').map((tr) => figli(tr, 'tc').map(testoCella));
      elementi.push({ id: `T${nt}`, tipo: 'tabella', el, parte: parti[0], righe });
    }
  });
  for (const parte of parti.slice(1)) {
    const radice = parte.doc.documentElement;
    elementiDi(radice, (el) => {
      if (el.localName !== 'p') return;
      const testo = testoParagrafo(el);
      if (!testo.trim()) return; // intestazioni vuote: inutili all'AI
      nh += 1;
      elementi.push({ id: `H${nh}`, tipo: 'paragrafo', el, parte, testo, stile: stileDi(el), intestazione: /header/.test(parte.file) ? 'intestazione' : 'piè di pagina' });
    });
  }
  return { zip, parti, elementi };
}

// Descrizione del documento per l'AI: codici, stile e testi attuali.
export function descriviTemplate(template) {
  const righe = [];
  for (const e of template.elementi) {
    if (e.tipo === 'paragrafo') {
      const dove = e.intestazione ? ` (${e.intestazione})` : '';
      const stile = e.stile ? ` {${e.stile}}` : '';
      righe.push(`[${e.id}]${dove}${stile} ${e.testo ? e.testo.replace(/\n/g, ' / ') : '(vuoto)'}`);
    } else {
      righe.push(`[${e.id}] TABELLA ${e.righe.length} righe x ${(e.righe[0] || []).length} colonne:`);
      e.righe.forEach((r, i) => righe.push(`    riga ${i + 1}: ${r.map((c) => c.replace(/\n/g, ' / ')).join(' | ')}`));
    }
  }
  return righe.join('\n');
}

// Testo che avrà il documento con queste modifiche (per i controlli, senza applicarle).
export function testoRisultante(template, modifiche) {
  const mod = new Map();
  for (const m of Array.isArray(modifiche) ? modifiche : []) if (m && m.id) mod.set(String(m.id).trim().toUpperCase(), m);
  const parti = [];
  for (const e of template.elementi) {
    const m = mod.get(e.id);
    if (m && (m.elimina === true || m.elimina === 'true')) continue;
    if (e.tipo === 'tabella') parti.push(...(m && Array.isArray(m.righe) ? m.righe : e.righe).flat().map((c) => String(c ?? '')));
    else parti.push(m && m.testo != null && typeof m.testo !== 'object' ? String(m.testo) : e.testo);
  }
  return parti.join('\n');
}

// Applica le modifiche dell'AI. Restituisce { buffer, applicate, ignorate, tolti }.
export async function applicaModifiche(template, modifiche) {
  const perId = new Map(template.elementi.map((e) => [e.id, e]));
  const toccate = new Set();
  let applicate = 0, ignorate = 0, tolti = 0;
  for (const m of Array.isArray(modifiche) ? modifiche : []) {
    const e = m && perId.get(String(m.id || '').trim().toUpperCase());
    if (!e || !e.el.parentNode) { ignorate += 1; continue; }
    if (m.elimina === true || m.elimina === 'true') {
      // Una cella di tabella deve conservare almeno un paragrafo: lì si svuota.
      if (e.el.parentNode.localName === 'tc' && figli(e.el.parentNode, 'p').length < 2) riempiParagrafo(e.el, '', null);
      else { e.el.parentNode.removeChild(e.el); tolti += 1; }
    } else if (e.tipo === 'paragrafo' && m.testo != null && typeof m.testo !== 'object') {
      scriviParagrafo(e.el, String(m.testo));
    } else if (e.tipo === 'tabella' && Array.isArray(m.righe)) {
      const nuove = m.righe.filter(Array.isArray);
      let trs = figli(e.el, 'tr');
      if (!trs.length || !nuove.length) { ignorate += 1; continue; }
      while (trs.length < nuove.length) {
        e.el.appendChild(trs[trs.length - 1].cloneNode(true));
        trs = figli(e.el, 'tr');
      }
      trs.slice(nuove.length).forEach((tr) => e.el.removeChild(tr));
      nuove.forEach((celle, i) => {
        figli(trs[i], 'tc').forEach((tc, j) => scriviCella(tc, celle[j] == null ? '' : String(celle[j])));
      });
    } else {
      ignorate += 1;
      continue;
    }
    applicate += 1;
    toccate.add(e.parte);
  }
  const ser = new XMLSerializer();
  for (const parte of toccate) template.zip.file(parte.file, ser.serializeToString(parte.doc));
  const buffer = await template.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, applicate, ignorate, tolti };
}
