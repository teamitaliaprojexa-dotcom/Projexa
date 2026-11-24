// ============================================================================
// Qlik › «Voucher da CRM» (2026-11-24): abbinamento dei tecnici del file CRM alla rubrica.
// ----------------------------------------------------------------------------
// Il file del CRM ha solo il nome del tecnico (colonna «Tecnico»), a volte con nome e
// cognome invertiti o in maiuscolo. Dalla rubrica del TENANT (stesso perimetro
// dell'import voucher) si ricavano nominativo, email e codice articolo
// (rubrica.codice_articolo = proj_worker_cost.cod_billing).
// Il confronto ignora maiuscole, accenti, punteggiatura e ordine delle parole
// («RICCARDO PONCINI» = «Poncini Riccardo»); la parola «HR» in maiuscolo nel Tecnico
// si ignora («Alice Coco HR» = «Alice Coco»). nominativo ed email sono cifrati a
// riposo: si leggono dal pool (che decifra) e si confrontano in JavaScript.
// Più persone diverse (email diverse) con lo stesso nome = ambiguo, la riga non si
// gestisce. Le righe della rubrica scadute valgono solo se non ce n'è una attiva.
// ============================================================================

// «Daccò Yanko» -> "dacco yanko"; parole in ordine alfabetico.
export function chiaveNome(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ');
}

// «Tecnico» del file -> nome da cercare: la parola «HR» scritta in maiuscolo si toglie
// («Alice Coco HR» -> «Alice Coco»). «Hr» o «hr» restano, perché potrebbero far parte del nome.
export function nomeTecnico(nome) {
  return String(nome || '').replace(/(^|\s)HR(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
}

// nomi: elenco dei «Tecnico» del file. Restituisce
// { trovati: { <nome del file>: { nominativo, email, codiceArticolo } }, nonTrovati: [...], ambigui: [...] }
export async function abbinaTecniciRubrica(pool, tenantId, nomi) {
  const hasCodice = (await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'rubrica' AND column_name = 'codice_articolo'`
  )).rows.length > 0;
  const r = await pool.query(
    `SELECT nominativo, email, ${hasCodice ? 'codice_articolo' : 'NULL::text AS codice_articolo'},
            (scadenza IS NULL OR scadenza >= CURRENT_DATE) AS attiva
       FROM rubrica WHERE tenant_id = $1`,
    [tenantId]
  );
  // chiave nome -> Map(email -> { nominativo, email, codiceArticolo, attiva })
  const perNome = new Map();
  for (const x of r.rows) {
    const email = String(x.email || '').trim().toLowerCase();
    const k = chiaveNome(x.nominativo);
    if (!k || !email || !email.includes('@')) continue;
    const persone = perNome.get(k) || new Map();
    const prima = persone.get(email);
    const codice = String(x.codice_articolo || '').trim();
    // Stessa persona in più rubriche (utenti del tenant): vince la riga attiva e, a
    // parità, quella con il codice articolo compilato.
    if (!prima || (x.attiva && !prima.attiva) || (x.attiva === prima.attiva && codice && !prima.codiceArticolo)) {
      persone.set(email, { nominativo: String(x.nominativo).trim(), email, codiceArticolo: codice, attiva: !!x.attiva });
    }
    perNome.set(k, persone);
  }
  const trovati = {};
  const nonTrovati = [];
  const ambigui = [];
  for (const nome of [...new Set((nomi || []).map((n) => String(n || '').trim()).filter(Boolean))]) {
    const persone = [...(perNome.get(chiaveNome(nomeTecnico(nome))) || new Map()).values()];
    const attive = persone.filter((p) => p.attiva);
    const scelte = attive.length ? attive : persone;
    if (scelte.length === 1) {
      const { nominativo, email, codiceArticolo } = scelte[0];
      trovati[nome] = { nominativo, email, codiceArticolo };
    } else if (scelte.length > 1) ambigui.push(nome);
    else nonTrovati.push(nome);
  }
  return { trovati, nonTrovati, ambigui };
}
