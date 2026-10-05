// Kick-off del progetto: lettura e modifica del template PowerPoint (.pptx), tutto in memoria.
//
// Il .pptx è uno zip di file XML: si apre con JSZip e si legge con @xmldom/xmldom (nessun
// programma esterno né Python sulla VM).
//   - leggiTemplate(buffer): elementi di ogni slide con un codice da mandare all'AI:
//     S3.2 = slide 3, elemento 2 (casella di testo, forma o immagine, con la posizione in % della
//     slide); S5.T1 = slide 5, tabella 1; S8 = l'intera slide 8;
//   - applicaModifiche(template, modifiche): applica le modifiche indicate dall'AI e
//     restituisce il nuovo .pptx come Buffer:
//       { id, testo }          nuovo testo della casella (stile del template mantenuto);
//       { id, righe }          nuove righe della tabella;
//       { id, elimina: true }  toglie l'elemento (casella, forma, immagine o tabella);
//       { id: "S8", elimina_slide: true }  toglie l'intera slide.
//     Pulizia automatica: una forma (cerchio, riquadro…) i cui testi collegati sono stati
//     svuotati o tolti dall'AI viene tolta insieme alle icone che contiene, così una persona o
//     una licenza non usata non lascia forme vuote sulla slide.
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';

const MAX_SLIDE = 150;
// Forme più grandi di questa quota della slide (sfondi, cornici) non si tolgono mai da sole.
const MAX_AREA_PULIZIA = 0.4;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const figli = (el, ns, nome) => Array.from(el.childNodes || []).filter((n) => n.nodeType === 1 && n.namespaceURI === ns && n.localName === nome);
const discendenti = (el, ns, nome) => Array.from(el.getElementsByTagNameNS(ns, nome));
const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');

// Testo di un paragrafo (<a:p>): pezzi <a:t> e campi, <a:br> = a capo.
function testoParagrafo(p) {
  let s = '';
  for (const n of Array.from(p.childNodes)) {
    if (n.nodeType !== 1 || n.namespaceURI !== NS_A) continue;
    if (n.localName === 'r' || n.localName === 'fld') s += discendenti(n, NS_A, 't').map((t) => t.textContent).join('');
    else if (n.localName === 'br') s += '\n';
  }
  return s;
}

const testoCorpo = (txBody) => figli(txBody, NS_A, 'p').map(testoParagrafo).join('\n');

// Sostituisce il testo di un <a:txBody> con le righe indicate (una per paragrafo). Ogni nuova
// riga copia il paragrafo originale nella stessa posizione (o l'ultimo): elenchi puntati,
// rientri e allineamento restano; il carattere è quello del primo pezzo di testo del
// paragrafo (così, in una casella "nome / ruolo / email", il ruolo resta colorato).
function scriviCorpo(txBody, testo) {
  const doc = txBody.ownerDocument;
  const righe = String(testo == null ? '' : testo).replace(/\r\n?/g, '\n').split('\n');
  const originali = figli(txBody, NS_A, 'p');
  const modelli = originali.length ? originali : [doc.createElementNS(NS_A, 'a:p')];
  const primoRPr = discendenti(txBody, NS_A, 'rPr')[0] || null;
  const primoEnd = discendenti(txBody, NS_A, 'endParaRPr')[0] || null;
  for (const p of originali) txBody.removeChild(p);
  righe.forEach((riga, i) => {
    const modello = modelli[Math.min(i, modelli.length - 1)];
    const p = modello.cloneNode(true);
    for (const n of Array.from(p.childNodes)) {
      if (n.nodeType === 1 && n.namespaceURI === NS_A && ['r', 'br', 'fld'].includes(n.localName)) p.removeChild(n);
    }
    if (riga !== '') {
      const rPrModello = discendenti(modello, NS_A, 'rPr')[0] || primoRPr;
      const r = doc.createElementNS(NS_A, 'a:r');
      if (rPrModello) r.appendChild(rPrModello.cloneNode(true));
      else if (primoEnd) {
        const rPr = doc.createElementNS(NS_A, 'a:rPr');
        for (const a of Array.from(primoEnd.attributes)) rPr.setAttribute(a.name, a.value);
        for (const c of Array.from(primoEnd.childNodes)) rPr.appendChild(c.cloneNode(true));
        r.appendChild(rPr);
      }
      const t = doc.createElementNS(NS_A, 'a:t');
      t.appendChild(doc.createTextNode(riga));
      r.appendChild(t);
      const end = figli(p, NS_A, 'endParaRPr')[0];
      if (end) p.insertBefore(r, end); else p.appendChild(r);
    }
    txBody.appendChild(p);
  });
}

// ---------- Posizioni (EMU) ----------
function leggiXfrm(xfrm) {
  if (!xfrm) return null;
  const off = figli(xfrm, NS_A, 'off')[0], ext = figli(xfrm, NS_A, 'ext')[0];
  if (!off || !ext) return null;
  const b = { x: Number(off.getAttribute('x')) || 0, y: Number(off.getAttribute('y')) || 0, w: Number(ext.getAttribute('cx')) || 0, h: Number(ext.getAttribute('cy')) || 0 };
  const chOff = figli(xfrm, NS_A, 'chOff')[0], chExt = figli(xfrm, NS_A, 'chExt')[0];
  if (chOff && chExt) {
    b.chx = Number(chOff.getAttribute('x')) || 0; b.chy = Number(chOff.getAttribute('y')) || 0;
    b.chw = Number(chExt.getAttribute('cx')) || 0; b.chh = Number(chExt.getAttribute('cy')) || 0;
  }
  return b;
}

// Riquadro di un elemento in coordinate della slide (anche dentro i gruppi), null se la
// posizione arriva dal layout (segnaposto senza xfrm).
function riquadro(el) {
  let xfrm = null;
  if (el.localName === 'graphicFrame') xfrm = figli(el, NS_P, 'xfrm')[0];
  else {
    const pr = figli(el, NS_P, el.localName === 'grpSp' ? 'grpSpPr' : 'spPr')[0];
    xfrm = pr ? figli(pr, NS_A, 'xfrm')[0] : null;
  }
  let b = leggiXfrm(xfrm);
  if (!b) return null;
  b = { x: b.x, y: b.y, w: b.w, h: b.h };
  for (let g = el.parentNode; g && g.nodeType === 1; g = g.parentNode) {
    if (!(g.namespaceURI === NS_P && g.localName === 'grpSp')) continue;
    const pr = figli(g, NS_P, 'grpSpPr')[0];
    const t = leggiXfrm(pr ? figli(pr, NS_A, 'xfrm')[0] : null);
    if (!t || !t.chw || !t.chh) continue;
    const sx = t.w / t.chw, sy = t.h / t.chh;
    b = { x: t.x + (b.x - t.chx) * sx, y: t.y + (b.y - t.chy) * sy, w: b.w * sx, h: b.h * sy };
  }
  return b;
}

const centroDentro = (a, b) => a && b && a.x + a.w / 2 >= b.x && a.x + a.w / 2 <= b.x + b.w && a.y + a.h / 2 >= b.y && a.y + a.h / 2 <= b.y + b.h;
// Distanza verticale tra due riquadri sovrapposti in orizzontale (almeno metà del più
// stretto); null se non sono uno sopra/sotto l'altro. Negativa = si sovrappongono.
function distanzaVerticale(a, b) {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  if (ox < 0.5 * Math.min(a.w, b.w)) return null;
  return Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
}

// ---------- Lettura ----------
async function struttura(zip) {
  const pres = zip.file('ppt/presentation.xml');
  const rels = zip.file('ppt/_rels/presentation.xml.rels');
  if (!pres || !rels) throw httpError(400, 'Il file non è una presentazione PowerPoint (.pptx) valida');
  const presDoc = parseXml(await pres.async('string'));
  const relDoc = parseXml(await rels.async('string'));
  const target = new Map(discendenti(relDoc, NS_REL, 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));
  const sz = discendenti(presDoc, NS_P, 'sldSz')[0];
  const slideSize = { w: Number(sz && sz.getAttribute('cx')) || 12192000, h: Number(sz && sz.getAttribute('cy')) || 6858000 };
  const elenco = discendenti(presDoc, NS_P, 'sldId').map((s) => {
    const relId = s.getAttributeNS(NS_R, 'id');
    const t = target.get(relId);
    if (!t) return null;
    return { relId, sldId: s.getAttribute('id'), file: t.startsWith('/') ? t.slice(1) : `ppt/${t.replace(/^\.\//, '')}` };
  }).filter(Boolean);
  return { presDoc, relDoc, slideSize, elenco };
}

const geometria = (sp) => {
  const g = discendenti(sp, NS_A, 'prstGeom')[0];
  const p = g ? g.getAttribute('prst') : '';
  return { ellipse: 'cerchio', rect: 'riquadro', roundRect: 'riquadro arrotondato', line: 'linea' }[p] || (p ? `forma ${p}` : 'forma');
};

// Elementi di una slide: caselle di testo e forme (p:sp), immagini (p:pic), tabelle.
function elementiSlide(doc, n) {
  const out = [];
  let k = 0, kt = 0;
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    if (el.namespaceURI !== NS_P) continue;
    if (el.localName === 'sp') {
      const body = figli(el, NS_P, 'txBody')[0];
      const testo = body ? testoCorpo(body) : '';
      const nv = figli(el, NS_P, 'nvSpPr')[0];
      const casella = !!(nv && (discendenti(nv, NS_P, 'ph').length
        || discendenti(nv, NS_P, 'cNvSpPr').some((c) => c.getAttribute('txBox') === '1')));
      k += 1;
      // casella = casella di testo o segnaposto; le altre sono forme disegnate (cerchi,
      // riquadri), che possono anche contenere testo.
      out.push({ id: `S${n}.${k}`, tipo: testo.trim() || casella ? 'testo' : 'forma', casella, el, body, testo, geom: geometria(el), bbox: riquadro(el) });
    } else if (el.localName === 'pic') {
      k += 1;
      out.push({ id: `S${n}.${k}`, tipo: 'immagine', el, testo: '', bbox: riquadro(el) });
    } else if (el.localName === 'graphicFrame') {
      const tbl = discendenti(el, NS_A, 'tbl')[0];
      if (!tbl) continue;
      kt += 1;
      const righe = figli(tbl, NS_A, 'tr').map((tr) => figli(tr, NS_A, 'tc').map((tc) => {
        const b = figli(tc, NS_A, 'txBody')[0];
        return b ? testoCorpo(b) : '';
      }));
      out.push({ id: `S${n}.T${kt}`, tipo: 'tabella', el, tbl, righe, bbox: riquadro(el) });
    }
  }
  return out;
}

// Apre il template. Restituisce { zip, presDoc, relDoc, slideSize, slide: [...] }.
export async function leggiTemplate(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw httpError(400, 'Il file non è un .pptx: i vecchi file .ppt vanno prima salvati come .pptx da PowerPoint');
  }
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch { throw httpError(400, 'File .pptx danneggiato o non leggibile'); }
  const { presDoc, relDoc, slideSize, elenco } = await struttura(zip);
  if (!elenco.length) throw httpError(400, 'La presentazione non contiene slide');
  if (elenco.length > MAX_SLIDE) throw httpError(400, `La presentazione ha troppe slide (massimo ${MAX_SLIDE})`);
  const slide = [];
  for (let i = 0; i < elenco.length; i++) {
    const f = zip.file(elenco[i].file);
    if (!f) continue;
    const doc = parseXml(await f.async('string'));
    slide.push({ n: i + 1, ...elenco[i], doc, elementi: elementiSlide(doc, i + 1) });
  }
  return { zip, presDoc, relDoc, slideSize, slide };
}

// Descrizione testuale del template per l'AI: codici, tipo, posizione (% della slide) e testi.
export function descriviTemplate(template) {
  const { w, h } = template.slideSize;
  const pos = (b) => (b ? ` (x ${Math.round(b.x / w * 100)}%, y ${Math.round(b.y / h * 100)}%, larg ${Math.round(b.w / w * 100)}%, alt ${Math.round(b.h / h * 100)}%)` : ' (posizione dal layout)');
  const righe = [];
  for (const s of template.slide) {
    righe.push(`=== SLIDE ${s.n} [S${s.n}] ===`);
    if (!s.elementi.length) righe.push('(nessun elemento)');
    // A quale testo appartiene ogni forma/icona: così l'AI non scambia il riquadro di una
    // licenza (con la descrizione in una casella a parte) per un riquadro vuoto da togliere.
    const collegati = collegamenti(s, template.slideSize);
    const breve = (t) => `${t.id} «${String(t.testo || '').split('\n')[0].slice(0, 40)}»`;
    const appartenenza = (e) => {
      const caselle = collegati.get(e);
      if (caselle) return caselle.length ? ` — insieme a: ${caselle.map(breve).join(', ')}` : ' — nessun testo collegato';
      const contenitore = [...collegati.keys()].find((a) => a !== e && e.bbox && centroDentro(e.bbox, a.bbox));
      return contenitore ? ` — dentro ${contenitore.id}` : '';
    };
    for (const e of s.elementi) {
      if (e.tipo === 'testo') {
        righe.push(`[${e.id}] ${e.casella ? 'casella di testo' : `${e.geom} con testo`}${pos(e.bbox)}${e.casella ? '' : appartenenza(e)}: ${e.testo ? e.testo.replace(/\n/g, '\n    ') : '(vuota)'}`);
      } else if (e.tipo === 'forma') {
        righe.push(`[${e.id}] ${e.geom} senza testo${e.body ? ' (può ricevere testo)' : ''}${pos(e.bbox)}${appartenenza(e)}`);
      } else if (e.tipo === 'immagine') {
        righe.push(`[${e.id}] immagine/icona${pos(e.bbox)}${appartenenza(e)}`);
      } else {
        righe.push(`[${e.id}] TABELLA ${e.righe.length} righe x ${(e.righe[0] || []).length} colonne${pos(e.bbox)}:`);
        e.righe.forEach((r, i) => righe.push(`    riga ${i + 1}: ${r.map((c) => c.replace(/\n/g, ' / ')).join(' | ')}`));
      }
    }
  }
  return righe.join('\n');
}

// ---------- Pulizia automatica ----------
// Forme "ancora" (non contenute in un'altra forma, non troppo grandi): ogni casella di testo
// si collega alla forma più vicina sopra/sotto/intorno a lei. Se tutte le caselle collegate a
// una forma sono vuote e almeno una l'ha svuotata o tolta l'AI, si tolgono la forma, ciò che
// contiene (icone) e le caselle collegate.
// Forme "ancora" e caselle di testo collegate: Map forma -> [caselle]. Usata sia per la
// pulizia sia per dire all'AI a quale testo appartiene ogni forma.
function collegamenti(s, slideSize) {
  const areaSlide = slideSize.w * slideSize.h;
  // Forme disegnate (anche con testo dentro, es. riquadro con la descrizione) e immagini.
  const grafiche = s.elementi.filter((e) => e.bbox && (e.tipo === 'immagine' || (e.el.localName === 'sp' && !e.casella)));
  const ancore = grafiche.filter((g) => g.bbox.w * g.bbox.h <= MAX_AREA_PULIZIA * areaSlide
    && !grafiche.some((a) => a !== g && a.bbox.w * a.bbox.h > g.bbox.w * g.bbox.h && centroDentro(g.bbox, a.bbox)));
  const collegati = new Map(ancore.map((a) => [a, []]));
  for (const t of s.elementi.filter((e) => e.tipo === 'testo' && e.casella && e.bbox)) {
    let migliore = null, dist = Infinity;
    for (const a of ancore) {
      // Caselle molto più larghe della forma (es. il titolo della slide) non le appartengono.
      if (t.bbox.w > 2 * a.bbox.w) continue;
      const d = distanzaVerticale(t.bbox, a.bbox);
      if (d == null || d > 0.35 * Math.max(t.bbox.h, a.bbox.h)) continue;
      if (d < dist) { dist = d; migliore = a; }
    }
    if (migliore) collegati.get(migliore).push(t);
  }
  return collegati;
}

function pulisciSlide(s, slideSize, svuotate, tolti) {
  const collegati = collegamenti(s, slideSize);
  const vuota = (t) => tolti.has(t) || !String(t.testoFinale ?? t.testo).trim();
  // Protezione: una forma con testi collegati ancora pieni (es. il riquadro di una licenza
  // che resta) non si toglie, anche se l'AI l'ha chiesto.
  for (const [a, caselle] of collegati) {
    if (tolti.has(a) && caselle.some((t) => !vuota(t))) tolti.delete(a);
  }
  for (const [a, caselle] of collegati) {
    // Il testo dentro la forma stessa conta come una delle sue caselle.
    const testi = a.tipo === 'testo' ? [a, ...caselle] : caselle;
    const decisa = tolti.has(a) || (testi.length && testi.every(vuota) && testi.some((t) => svuotate.has(t) || tolti.has(t)));
    if (!decisa) continue;
    tolti.add(a);
    caselle.forEach((t) => tolti.add(t));
    s.elementi.forEach((e) => { if (e !== a && e.bbox && centroDentro(e.bbox, a.bbox) && (e.tipo !== 'testo' || vuota(e))) tolti.add(e); });
  }
}

// ---------- Riallineamento dei blocchi rimasti ----------
// Blocco = forma ancora con le sue caselle collegate e ciò che contiene (es. riquadro licenza
// con titolo, icona e descrizione; cerchio persona con nome/ruolo/email). Se in una slide
// alcuni blocchi vengono tolti, i rimasti si ridispongono a righe (al massimo quanti ne
// stavano nella riga più piena del template), con la stessa distanza tra blocchi e tra righe
// del template, centrati nell'area che i blocchi occupavano.
// Nodo di primo livello della slide che contiene l'elemento (l'elemento stesso o il gruppo
// PowerPoint, anche annidato, di cui fa parte): è ciò che si sposta.
function radice(el) {
  let n = el;
  while (n.parentNode && n.parentNode.nodeType === 1 && n.parentNode.localName !== 'spTree') n = n.parentNode;
  return n;
}

function blocchiSlide(s, slideSize) {
  const out = [];
  for (const [a, caselle] of collegamenti(s, slideSize)) {
    if (!caselle.length) continue;
    const membri = new Set([a, ...caselle]);
    s.elementi.forEach((e) => { if (e !== a && e.bbox && centroDentro(e.bbox, a.bbox)) membri.add(e); });
    const b = [...membri].map((e) => e.bbox).filter(Boolean);
    const x = Math.min(...b.map((r) => r.x)), y = Math.min(...b.map((r) => r.y));
    out.push({ ancora: a, membri: [...membri], nodi: [...new Set([...membri].map((e) => radice(e.el)))],
      x, y, w: Math.max(...b.map((r) => r.x + r.w)) - x, h: Math.max(...b.map((r) => r.y + r.h)) - y });
  }
  return out;
}

// Titolo del blocco: la più corta delle sue caselle di testo non vuote (es. "Nota Spese"),
// con le modifiche dell'AI. testi: Map id -> testo modificato.
function titoloBlocco(b, testi = new Map()) {
  const t = b.membri.filter((e) => e.tipo === 'testo' && e.casella)
    .map((e) => String(testi.has(e.id) ? testi.get(e.id) : e.testo).split('\n')[0].trim()).filter(Boolean);
  return t.sort((p, q) => p.length - q.length)[0] || '';
}

// Blocchi che l'AI chiede di spostare in un'altra slide: [{ id, titolo }] (per controllarli).
export function spostamentiRichiesti(template, modifiche) {
  const testi = new Map();
  for (const m of Array.isArray(modifiche) ? modifiche : []) {
    if (m && m.id && m.testo != null && typeof m.testo !== 'object') testi.set(String(m.id).trim().toUpperCase(), String(m.testo));
  }
  const out = [];
  for (const m of Array.isArray(modifiche) ? modifiche : []) {
    if (!m || !m.sposta_in) continue;
    const id = String(m.id || '').trim().toUpperCase();
    const s = template.slide.find((x) => x.elementi.some((e) => e.id === id));
    const b = s && blocchiSlide(s, template.slideSize).find((x) => x.membri.some((e) => e.id === id));
    out.push({ id, titolo: b ? titoloBlocco(b, testi) : '' });
  }
  return out;
}

// Blocchi in righe: stessa riga se il centro verticale è entro metà altezza media.
function righeDiBlocchi(blocchi) {
  const hMedia = blocchi.reduce((t, b) => t + b.h, 0) / (blocchi.length || 1);
  const righe = [];
  for (const b of [...blocchi].sort((p, q) => (p.y + p.h / 2) - (q.y + q.h / 2))) {
    const cy = b.y + b.h / 2;
    const r = righe.find((x) => Math.abs(x.cy - cy) <= hMedia / 2);
    if (r) { r.blocchi.push(b); r.cy = r.blocchi.reduce((t, k) => t + k.y + k.h / 2, 0) / r.blocchi.length; }
    else righe.push({ cy, blocchi: [b] });
  }
  righe.forEach((r) => r.blocchi.sort((p, q) => p.x - q.x));
  return righe.sort((p, q) => p.cy - q.cy);
}

// Sposta un nodo di primo livello (forma, immagine, tabella o gruppo intero).
function spostaNodo(el, dx, dy) {
  let xfrm = null;
  if (el.localName === 'graphicFrame') xfrm = figli(el, NS_P, 'xfrm')[0];
  else {
    const pr = figli(el, NS_P, el.localName === 'grpSp' ? 'grpSpPr' : 'spPr')[0];
    xfrm = pr ? figli(pr, NS_A, 'xfrm')[0] : null;
  }
  const off = xfrm && figli(xfrm, NS_A, 'off')[0];
  if (!off) return;
  off.setAttribute('x', String(Math.round((Number(off.getAttribute('x')) || 0) + dx)));
  off.setAttribute('y', String(Math.round((Number(off.getAttribute('y')) || 0) + dy)));
}

// aggiunti: blocchi arrivati da un'altra slide (sposta_in), messi dopo quelli già presenti.
function riallineaSlide(blocchi, tolti, aggiunti = []) {
  if (!blocchi.length) return false;
  const rimasti = blocchi.filter((b) => !tolti.has(b.ancora));
  if (!rimasti.length && !aggiunti.length) return false;
  if (rimasti.length === blocchi.length && !aggiunti.length) return false;
  // Si spostano i nodi di primo livello (elementi sciolti o gruppi interi): se un gruppo
  // contiene pezzi di due blocchi che restano, i blocchi non si possono separare.
  const proprietario = new Map();
  for (const b of [...rimasti, ...aggiunti]) {
    for (const n of b.nodi) {
      if (proprietario.has(n) && proprietario.get(n) !== b) return false;
      proprietario.set(n, b);
    }
  }
  const righeOrig = righeDiBlocchi(blocchi);
  const perRiga = Math.max(...righeOrig.map((r) => r.blocchi.length));
  const media = (v) => (v.length ? v.reduce((t, x) => t + x, 0) / v.length : 0);
  // Distanze del template: tra blocchi della stessa riga e tra righe.
  const gapX = Math.max(0, media(righeOrig.flatMap((r) => r.blocchi.slice(1).map((b, i) => b.x - (r.blocchi[i].x + r.blocchi[i].w)))));
  const limiti = righeOrig.map((r) => ({ top: Math.min(...r.blocchi.map((b) => b.y)), bottom: Math.max(...r.blocchi.map((b) => b.y + b.h)) }));
  const gapY = Math.max(0, media(limiti.slice(1).map((l, i) => l.top - limiti[i].bottom)));
  const area = {
    cx: (Math.min(...blocchi.map((b) => b.x)) + Math.max(...blocchi.map((b) => b.x + b.w))) / 2,
    cy: (Math.min(...blocchi.map((b) => b.y)) + Math.max(...blocchi.map((b) => b.y + b.h))) / 2
  };
  // Ordine di lettura del template (riga, poi da sinistra), poi a righe di perRiga blocchi.
  const ordinati = [...righeDiBlocchi(rimasti).flatMap((r) => r.blocchi), ...aggiunti];
  const nuoveRighe = [];
  for (let i = 0; i < ordinati.length; i += perRiga) nuoveRighe.push(ordinati.slice(i, i + perRiga));
  const altezze = nuoveRighe.map((r) => Math.max(...r.map((b) => b.h)));
  let y = area.cy - (altezze.reduce((t, h) => t + h, 0) + gapY * (nuoveRighe.length - 1)) / 2;
  nuoveRighe.forEach((riga, i) => {
    let x = area.cx - (riga.reduce((t, b) => t + b.w, 0) + gapX * (riga.length - 1)) / 2;
    for (const b of riga) {
      const dx = x - b.x, dy = y + (altezze[i] - b.h) / 2 - b.y;
      b.nodi.forEach((n) => { if (n.parentNode) spostaNodo(n, dx, dy); });
      x += b.w + gapX;
    }
    y += altezze[i] + gapY;
  });
  return true;
}

// ---------- Spostamento di un blocco in un'altra slide ----------
const relsDi = (file) => file.replace(/slides\/(slide[^/]+)$/, 'slides/_rels/$1.rels');
async function leggiRels(zip, file) {
  const f = zip.file(relsDi(file));
  return parseXml(f ? await f.async('string')
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
}

// Copia i nodi del blocco (elementi sciolti o gruppi interi) nella slide di destinazione (in
// fondo all'albero, sopra gli altri) con le relazioni che usano (immagini delle icone,
// collegamenti) e nuovi id di forma; li toglie dalla slide di origine. Restituisce il blocco
// con i nodi copiati (posizione ancora quella della slide di origine), null se non si può
// spostare (gruppo condiviso con un altro blocco che resta).
async function spostaBlocco(template, blocco, da, a, tolti, relsCache, altriBlocchi) {
  const nodi = blocco.nodi.filter((n) => n.parentNode
    && da.elementi.some((e) => !tolti.has(e) && radice(e.el) === n));
  if (!nodi.length) return null;
  if (altriBlocchi.some((o) => o !== blocco && !tolti.has(o.ancora) && o.nodi.some((n) => nodi.includes(n)))) return null;
  if (!relsCache.has(da.file)) relsCache.set(da.file, await leggiRels(template.zip, da.file));
  if (!relsCache.has(a.file)) relsCache.set(a.file, await leggiRels(template.zip, a.file));
  const relDa = relsCache.get(da.file), relA = relsCache.get(a.file);
  const relDaPerId = new Map(discendenti(relDa, NS_REL, 'Relationship').map((r) => [r.getAttribute('Id'), r]));
  const idUsati = new Set(discendenti(relA, NS_REL, 'Relationship').map((r) => r.getAttribute('Id')));
  const nuovoRelId = () => { let i = 1; while (idUsati.has(`rIdKo${i}`)) i += 1; idUsati.add(`rIdKo${i}`); return `rIdKo${i}`; };
  const mappaRel = new Map();
  const spTree = discendenti(a.doc, NS_P, 'spTree')[0];
  let idForma = Math.max(0, ...discendenti(a.doc, NS_P, 'cNvPr').map((c) => Number(c.getAttribute('id')) || 0));
  const copiati = [];
  for (const nodo of nodi) {
    const copia = a.doc.importNode(nodo, true);
    // Relazioni (r:embed, r:link, r:id): copiate nella slide di destinazione con un nuovo id.
    for (const n of [copia, ...Array.from(copia.getElementsByTagName('*'))]) {
      for (const att of Array.from(n.attributes || [])) {
        if (att.namespaceURI !== NS_R) continue;
        const vecchio = att.value;
        if (!mappaRel.has(vecchio)) {
          const r = relDaPerId.get(vecchio);
          if (!r) continue;
          const nuovo = r.cloneNode(true);
          const nid = nuovoRelId();
          nuovo.setAttribute('Id', nid);
          relA.documentElement.appendChild(relA.importNode(nuovo, true));
          mappaRel.set(vecchio, nid);
        }
        n.setAttributeNS(NS_R, att.name, mappaRel.get(vecchio));
      }
    }
    for (const c of discendenti(copia, NS_P, 'cNvPr')) c.setAttribute('id', String(++idForma));
    spTree.appendChild(copia);
    nodo.parentNode.removeChild(nodo);
    copiati.push(copia);
  }
  return { ...blocco, nodi: copiati };
}

// ---------- Foto delle persone (Kick-off, slide del team) ----------
// La foto della rubrica va dentro la forma del blocco della persona (es. il cerchio sopra
// nome/ruolo/email): la forma colorata del template resta e fa da anello, la foto (stessa
// sagoma, più piccola, centrata) le si appoggia sopra, ritagliata al centro per non
// deformarsi. Se il blocco ha un'immagine al posto della forma, si sostituisce l'immagine.
// La persona si riconosce dalla sua email scritta nel blocco.
const REL_IMMAGINE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
// La foto occupa l'84% del diametro della forma: il resto resta visibile come anello colorato.
const FOTO_DENTRO_FORMA = 0.84;

// Larghezza e altezza di un PNG o JPEG (null se non leggibili).
function dimensioniImmagine(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) { i += 1; continue; }
      const m = buf[i + 1];
      if ((m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) || (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF)) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

// Ritaglio (in millesimi di percento) per adattare la foto alle proporzioni della forma:
// in larghezza si toglie lo stesso dai due lati, in altezza più dal basso (il viso è in alto).
function ritaglioFoto(dim, bbox) {
  if (!dim || !dim.w || !dim.h || !bbox || !bbox.w || !bbox.h) return { l: 0, t: 0, r: 0, b: 0 };
  const a = dim.w / dim.h, t = bbox.w / bbox.h;
  if (a > t) { const via = (1 - t / a) * 100000; return { l: Math.round(via / 2), t: 0, r: Math.round(via / 2), b: 0 }; }
  const via = (1 - a / t) * 100000;
  return { l: 0, t: Math.round(via * 0.25), r: 0, b: Math.round(via * 0.75) };
}

async function mettiFoto(template, s, ancora, foto, relsCache, stato) {
  const el = ancora.el;
  const ext = foto.mime === 'image/png' ? 'png' : 'jpeg';
  // File dell'immagine: uno per persona, riusato se la persona compare in più slide.
  if (!stato.file.has(foto.chiave)) {
    let n = 1;
    while (template.zip.file(`ppt/media/projexa_foto_${n}.${ext}`)) n += 1;
    const nome = `projexa_foto_${n}.${ext}`;
    template.zip.file(`ppt/media/${nome}`, foto.data);
    stato.file.set(foto.chiave, nome);
    stato.estensioni.add(ext);
  }
  if (!relsCache.has(s.file)) relsCache.set(s.file, await leggiRels(template.zip, s.file));
  const rels = relsCache.get(s.file);
  const usati = new Set(discendenti(rels, NS_REL, 'Relationship').map((r) => r.getAttribute('Id')));
  let k = 1;
  while (usati.has(`rIdKoFoto${k}`)) k += 1;
  const relId = `rIdKoFoto${k}`;
  const rel = rels.createElementNS(NS_REL, 'Relationship');
  rel.setAttribute('Id', relId);
  rel.setAttribute('Type', REL_IMMAGINE);
  rel.setAttribute('Target', `../media/${stato.file.get(foto.chiave)}`);
  rels.documentElement.appendChild(rel);

  const doc = el.ownerDocument;
  const crop = ritaglioFoto(dimensioniImmagine(foto.data), ancora.bbox);
  const srcRect = doc.createElementNS(NS_A, 'a:srcRect');
  for (const [k2, v] of Object.entries(crop)) if (v) srcRect.setAttribute(k2, String(v));
  if (el.localName === 'pic') {
    const bf = figli(el, NS_P, 'blipFill')[0];
    const blip = bf && figli(bf, NS_A, 'blip')[0];
    if (!blip) return false;
    blip.setAttributeNS(NS_R, 'r:embed', relId);
    figli(bf, NS_A, 'srcRect').forEach((x) => bf.removeChild(x));
    bf.insertBefore(srcRect, blip.nextSibling);
    return true;
  }
  // Forma (es. il cerchio colorato): resta com'è e diventa l'anello attorno alla foto. Sopra
  // si aggiunge un'immagine con la stessa sagoma (cerchio), centrata e più piccola
  // (FOTO_DENTRO_FORMA del diametro), ritagliata alle sue proporzioni.
  const spPr = figli(el, NS_P, 'spPr')[0];
  const xfrm = spPr && figli(spPr, NS_A, 'xfrm')[0];
  const off = xfrm && figli(xfrm, NS_A, 'off')[0], est = xfrm && figli(xfrm, NS_A, 'ext')[0];
  if (!off || !est) return false;
  const x = Number(off.getAttribute('x')) || 0, y = Number(off.getAttribute('y')) || 0;
  const w = Number(est.getAttribute('cx')) || 0, h = Number(est.getAttribute('cy')) || 0;
  if (!w || !h) return false;
  const pw = Math.round(w * FOTO_DENTRO_FORMA), ph = Math.round(h * FOTO_DENTRO_FORMA);
  const crop2 = ritaglioFoto(dimensioniImmagine(foto.data), { w: pw, h: ph });
  const sagoma = (discendenti(spPr, NS_A, 'prstGeom')[0] || null);
  const prst = sagoma ? sagoma.getAttribute('prst') : 'ellipse';
  const idForma = Math.max(0, ...discendenti(doc, NS_P, 'cNvPr').map((c) => Number(c.getAttribute('id')) || 0)) + 1;
  const pic = parseXml(`<p:pic xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">`
    + `<p:nvPicPr><p:cNvPr id="${idForma}" name="Foto ${String(foto.chiave).replace(/[<>&"]/g, '')}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="${relId}"/><a:srcRect${Object.entries(crop2).filter(([, v]) => v).map(([k2, v]) => ` ${k2}="${v}"`).join('')}/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr><a:xfrm><a:off x="${Math.round(x + (w - pw) / 2)}" y="${Math.round(y + (h - ph) / 2)}"/><a:ext cx="${pw}" cy="${ph}"/></a:xfrm>`
    + `<a:prstGeom prst="${prst || 'ellipse'}"><a:avLst/></a:prstGeom></p:spPr></p:pic>`).documentElement;
  // Subito sopra la forma (stesso gruppo, se la forma è in un gruppo): stesse coordinate.
  el.parentNode.insertBefore(doc.importNode(pic, true), el.nextSibling);
  return true;
}

// Tipi di contenuto delle immagini aggiunte (Default per estensione).
async function registraEstensioni(zip, estensioni) {
  const ct = zip.file('[Content_Types].xml');
  if (!ct || !estensioni.size) return;
  const doc = parseXml(await ct.async('string'));
  const presenti = new Set(discendenti(doc, NS_CT, 'Default').map((d) => String(d.getAttribute('Extension') || '').toLowerCase()));
  for (const ext of estensioni) {
    if (presenti.has(ext)) continue;
    const d = doc.createElementNS(NS_CT, 'Default');
    d.setAttribute('Extension', ext);
    d.setAttribute('ContentType', ext === 'png' ? 'image/png' : 'image/jpeg');
    doc.documentElement.insertBefore(d, doc.documentElement.firstChild);
  }
  zip.file('[Content_Types].xml', new XMLSerializer().serializeToString(doc));
}

// Gruppi rimasti vuoti dopo aver tolto gli elementi: si tolgono anche loro.
function togliGruppiVuoti(doc) {
  let tolto = true;
  while (tolto) {
    tolto = false;
    for (const g of discendenti(doc, NS_P, 'grpSp')) {
      const pieno = ['sp', 'pic', 'graphicFrame', 'cxnSp'].some((n) => discendenti(g, NS_P, n).length);
      if (!pieno && g.parentNode) { g.parentNode.removeChild(g); tolto = true; }
    }
  }
}

// Toglie una slide: elenco della presentazione (anche nelle sezioni), relazione, file della
// slide, note collegate e tipi di contenuto.
async function togliSlide(template, s) {
  const { zip, presDoc, relDoc } = template;
  for (const el of Array.from(presDoc.getElementsByTagName('*'))) {
    if (el.localName === 'sldId' && el.getAttribute('id') === s.sldId && el.parentNode) el.parentNode.removeChild(el);
  }
  for (const r of discendenti(relDoc, NS_REL, 'Relationship')) {
    if (r.getAttribute('Id') === s.relId) r.parentNode.removeChild(r);
  }
  const daTogliere = [s.file];
  const relsFile = s.file.replace(/slides\/(slide[^/]+)$/, 'slides/_rels/$1.rels');
  const rels = zip.file(relsFile);
  if (rels) {
    daTogliere.push(relsFile);
    const doc = parseXml(await rels.async('string'));
    for (const r of discendenti(doc, NS_REL, 'Relationship')) {
      if (!/notesSlide$/.test(r.getAttribute('Type') || '')) continue;
      const note = `ppt/${String(r.getAttribute('Target') || '').replace(/^\.\.\//, '')}`;
      daTogliere.push(note, note.replace(/notesSlides\/([^/]+)$/, 'notesSlides/_rels/$1.rels'));
    }
  }
  const ct = zip.file('[Content_Types].xml');
  if (ct) {
    const ctDoc = parseXml(await ct.async('string'));
    for (const o of discendenti(ctDoc, NS_CT, 'Override')) {
      if (daTogliere.includes(String(o.getAttribute('PartName') || '').replace(/^\//, ''))) o.parentNode.removeChild(o);
    }
    zip.file('[Content_Types].xml', new XMLSerializer().serializeToString(ctDoc));
  }
  daTogliere.forEach((f) => { if (zip.file(f)) zip.remove(f); });
}

// Testo che avrà la presentazione con queste modifiche (senza applicarle): serve a
// controllare, prima di creare il file, che l'AI non abbia perso dati (licenze, persone).
// Gli elementi tolti dalla pulizia automatica sono solo quelli vuoti, quindi non contano.
export function testoRisultante(template, modifiche) {
  const mod = new Map();
  const slideTolte = new Set();
  for (const m of Array.isArray(modifiche) ? modifiche : []) {
    const id = String((m && m.id) || '').trim().toUpperCase();
    if (m && (m.elimina_slide === true || m.elimina_slide === 'true')) slideTolte.add(id);
    else if (m) mod.set(id, m);
  }
  const parti = [];
  for (const s of template.slide) {
    // Slide tolta: restano solo i blocchi spostati in un'altra slide (sposta_in).
    let salvati = null;
    if (slideTolte.has(`S${s.n}`)) {
      const spostati = s.elementi.filter((e) => { const m = mod.get(e.id); return m && m.sposta_in && String(m.sposta_in).trim().toUpperCase() !== `S${s.n}`; });
      if (!spostati.length) continue;
      salvati = new Set(blocchiSlide(s, template.slideSize).filter((b) => b.membri.some((x) => spostati.includes(x))).flatMap((b) => b.membri));
    }
    for (const e of s.elementi) {
      if (salvati && !salvati.has(e)) continue;
      const m = mod.get(e.id);
      if (m && (m.elimina === true || m.elimina === 'true')) continue;
      if (e.tipo === 'tabella') parti.push(...(m && Array.isArray(m.righe) ? m.righe : e.righe).flat().map((c) => String(c ?? '')));
      else parti.push(m && m.testo != null && typeof m.testo !== 'object' ? String(m.testo) : e.testo);
    }
  }
  return parti.join('\n');
}

// Applica le modifiche dell'AI. Restituisce { buffer, applicate, ignorate, slideTolte, elementiTolti }.
// opzioni.foto: Map email (minuscolo) -> { data: Buffer, mime } con le foto delle persone del
// team; si mettono nella forma del blocco in cui compare l'email (vedi mettiFoto).
export async function applicaModifiche(template, modifiche, opzioni = {}) {
  const perId = new Map();
  const perSlide = new Map(template.slide.map((s) => [`S${s.n}`, s]));
  for (const s of template.slide) for (const e of s.elementi) perId.set(e.id, { s, e });
  const toccate = new Set(), svuotate = new Set(), tolti = new Set(), slideDaTogliere = new Set();
  const spostamenti = []; // { e, da, a }: blocco che contiene e, da spostare nella slide a
  let applicate = 0, ignorate = 0;
  for (const m of Array.isArray(modifiche) ? modifiche : []) {
    const id = String((m && m.id) || '').trim().toUpperCase().replace(/^S(\d+)\.T/, 'S$1.T');
    if (m && (m.elimina_slide === true || m.elimina_slide === 'true') && perSlide.has(id)) {
      slideDaTogliere.add(perSlide.get(id));
      applicate += 1;
      continue;
    }
    const x = perId.get(id);
    if (!x) { ignorate += 1; continue; }
    const { s, e } = x;
    // Spostamento del blocco in un'altra slide (eventuale "testo" nella stessa modifica vale).
    if (m.sposta_in) {
      const dest = perSlide.get(String(m.sposta_in).trim().toUpperCase());
      if (dest && dest !== s) {
        spostamenti.push({ e, da: s, a: dest });
        toccate.add(s);
        toccate.add(dest);
        if (m.testo == null) { applicate += 1; continue; }
      }
    }
    if (m.elimina === true || m.elimina === 'true') {
      tolti.add(e);
    } else if ((e.tipo === 'testo' || e.tipo === 'forma') && e.body && m.testo != null && typeof m.testo !== 'object') {
      const nuovo = String(m.testo);
      scriviCorpo(e.body, nuovo);
      e.testoFinale = nuovo;
      if (!nuovo.trim() && String(e.testo).trim()) svuotate.add(e);
    } else if (e.tipo === 'tabella' && Array.isArray(m.righe)) {
      const nuove = m.righe.filter(Array.isArray);
      let trs = figli(e.tbl, NS_A, 'tr');
      if (!trs.length || !nuove.length) { ignorate += 1; continue; }
      while (trs.length < nuove.length) {
        e.tbl.appendChild(trs[trs.length - 1].cloneNode(true));
        trs = figli(e.tbl, NS_A, 'tr');
      }
      trs.slice(nuove.length).forEach((tr) => e.tbl.removeChild(tr));
      nuove.forEach((celle, i) => {
        figli(trs[i], NS_A, 'tc').forEach((tc, j) => {
          const b = figli(tc, NS_A, 'txBody')[0];
          if (b) scriviCorpo(b, celle[j] == null ? '' : String(celle[j]));
        });
      });
    } else {
      ignorate += 1;
      continue;
    }
    applicate += 1;
    toccate.add(s);
  }
  if (slideDaTogliere.size >= template.slide.length) {
    throw httpError(502, 'L\'AI ha chiesto di togliere tutte le slide: controlla il prompt e riprova');
  }
  // Blocchi di ogni slide con le posizioni del template, poi pulizia automatica.
  const blocchiPer = new Map();
  for (const s of toccate) {
    blocchiPer.set(s, blocchiSlide(s, template.slideSize));
    if (!slideDaTogliere.has(s)) pulisciSlide(s, template.slideSize, svuotate, tolti);
  }
  // Blocchi da spostare (una volta sola ciascuno; la destinazione non può essere una slide tolta).
  const daSpostare = new Map(); // blocco -> { da, a }
  for (const sp of spostamenti) {
    const b = (blocchiPer.get(sp.da) || []).find((x) => x.membri.includes(sp.e));
    if (!b || tolti.has(b.ancora) || slideDaTogliere.has(sp.a) || daSpostare.has(b)) continue;
    daSpostare.set(b, sp);
  }
  const ancoreSpostate = new Set([...daSpostare.keys()].map((b) => b.ancora));
  const destinazioni = new Set([...daSpostare.values()].map((sp) => sp.a));
  let slideRiallineate = 0;
  // Slide di origine (e le altre toccate): i blocchi spostati contano come tolti.
  for (const s of toccate) {
    if (slideDaTogliere.has(s) || destinazioni.has(s)) continue;
    if (riallineaSlide(blocchiPer.get(s), new Set([...tolti, ...ancoreSpostate]))) slideRiallineate += 1;
  }
  const relsCache = new Map();
  const arrivati = new Map(); // slide -> blocchi copiati
  for (const [b, sp] of daSpostare) {
    const copiato = await spostaBlocco(template, b, sp.da, sp.a, tolti, relsCache, blocchiPer.get(sp.da) || []);
    if (!copiato) continue;
    if (!arrivati.has(sp.a)) arrivati.set(sp.a, []);
    arrivati.get(sp.a).push(copiato);
  }
  for (const s of destinazioni) {
    if (riallineaSlide(blocchiPer.get(s) || [], tolti, arrivati.get(s) || [])) slideRiallineate += 1;
  }
  let elementiTolti = 0;
  for (const e of tolti) {
    if (e.el.parentNode) { e.el.parentNode.removeChild(e.el); elementiTolti += 1; }
  }
  // Foto delle persone: nel blocco (cerchio + nome/ruolo/email) in cui compare la loro email.
  let fotoMesse = 0;
  const foto = opzioni.foto instanceof Map ? opzioni.foto : null;
  if (foto && foto.size) {
    const stato = { file: new Map(), estensioni: new Set() };
    for (const s of template.slide) {
      if (slideDaTogliere.has(s)) continue;
      for (const b of blocchiPer.get(s) || blocchiSlide(s, template.slideSize)) {
        const a = b.ancora;
        if (tolti.has(a) || !a.el.parentNode) continue;
        // Forma con un suo testo (es. riquadro con la descrizione): non è il posto per una foto.
        if (a.tipo === 'testo' && String(a.testoFinale ?? a.testo).trim()) continue;
        const testo = b.membri.filter((e) => e.tipo === 'testo' && !tolti.has(e))
          .map((e) => String(e.testoFinale ?? e.testo)).join('\n').toLowerCase();
        const chiave = [...foto.keys()].find((email) => email && testo.includes(email));
        if (!chiave) continue;
        if (await mettiFoto(template, s, a, { ...foto.get(chiave), chiave }, relsCache, stato)) {
          fotoMesse += 1;
          toccate.add(s);
        }
      }
    }
    await registraEstensioni(template.zip, stato.estensioni);
  }
  const ser = new XMLSerializer();
  for (const s of toccate) {
    if (slideDaTogliere.has(s)) continue;
    togliGruppiVuoti(s.doc);
    template.zip.file(s.file, ser.serializeToString(s.doc));
  }
  for (const [file, doc] of relsCache) {
    if (![...slideDaTogliere].some((s) => s.file === file)) template.zip.file(relsDi(file), ser.serializeToString(doc));
  }
  for (const s of slideDaTogliere) await togliSlide(template, s);
  if (slideDaTogliere.size) {
    template.zip.file('ppt/presentation.xml', ser.serializeToString(template.presDoc));
    template.zip.file('ppt/_rels/presentation.xml.rels', ser.serializeToString(template.relDoc));
  }
  const buffer = await template.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, applicate, ignorate, slideTolte: slideDaTogliere.size, elementiTolti, slideRiallineate, blocchiSpostati: daSpostare.size, fotoMesse };
}

// Le AI a volte vanno a capo davvero dentro un testo JSON (non ammesso): si convertono in \n.
function aggiustaJson(s) {
  let out = '', inStringa = false, escape = false;
  for (const c of s) {
    if (inStringa) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inStringa = false;
      else if (c === '\n') { out += '\\n'; continue; }
      else if (c === '\r') continue;
      else if (c === '\t') { out += '\\t'; continue; }
    } else if (c === '"') inStringa = true;
    out += c;
  }
  return out;
}

// JSON dalla risposta dell'AI (anche dentro ```json ... ```), null se non leggibile.
function estraiJson(testo) {
  const t = String(testo || '').trim();
  const blocco = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const grezzo = blocco ? blocco[1] : t;
  const inizio = grezzo.indexOf('{'), fine = grezzo.lastIndexOf('}');
  const ini2 = grezzo.indexOf('['), fin2 = grezzo.lastIndexOf(']');
  const parse = (s) => { try { return JSON.parse(s); } catch { return JSON.parse(aggiustaJson(s)); } };
  try {
    if (inizio >= 0 && fine > inizio && (ini2 < 0 || inizio < ini2)) return parse(grezzo.slice(inizio, fine + 1));
    if (ini2 >= 0 && fin2 > ini2) return parse(grezzo.slice(ini2, fin2 + 1));
  } catch { /* JSON non valido */ }
  return null;
}

// Risposta della revisione: { ok, problemi: [...], modifiche: [...] | null }.
// ok = true: la bozza va bene; altrimenti modifiche = elenco COMPLETO corretto.
export function leggiRevisioneAi(testo) {
  const dati = estraiJson(testo);
  if (!dati || typeof dati !== 'object') throw httpError(502, 'Revisione: risposta dell\'AI non leggibile');
  const problemi = (Array.isArray(dati.problemi) ? dati.problemi : []).map((p) => String(p)).filter(Boolean);
  const modifiche = Array.isArray(dati.modifiche) ? dati.modifiche : (Array.isArray(dati) ? dati : null);
  const ok = dati.ok === true || dati.ok === 'true' || (!modifiche && !problemi.length);
  return { ok, problemi, modifiche: ok ? null : modifiche };
}

// Elenco delle modifiche dalla risposta dell'AI (JSON, anche dentro ```json ... ```).
export function leggiRispostaAi(testo) {
  const dati = estraiJson(testo);
  const lista = Array.isArray(dati) ? dati : (dati && Array.isArray(dati.modifiche) ? dati.modifiche : null);
  if (!lista) throw httpError(502, 'L\'AI non ha restituito le modifiche nel formato richiesto: riprova o semplifica il prompt');
  return lista;
}
