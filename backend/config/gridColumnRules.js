// ============================================================================
// REGOLE PER COLONNA DELLE GRIGLIE (tipo_valore = 11), per tabella
// ----------------------------------------------------------------------------
// La griglia generica (server.js, /api/:source/grid-widget*) mostra le colonne come sono
// nel database. Per alcune tabelle servono etichette diverse, valori predefiniti, elenchi
// a discesa e colonne calcolate: si descrivono qui, per nome di tabella e colonna.
//
//   label     etichetta in intestazione al posto del nome della colonna
//   default   valore proposto nelle righe nuove (e scritto se lasciato vuoto)
//   options   elenco fisso [{ id, display }]: si salva id, a video display
//   dynamic   elenco letto dal database (opzioniColonna); dependsOn = colonna della
//             stessa riga da cui dipende l'elenco
//   computed  colonna calcolata dal server (non modificabile a mano)
//   readonly  non modificabile: vale il default (nuove righe) o il valore già salvato
//   filtroSopra  etichetta di un elenco sopra la griglia che filtra le righe su questa colonna
//   unico     colonna FK con valore unico nel contesto (cliente/progetto): il menu non
//             propone i valori già presenti nelle righe attive (es. licenze del cliente)
//
// Prima tabella: config_chek_list (Impostazioni › Configura Check List, 2026-10-02).
// ============================================================================

// Tipi di campo che non si possono verificare (nodi, griglie, link, routine, ...):
// esclusi dall'elenco di campo_verif (richiesta dell'utente).
// Il tipo 11 (griglia) aggiunto il 2026-10-02: una griglia non ha un valore da verificare.
const TIPI_ESCLUSI_VERIFICA = ['17', '30', '0', '13', '20', '5', '12', '15', '16', '40', '4', '18', '50', '21', '11'];

// Colonna EAV dove il campo tiene il valore, in base al tipo_valore
// (vedi renderSettingRow in dashboard.html): booleani in valore1, numeri in valore3,
// tutto il resto (testo, email, date, elenchi) in valore2.
function colonnaPerTipo(tipo) {
  const t = String(tipo ?? '').trim();
  if (['1', '14', '22'].includes(t)) return 'valore1';
  if (['3', '8'].includes(t)) return 'valore3';
  return 'valore2';
}

// Ordinamento della check list da master (padre) e slave (figlio): ((padre * 10) + figlio) / 10.
// Senza master resta vuoto; senza slave vale il solo master (es. 2 -> 2,0).
export function ordinamentoMasterSlave(padre, figlio) {
  if (padre === null || padre === undefined || String(padre).trim() === '') return null;
  const p = Number(padre);
  const fg = figlio === null || figlio === undefined || String(figlio).trim() === '' ? 0 : Number(figlio);
  if (!Number.isFinite(p) || !Number.isFinite(fg)) return null;
  return Math.round(((p * 10) + fg) / 10 * 100) / 100;
}

// Dove si verifica la condizione. clients/projects: tabelle a campi (EAV, un campo per
// riga). righe = tabelle normali con più righe per progetto (colonne vere): la condizione è
// vera se ALMENO UNA riga attiva del progetto la soddisfa (vedi ckpCondizioneOk in server.js).
export const TABELLE_VERIFICA = [
  { id: 'clients', display: 'Clienti' },
  { id: 'projects', display: 'Progetti' },
  { id: 'cl_quotazioni', display: 'Quotazioni', righe: true },
  { id: 'task_app', display: 'Task di sviluppo', righe: true },
  // Elenco Licenze del cliente (2026-10-09): righe del CLIENTE del progetto (non del progetto),
  // un solo campo verificabile, il nome della licenza (conf_licenze_app.description), così
  // la condizione si scrive con il nome che l'utente vede (es. «uguale Moduli Presenze»).
  { id: 'licenze_app', display: 'Licenze del cliente', righe: true, perCliente: true }
];

// Colonne tecniche delle tabelle a righe: non sono campi da verificare.
const COLONNE_NON_VERIFICABILI = new Set(['id', 'tenant_id', 'user_id', 'client_id', 'project_id', 'master_id',
  'crypto', 'id_roles', 'id_roles_write', 'created_at', 'updated_at', 'created_by', 'scadenza']);
const TIPI_COLONNA_NON_VERIFICABILI = new Set(['bytea', 'json', 'jsonb', 'ARRAY', 'USER-DEFINED']);

const OPERATORI = [
  { id: '1', display: 'uguale' },
  { id: '2', display: 'diverso' },
  { id: '3', display: 'in' },
  { id: '4', display: 'like' },
  { id: '5', display: 'not like' },
  { id: '6', display: 'tra' },
  { id: '7', display: 'not in' }
];

const REGOLE = {
  config_chek_list: {
    tipologia: { dynamic: 'lookup_tipologia', filtroSopra: 'Tipologia' },
    padre: { label: 'master' },
    figlio: { label: 'slave' },
    // Per ora fisso a 'selezione', non modificabile (scelta dell'utente, 2026-10-02).
    tipo_verifica: { default: 'selezione', readonly: true },
    tabella_verif: { options: TABELLE_VERIFICA },
    campo_verif: { dynamic: 'campi_verifica', dependsOn: 'tabella_verif' },
    colonna_verif: { computed: true },
    // ((padre * 10) + figlio) / 10: master 1 + slave 1 = 1,1; master 2 + slave 1 = 2,1.
    ordinamento: { computed: true, calc: 'master_slave' },
    operatore_verif: { options: OPERATORI },
    // Campo booleano (tipo 1) con un operatore scelto: risultato = vero / falso (salvato
    // true / false). Negli altri casi resta testo libero.
    risultato_verif: { booleano: { campo: 'campo_verif', operatore: 'operatore_verif', tipo: '1' } }
  },
  // Elenco Licenze del cliente (2026-10-06): ogni licenza una sola volta per cliente.
  licenze_app: {
    licenza_id: { unico: true }
  }
};

// Etichette valide per QUALSIASI tabella che ha la colonna (le regole della singola
// tabella in REGOLE hanno la precedenza). commessa_id: FK verso proj_commessa (2026-10-06).
const ETICHETTE_COMUNI = {
  commessa_id: 'Commessa'
};

export function etichettaComune(column) {
  return ETICHETTE_COMUNI[column] || null;
}

// Ordinamento predefinito della griglia per tabella (se il campo non ne indica uno in VariabDB).
const ORDINE = {
  config_chek_list: 'src.tipologia NULLS LAST, src.ordinamento NULLS LAST, src.id'
};

export function ordineGriglia(tableName) {
  return ORDINE[tableName] || null;
}

// Filtro a elenco sopra la griglia (es. Tipologia): { column, label } o null.
export function filtroSopraGriglia(tableName) {
  const e = Object.entries(REGOLE[tableName] || {}).find(([, x]) => x.filtroSopra);
  return e ? { column: e[0], label: e[1].filtroSopra } : null;
}

export function regoleColonne(tableName) {
  return REGOLE[tableName] || null;
}

// Metadati da aggiungere a GET .../grid-widget/columns.
export function metaColonna(tableName, column) {
  const r = (REGOLE[tableName] || {})[column];
  if (!r) return ETICHETTE_COMUNI[column] ? { label: ETICHETTE_COMUNI[column] } : {};
  const out = {};
  if (r.label || ETICHETTE_COMUNI[column]) out.label = r.label || ETICHETTE_COMUNI[column];
  if (r.default !== undefined) out.default = r.default;
  if (r.options) out.options = r.options;
  if (r.dynamic) out.dynamic = true;
  if (r.dependsOn) out.dependsOn = r.dependsOn;
  if (r.computed) out.computed = true;
  if (r.calc) out.calc = r.calc;
  if (r.readonly) out.locked = true;
  if (r.booleano) out.booleano = r.booleano;
  if (r.unico) out.unico = true;
  return out;
}

// Etichette delle intestazioni per GET .../grid-widget.
export function etichetteColonne(tableName) {
  const out = { ...ETICHETTE_COMUNI };
  for (const [col, r] of Object.entries(REGOLE[tableName] || {})) if (r.label) out[col] = r.label;
  return out;
}

// Righe della griglia: per le colonne con elenco fisso a video va l'etichetta (es. Clienti),
// il valore salvato resta in "__raw_<colonna>" (stessa convenzione delle foreign key).
const VERO_FALSO = { true: 'vero', false: 'falso' };

export function etichetteValori(tableName, row) {
  for (const [col, r] of Object.entries(REGOLE[tableName] || {})) {
    if (r.booleano && Object.prototype.hasOwnProperty.call(row, col)) {
      const raw = row[col];
      if (Object.prototype.hasOwnProperty.call(VERO_FALSO, String(raw))) {
        row[`__raw_${col}`] = raw;
        row[col] = VERO_FALSO[String(raw)];
      }
      continue;
    }
    if (!r.options || !Object.prototype.hasOwnProperty.call(row, col)) continue;
    const raw = row[col];
    const opt = r.options.find((o) => String(o.id) === String(raw ?? ''));
    row[`__raw_${col}`] = raw;
    if (opt) row[col] = opt.display;
  }
  return row;
}

// Elenco per una colonna "dynamic". ctx = { tenantId, userId }, dep = valore della colonna
// da cui dipende (dalla stessa riga). Restituisce [{ id, display, colonna? }].
export async function opzioniColonna(db, tableName, column, ctx, dep) {
  const r = (REGOLE[tableName] || {})[column];
  if (!r || !r.dynamic) throw Object.assign(new Error('Colonna senza elenco'), { statusCode: 400 });

  if (r.dynamic === 'lookup_tipologia') {
    // Tipologie dei progetti: valori globali (tenant e utente vuoti) più quelli del tenant e
    // dell'utente del contesto.
    const q = await db.query(
      `SELECT valore, MIN(ordinamento) AS ord FROM lookup_values
        WHERE tabella = 'projects' AND nome_campo = 'Tipologia'
          AND scadenza >= CURRENT_DATE
          AND ((tenant_id IS NULL AND user_id IS NULL) OR (tenant_id = $1 AND user_id = $2))
          AND valore IS NOT NULL
        GROUP BY valore
        ORDER BY ord NULLS LAST, valore`,
      [ctx.tenantId, ctx.userId]
    );
    return q.rows.map((x) => ({ id: x.valore, display: x.valore }));
  }

  if (r.dynamic === 'campi_verifica') {
    const tabella = TABELLE_VERIFICA.find((t) => t.id === String(dep || ''));
    if (!tabella) return [];
    return campiVerifica(db, tabella.id, ctx);
  }
  return [];
}

// Campi di clients / projects dell'utente, tranne i tipi non verificabili, con la colonna
// in cui tengono il valore. Se lo stesso campo compare con tipi diversi vale il più usato.
// Tabelle a righe (Quotazioni, Task di sviluppo): le loro colonne, tranne quelle tecniche;
// colonna = la colonna stessa, tipo '1' per le colonne sì/no (risultato vero/falso).
export async function campiVerifica(db, tabella, ctx) {
  const def = TABELLE_VERIFICA.find((t) => t.id === tabella);
  if (tabella === 'licenze_app') return [{ id: 'licenza', display: 'Nome della licenza', colonna: 'licenza', tipo: '' }];
  if (def && def.righe) {
    const c = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [tabella]
    );
    const etichetta = (n) => { const s = String(n).replace(/_/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
    return c.rows
      .filter((x) => !COLONNE_NON_VERIFICABILI.has(x.column_name) && !TIPI_COLONNA_NON_VERIFICABILI.has(x.data_type))
      .map((x) => ({ id: x.column_name, display: etichetta(x.column_name), colonna: x.column_name, tipo: x.data_type === 'boolean' ? '1' : '' }))
      .sort((a, b) => a.display.localeCompare(b.display, 'it', { sensitivity: 'base' }));
  }
  const q = await db.query(
    `SELECT campo, tipo_valore::text AS tipo, count(*) AS n FROM "${tabella}"
      WHERE tenant_id = $1 AND user_id = $2 AND campo IS NOT NULL AND BTRIM(campo) <> ''
        AND COALESCE(tipo_valore::text, '') <> ALL($3::text[])
      GROUP BY campo, tipo_valore`,
    [ctx.tenantId, ctx.userId, TIPI_ESCLUSI_VERIFICA]
  );
  const migliore = new Map();
  for (const x of q.rows) {
    const p = migliore.get(x.campo);
    if (!p || Number(x.n) > Number(p.n)) migliore.set(x.campo, x);
  }
  return [...migliore.values()]
    .sort((a, b) => a.campo.localeCompare(b.campo, 'it', { sensitivity: 'base' }))
    .map((x) => ({ id: x.campo, display: x.campo, colonna: colonnaPerTipo(x.tipo), tipo: String(x.tipo ?? '') }));
}

/**
 * Regole in scrittura (nuova riga o modifica). data = colonne che si stanno scrivendo
 * (già filtrate); esistente = riga attuale per le modifiche (null per le nuove).
 * Applica i valori predefiniti, controlla gli elenchi fissi e calcola le colonne computed.
 */
export async function applicaRegoleScrittura(db, tableName, data, ctx, esistente = null) {
  const regole = REGOLE[tableName];
  if (!regole) return data;
  const nuova = !esistente;
  for (const [col, r] of Object.entries(regole)) {
    // Calcolati e non modificabili non si scrivono mai dal browser.
    if (r.computed || r.readonly) delete data[col];
    if (nuova && r.default !== undefined && (data[col] === undefined || data[col] === null || data[col] === '')) {
      data[col] = r.default;
    }
    if (r.options && data[col] != null && data[col] !== '' &&
        !r.options.some((o) => String(o.id) === String(data[col]))) {
      throw Object.assign(new Error(`Valore non valido per ${r.label || col}`), { statusCode: 400 });
    }
  }

  if (tableName === 'config_chek_list') {
    // ordinamento = ((padre * 10) + figlio) / 10, ricalcolato quando cambia padre o figlio.
    if (nuova || 'padre' in data || 'figlio' in data) {
      const padre = 'padre' in data ? data.padre : (esistente && esistente.padre);
      const figlio = 'figlio' in data ? data.figlio : (esistente && esistente.figlio);
      data.ordinamento = ordinamentoMasterSlave(padre, figlio);
    }

    // colonna_verif = valore1 / valore2 / valore3 secondo il tipo del campo scelto.
    const tocca = nuova || 'campo_verif' in data || 'tabella_verif' in data;
    if (tocca) {
      const tabella = 'tabella_verif' in data ? data.tabella_verif : (esistente && esistente.tabella_verif);
      const campo = 'campo_verif' in data ? data.campo_verif : (esistente && esistente.campo_verif);
      let colonna = null;
      if (tabella && campo) {
        const campi = await campiVerifica(db, tabella, ctx);
        const scelto = campi.find((c) => c.id === campo);
        if (!scelto) {
          const dove = (TABELLE_VERIFICA.find((t) => t.id === tabella) || {}).display || tabella;
          throw Object.assign(new Error(`Il campo «${campo}» non è verificabile in ${dove}`), { statusCode: 400 });
        }
        colonna = scelto.colonna;
      }
      data.colonna_verif = colonna;
    }

    // risultato_verif: campo booleano (tipo 1) + operatore -> solo 'true' / 'false'.
    if (nuova || 'campo_verif' in data || 'tabella_verif' in data || 'operatore_verif' in data || 'risultato_verif' in data) {
      const tabella = 'tabella_verif' in data ? data.tabella_verif : (esistente && esistente.tabella_verif);
      const campo = 'campo_verif' in data ? data.campo_verif : (esistente && esistente.campo_verif);
      const operatore = 'operatore_verif' in data ? data.operatore_verif : (esistente && esistente.operatore_verif);
      if (tabella && campo && operatore != null && operatore !== '') {
        const scelto = (await campiVerifica(db, tabella, ctx)).find((c) => c.id === campo);
        if (scelto && scelto.tipo === '1') {
          const attuale = 'risultato_verif' in data ? data.risultato_verif : (esistente && esistente.risultato_verif);
          const v = String(attuale ?? '').trim().toLowerCase();
          const norm = ['true', 'vero', 't', '1'].includes(v) ? 'true' : ['false', 'falso', 'f', '0'].includes(v) ? 'false' : null;
          if (attuale != null && attuale !== '' && !norm) {
            throw Object.assign(new Error('Per un campo sì/no il risultato deve essere vero o falso'), { statusCode: 400 });
          }
          if ('risultato_verif' in data) data.risultato_verif = norm;
        }
      }
    }
  }
  return data;
}
