// Apertura sicura dei file Office (.docx, .xlsx, .pptx = archivi zip), 2026-10-17.
// Un file di pochi MB può contenere parti che decompresse pesano gigabyte («zip bomb»):
// mammoth, ExcelJS e la lettura dei modelli di Kick-off/Offerta le espandevano interamente in
// memoria e il server andava in crash (in Batch il file viene rigiocato a ogni riavvio).
// Qui si leggono le dimensioni dichiarate nell'indice dello zip PRIMA di decomprimere.
import JSZip from 'jszip';

const MB = 1024 * 1024;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.statusCode = status;
  return e;
}

// Restituisce lo zip aperto (JSZip) se rispetta i limiti, altrimenti errore 413/400.
export async function apriZipSicuro(buffer, { nome = 'file', maxTotaleMb = 150, maxParteMb = 60, maxParti = 3000 } = {}) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw httpError(400, `Il file "${nome}" è danneggiato o non leggibile`);
  }
  const parti = Object.values(zip.files).filter((f) => !f.dir);
  if (parti.length > maxParti) throw httpError(413, `Il file "${nome}" contiene troppe parti`);
  let totale = 0;
  for (const f of parti) {
    // Dimensione decompressa dichiarata nell'indice (JSZip la tiene in _data).
    const n = Number(f._data && f._data.uncompressedSize);
    if (!Number.isFinite(n) || n < 0) throw httpError(400, `Il file "${nome}" non è leggibile`);
    if (n > maxParteMb * MB) throw httpError(413, `Il file "${nome}" è troppo grande una volta decompresso`);
    totale += n;
    if (totale > maxTotaleMb * MB) throw httpError(413, `Il file "${nome}" è troppo grande una volta decompresso`);
  }
  return zip;
}

// Solo il controllo (per le librerie che aprono lo zip da sé, come mammoth ed ExcelJS).
export async function controllaZip(buffer, opzioni) {
  await apriZipSicuro(buffer, opzioni);
}
