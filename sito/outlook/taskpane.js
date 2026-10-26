// ============================================================================
// PANNELLO DELL'ADD-IN DI OUTLOOK «ANALIZZA CON PROJEXA» (2026-10-22)
// ----------------------------------------------------------------------------
// Gira dentro Outlook (web, nuovo Outlook, Outlook classico, Mac) su un'email ricevuta.
// Legge SOLO l'email aperta e solo quando il PM preme «Analizza» (permesso ReadItem).
//  - Token del collegamento: nelle impostazioni dell'add-in della casella (roamingSettings),
//    quindi legato a questa casella di posta; mai nel codice o nel manifest.
//  - Ogni chiamata manda il token e la casella (X-Projexa-Mailbox): il server rifiuta se la
//    casella non è quella collegata.
//  - Il risultato si mostra solo come testo (textContent): niente HTML dall'AI nella pagina.
//  - La risposta all'email la apre Outlook (displayReplyAllForm): il PM la legge, la modifica
//    e la invia lui. Projexa non invia nulla.
// ============================================================================
(function () {
  'use strict';

  var API = '/api/outlook';
  var CHIAVE_TOKEN = 'projexaToken';
  var stato = { token: '', mailbox: '', emailId: '', lavoro: '', timer: null, risultato: null, inizioAttesa: 0 };

  function $(id) { return document.getElementById(id); }
  function mostra(id, si) { var el = $(id); if (el) el.hidden = !si; }
  function el(tag, testo, classe) {
    var e = document.createElement(tag);
    if (testo != null) e.textContent = String(testo);
    if (classe) e.className = classe;
    return e;
  }
  function avviso(testo, ok) {
    var a = $('pxAvviso');
    if (!testo) { a.hidden = true; return; }
    a.textContent = testo;
    a.className = 'px-avviso' + (ok ? ' px-ok' : '');
    a.hidden = false;
    // L'avviso è in cima al pannello: se il pannello è scorso in basso non si vedrebbe.
    try { a.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { /* client vecchi */ }
  }

  // ---------------------------------------------------------------------------
  // Chiamate a Projexa
  // ---------------------------------------------------------------------------
  function chiama(metodo, percorso, corpo) {
    var headers = { 'X-Projexa-Mailbox': stato.mailbox };
    if (stato.token) headers.Authorization = 'Bearer ' + stato.token;
    if (corpo) headers['Content-Type'] = 'application/json';
    return fetch(API + percorso, {
      method: metodo, headers: headers, body: corpo ? JSON.stringify(corpo) : undefined,
      credentials: 'omit', cache: 'no-store'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 && d.code === 'NON_COLLEGATO') { dimenticaToken(); vistaCollega(d.error); throw new Error(d.error || 'Non collegato'); }
        if (!r.ok) throw new Error(d.error || ('Errore ' + r.status));
        return { status: r.status, dati: d };
      });
    });
  }

  function salvaToken(token) {
    var rs = Office.context.roamingSettings;
    if (token) rs.set(CHIAVE_TOKEN, token); else rs.remove(CHIAVE_TOKEN);
    return new Promise(function (ok) { rs.saveAsync(function () { ok(); }); });
  }
  function dimenticaToken() { stato.token = ''; salvaToken('').catch(function () {}); }

  // ---------------------------------------------------------------------------
  // Viste
  // ---------------------------------------------------------------------------
  function vistaCollega(messaggio) {
    fermaAttesa();
    mostra('vistaAnalisi', false); mostra('vistaFuori', false); mostra('pxFoot', false); mostra('vistaRiunione', false);
    mostra('vistaCollega', true);
    $('pxChi').textContent = 'Non collegato';
    avviso(messaggio || '');
  }

  function vistaAnalisi() {
    mostra('vistaCollega', false); mostra('vistaFuori', false);
    mostra('vistaAnalisi', true); mostra('pxFoot', true);
    caricaEmailCorrente();
  }

  // ---------------------------------------------------------------------------
  // Collegamento con il codice monouso
  // ---------------------------------------------------------------------------
  function collega() {
    var codice = String($('pxCodice').value || '').trim();
    if (codice.replace(/[^A-Za-z0-9]/g, '').length < 8) { avviso('Scrivi il codice di 8 caratteri mostrato in Projexa.'); return; }
    var b = $('pxCollega');
    b.disabled = true;
    avviso('');
    var host = '';
    try { host = Office.context.diagnostics.hostName + ' ' + Office.context.diagnostics.platform; } catch (e) { host = ''; }
    chiama('POST', '/collega', { codice: codice, mailbox: stato.mailbox, host: host })
      .then(function (r) {
        stato.token = r.dati.token;
        return salvaToken(stato.token).then(function () {
          $('pxCodice').value = '';
          avviso('Outlook collegato a Projexa' + (r.dati.tenant ? ' (' + r.dati.tenant + ')' : '') + '.', true);
          return caricaUtente();
        });
      })
      .catch(function (e) { avviso(e.message); })
      .then(function () { b.disabled = false; });
  }

  function caricaUtente() {
    return chiama('GET', '/me').then(function (r) {
      var d = r.dati;
      $('pxChi').textContent = (d.utente || 'Utente') + (d.tenant ? ' · ' + d.tenant : '') + (d.ai ? ' · AI: ' + d.ai : '');
      if (!d.attivo) avviso('«AI Add-in Outlook» non è attivo in Projexa › Impostazioni › AI.');
      vistaAnalisi();
    });
  }

  function scollega() {
    if (!window.confirm('Scollegare Outlook da Projexa? Per usarlo di nuovo servirà un nuovo codice.')) return;
    chiama('DELETE', '/me').catch(function () {}).then(function () {
      dimenticaToken();
      vistaCollega('Outlook scollegato da Projexa.');
    });
  }

  // ---------------------------------------------------------------------------
  // Email aperta
  // ---------------------------------------------------------------------------
  function sha256(testo) {
    var dati = new TextEncoder().encode(testo);
    return crypto.subtle.digest('SHA-256', dati).then(function (h) {
      return Array.prototype.map.call(new Uint8Array(h), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    });
  }

  function indirizzi(lista) {
    return (lista || []).map(function (x) { return { nome: x.displayName || '', email: x.emailAddress || '' }; })
      .filter(function (x) { return x.email; });
  }

  function caricaEmailCorrente() {
    fermaAttesa();
    stato.lavoro = ''; stato.risultato = null;
    $('pxRisultato').hidden = true;
    $('pxRisultato').textContent = '';
    mostra('pxStato', false);
    var item = Office.context.mailbox.item;
    mostra('vistaRiunione', false);
    if (item && item.itemType === Office.MailboxEnums.ItemType.Appointment) {
      mostra('vistaAnalisi', false); mostra('vistaFuori', false);
      caricaRiunione(item);
      return;
    }
    if (!item || item.itemType !== Office.MailboxEnums.ItemType.Message) {
      mostra('vistaAnalisi', false); mostra('vistaFuori', true);
      return;
    }
    mostra('vistaFuori', false); mostra('vistaAnalisi', true);
    $('pxOggetto').textContent = item.subject || '(senza oggetto)';
    var da = item.from || item.sender || {};
    $('pxMittente').textContent = 'Da: ' + (da.displayName ? da.displayName + ' <' + da.emailAddress + '>' : (da.emailAddress || '-'));
    $('pxAnalizza').disabled = false;
    sha256(String(item.internetMessageId || item.itemId || item.subject || '')).then(function (h) {
      stato.emailId = h;
      // Analisi già fatta (o in corso) per questa email: si mostra senza ripeterla.
      return chiama('GET', '/lavori?email=' + h).then(function (r) {
        if (r.dati.lavoro && h === stato.emailId) { stato.lavoro = r.dati.lavoro.id; attendi(true); }
      });
    }).catch(function () { /* nessuna analisi precedente */ });
  }

  // opz (facoltativo): { clientId: cliente scelto dal PM, senzaProgetto: true = tema del solo cliente }
  function analizza(projectId, opz) {
    opz = opz || {};
    var item = Office.context.mailbox.item;
    if (!item) return;
    var b = $('pxAnalizza');
    b.disabled = true;
    avviso('');
    statoAttesa('Lettura dell\'email…');
    item.body.getAsync(Office.CoercionType.Text, function (res) {
      if (res.status !== Office.AsyncResultStatus.Succeeded) {
        b.disabled = false; mostra('pxStato', false);
        avviso('Non riesco a leggere il testo dell\'email.');
        return;
      }
      var da = item.from || item.sender || {};
      var corpo = {
        mittente: { nome: da.displayName || '', email: da.emailAddress || '' },
        a: indirizzi(item.to), cc: indirizzi(item.cc),
        oggetto: item.subject || '', testo: String(res.value || ''),
        data: item.dateTimeCreated ? new Date(item.dateTimeCreated).toISOString() : '',
        emailId: stato.emailId, projectId: projectId || '',
        clientId: opz.clientId || '', senzaProgetto: !projectId && opz.senzaProgetto === true
      };
      statoAttesa('Invio a Projexa…');
      chiama('POST', '/analizza', corpo).then(function (r) {
        stato.lavoro = r.dati.lavoro;
        attendi(false, r.dati.messaggio);
      }).catch(function (e) {
        b.disabled = false; mostra('pxStato', false);
        avviso(e.message);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Attesa del risultato (il lavoro gira sul server: si può cambiare email e tornare)
  // ---------------------------------------------------------------------------
  function statoAttesa(testo) {
    var s = $('pxStato');
    s.textContent = '';
    s.appendChild(el('span', null, 'px-spin'));
    s.appendChild(document.createTextNode(testo));
    s.hidden = false;
  }
  function fermaAttesa() { if (stato.timer) { clearTimeout(stato.timer); stato.timer = null; } }

  function attendi(giaFatta, messaggio) {
    fermaAttesa();
    stato.inizioAttesa = Date.now();
    var lavoro = stato.lavoro;
    statoAttesa(messaggio && /batch/i.test(messaggio)
      ? 'Analisi in modalità Batch: può richiedere qualche minuto. Puoi chiudere il pannello e riaprirlo dopo.'
      : 'Analisi in corso…');
    $('pxAnalizza').disabled = true;
    var giro = function () {
      if (lavoro !== stato.lavoro) return;
      chiama('GET', '/lavori/' + encodeURIComponent(lavoro)).then(function (r) {
        if (lavoro !== stato.lavoro) return;
        var d = r.dati;
        if (d.stato === 'in_corso') {
          var trascorsi = Date.now() - stato.inizioAttesa;
          stato.timer = setTimeout(giro, trascorsi < 60000 ? 3000 : 15000);
          return;
        }
        mostra('pxStato', false);
        $('pxAnalizza').disabled = false;
        if (d.stato === 'errore') { avviso('Analisi non riuscita: ' + (d.errore || 'errore')); return; }
        mostraRisultato(d.risultato || {});
        // Batch rifiutato o fallito (es. Gemini gratuito): l'analisi è stata fatta in Immediato.
        if (d.errore) avviso(d.errore, true);
      }).catch(function (e) {
        if (lavoro !== stato.lavoro) return;
        stato.timer = setTimeout(giro, 15000);
        statoAttesa('Projexa non risponde, riprovo… (' + e.message + ')');
      });
    };
    giro();
  }

  // ---------------------------------------------------------------------------
  // Risultato
  // ---------------------------------------------------------------------------
  var NOMI_TIPI = { errore: 'Segnalazione di errore', stato_ticket: 'Riscontro su ticket', data_rilascio: 'Data di rilascio', informazioni: 'Richiesta di informazioni', altro: 'Altro' };

  function mostraRisultato(r) {
    stato.risultato = r;
    var box = $('pxRisultato');
    box.textContent = '';
    box.hidden = false;
    $('pxAnalizza').textContent = 'Analizza di nuovo';
    if (r.esito === 'cliente_non_trovato') {
      box.appendChild(el('h3', 'Cliente non trovato'));
      box.appendChild(el('p', r.messaggio || ''));
      // Il PM sceglie il cliente e si rianalizza con quello.
      if (r.clienti && r.clienti.length) {
        var k0 = el('div', null, 'px-card');
        var selCl = el('select');
        r.clienti.forEach(function (x) { var o = el('option', x.nome); o.value = x.id; selCl.appendChild(o); });
        k0.appendChild(el('label', 'Cliente'));
        k0.appendChild(selCl);
        var bc = el('button', 'Analizza con questo cliente', 'px-btn px-sec');
        bc.type = 'button';
        bc.addEventListener('click', function () { analizza('', { clientId: selCl.value }); });
        k0.appendChild(bc);
        box.appendChild(k0);
      }
      return;
    }
    var c = r.cliente || {};
    box.appendChild(el('h3', 'Cliente e progetto'));
    var card = el('div', null, 'px-card');
    card.appendChild(el('div', c.nome || '-', 'px-oggetto'));
    var come = c.come === 'testo' ? 'testo dell\'email: ' + (c.motivo || '')
      : c.come === 'scelto' ? 'scelta tua'
        : (c.come === 'dominio' ? 'dominio di ' : (c.come === 'destinatario' ? 'destinatario ' : 'mittente ')) + (c.indirizzo || '') + (c.contatto ? ' (' + c.contatto + ')' : '');
    card.appendChild(el('div', 'Riconosciuto da: ' + come, 'px-muted'));
    if (r.interna) card.appendChild(el('span', 'Email interna tra colleghi', 'px-tag px-arancio'));
    var selProgetto = null;
    if (r.progetti && r.progetti.length) {
      var sel = el('select');
      selProgetto = sel;
      var nessuno = el('option', 'Nessun progetto (tema del cliente)'); nessuno.value = '';
      if (!r.progetto) nessuno.selected = true;
      sel.appendChild(nessuno);
      r.progetti.forEach(function (p) {
        var o = el('option', p.nome); o.value = p.id;
        if (r.progetto && r.progetto.id === p.id) o.selected = true;
        sel.appendChild(o);
      });
      var lab = el('label', 'Progetto (cambia e rianalizza se non è quello giusto)');
      card.appendChild(lab); card.appendChild(sel);
      var rb = el('button', 'Rianalizza con questo progetto', 'px-btn px-sec');
      rb.type = 'button';
      rb.addEventListener('click', function () { analizza(sel.value, { clientId: c.id, senzaProgetto: !sel.value }); });
      card.appendChild(rb);
    } else {
      card.appendChild(el('div', 'Progetto: nessun progetto aperto', 'px-muted'));
    }
    box.appendChild(card);

    if (r.tipi && r.tipi.length) {
      var t = el('div');
      r.tipi.forEach(function (x) { t.appendChild(el('span', NOMI_TIPI[x] || x, 'px-tag')); });
      box.appendChild(t);
    }
    if (r.sintesi) { box.appendChild(el('h3', 'Sintesi')); box.appendChild(el('p', r.sintesi)); }

    if (r.segnalazioni && r.segnalazioni.length) {
      box.appendChild(el('h3', 'Segnalazioni → Issue'));
      r.segnalazioni.forEach(function (s) {
        var k = el('div', null, 'px-card');
        var esito = s.esito === 'creata' ? ['Issue creata', 'px-verde']
          : s.esito === 'aggiornata' ? ['Issue esistente aggiornata', 'px-verde']
          : s.esito === 'gia_presente' ? ['Già presente', 'px-arancio']
            : s.esito === 'interna' ? ['Email interna: Issue non creata', 'px-arancio'] : ['Non creata', 'px-rosso'];
        var riga = el('div');
        riga.appendChild(el('span', esito[0], 'px-tag ' + esito[1]));
        riga.appendChild(el('span', s.priorita + ' · ' + s.categoria, 'px-tag'));
        k.appendChild(riga);
        k.appendChild(el('div', s.descrizione));
        if (s.esito === 'aggiornata') {
          if (s.issueDescrizione) k.appendChild(el('div', 'Issue esistente [' + (s.issueStato || '') + ']: ' + s.issueDescrizione, 'px-muted'));
          k.appendChild(el('div', 'Aggiornato: ' + (s.campi || []).join(', ') + (s.integrazione ? ' — aggiunto: ' + s.integrazione : ''), 'px-muted'));
        }
        if (s.esito === 'gia_presente' && s.issueDescrizione) k.appendChild(el('div', 'Issue esistente [' + (s.issueStato || '') + ']: ' + s.issueDescrizione, 'px-muted'));
        if (s.errore) k.appendChild(el('div', s.errore, 'px-muted'));
        box.appendChild(k);
      });
    }

    if (r.riunioni || (r.riunioniCorrelate && r.riunioniCorrelate.length)) {
      box.appendChild(el('h3', 'Già discusso in riunione'));
      if (r.riunioni) box.appendChild(el('p', r.riunioni));
      // Una scheda per riunione (o voce di registro), con i tipi trovati e fino a 2 estratti.
      (r.riunioniCorrelate || []).forEach(function (x) {
        var k = el('div', null, 'px-card');
        var riga = el('div');
        (x.tipi || [x.tipo]).forEach(function (t) { if (t) riga.appendChild(el('span', t, 'px-tag')); });
        if (x.data || x.oggetto) riga.appendChild(el('span', [x.data, x.oggetto].filter(Boolean).join(' · '), 'px-muted'));
        k.appendChild(riga);
        (x.estratti || [x.estratto]).forEach(function (e, i) {
          if (!e) return;
          var p = el('div', e);
          if (i) p.style.marginTop = '6px';
          k.appendChild(p);
        });
        box.appendChild(k);
      });
    }

    if (r.ticket && r.ticket.length) {
      box.appendChild(el('h3', 'Ticket collegati'));
      r.ticket.forEach(function (x) {
        var k = el('div', null, 'px-card');
        var testa = el('div');
        testa.appendChild(el('span', x.origine === 'citato' ? 'citato nell\'email' : 'stesso argomento', 'px-tag' + (x.origine === 'citato' ? '' : ' px-arancio')));
        testa.appendChild(el('span', x.codice + ' · ' + x.sistema, 'px-oggetto'));
        k.appendChild(testa);
        if (x.nonTrovato) k.appendChild(el('div', 'Non presente tra i ticket di questo cliente in Projexa', 'px-muted'));
        else {
          k.appendChild(el('div', 'Stato: ' + (x.stato || '-') + ' · In carico: ' + (x.inCarico || '-')));
          if (x.versione || x.release) {
            k.appendChild(el('div', 'Versione: ' + (x.versione || '-') + (x.release ? ' → release ' + x.release + ' del ' + x.releaseData : ' (data di rilascio non trovata nelle release)'), x.release ? '' : 'px-muted'));
          }
          k.appendChild(el('div', 'Aperto ' + (x.apertura || '-') + (x.chiusura ? ' · Chiuso ' + x.chiusura : '') + (x.descrizione ? ' · ' + x.descrizione : ''), 'px-muted'));
        }
        if (x.risposta) k.appendChild(el('div', x.risposta));
        box.appendChild(k);
      });
    }

    // Release solo se ricavata da un ticket collegato (niente calendario generico).
    if (r.release) {
      box.appendChild(el('h3', 'Release'));
      box.appendChild(el('p', r.release));
    }

    if (r.puntiAttenzione && r.puntiAttenzione.length) {
      box.appendChild(el('h3', 'Da verificare'));
      var ul2 = el('ul', null, 'px-lista');
      r.puntiAttenzione.forEach(function (x) { ul2.appendChild(el('li', x)); });
      box.appendChild(ul2);
    }

    // Azioni proposte: si registrano in Projexa solo con «Crea» (rischi e dipendenze nel RAID
    // del progetto scelto sopra).
    if (r.azioni && r.azioni.length) {
      box.appendChild(el('h3', 'Azioni proposte'));
      r.azioni.forEach(function (a) { box.appendChild(schedaAzione(a, selProgetto)); });
    }

    if (r.rispostaEmail) {
      box.appendChild(el('h3', 'Bozza di risposta'));
      box.appendChild(el('div', r.rispostaEmail, 'px-risposta'));
      var az = el('div', null, 'px-azioni');
      var rispondi = el('button', 'Rispondi a tutti', 'px-btn');
      rispondi.type = 'button';
      rispondi.addEventListener('click', function () { rispondiATutti(r.rispostaEmail); });
      var copia = el('button', 'Copia', 'px-btn px-sec');
      copia.type = 'button';
      copia.addEventListener('click', function () {
        if (navigator.clipboard) navigator.clipboard.writeText(r.rispostaEmail).then(function () { avviso('Bozza copiata.', true); }, function () { avviso('Copia non riuscita: seleziona il testo a mano.'); });
      });
      az.appendChild(rispondi); az.appendChild(copia);
      box.appendChild(az);
    }
    if (r.ai && r.ai.label) box.appendChild(el('p', 'Analisi di ' + r.ai.label + (r.ai.model ? ' (' + r.ai.model + ')' : '') + '. Controlla sempre la bozza prima di inviarla.', 'px-nota'));
  }

  var NOMI_AZIONI = { rischio: 'Rischio (RAID)', dipendenza: 'Dipendenza (RAID)', todo: 'To-Do', azione_cliente: 'Azione del cliente' };
  var NOMI_REGISTRI = { pm_raid: 'RAID', tasks: 'To-Do', pm_azioni_cliente: 'Azioni del cliente' };
  function dataBreve(iso) { var p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : ''; }

  function schedaAzione(a, selProgetto) {
    var k = el('div', null, 'px-card');
    var testa = el('div');
    testa.appendChild(el('span', NOMI_AZIONI[a.tipo] || a.tipo, 'px-tag'));
    testa.appendChild(el('span', a.titolo, 'px-oggetto'));
    k.appendChild(testa);
    if (a.descrizione) k.appendChild(el('div', a.descrizione));
    if (a.mitigazione) k.appendChild(el('div', 'Mitigazione: ' + a.mitigazione, 'px-muted'));
    var meta = [];
    if (a.scadenza) meta.push((a.tipo === 'rischio' || a.tipo === 'dipendenza' ? 'Revisione ' : 'Scadenza ') + dataBreve(a.scadenza));
    if (a.owner) meta.push((a.tipo === 'azione_cliente' ? 'Referente: ' : 'Owner: ') + a.owner);
    if (meta.length) k.appendChild(el('div', meta.join(' · '), 'px-muted'));
    var esito = el('div');
    var fatto = function (c) {
      esito.textContent = '';
      esito.appendChild(el('span', c.giaPresente ? 'Già presente' : 'Creata', 'px-tag ' + (c.giaPresente ? 'px-arancio' : 'px-verde')));
      esito.appendChild(el('span', 'in ' + (NOMI_REGISTRI[c.tabella] || c.tabella) + (c.progetto ? ' · ' + c.progetto : ''), 'px-muted'));
    };
    k.appendChild(esito);
    if (a.creata) { fatto(a.creata); return k; }
    var b = el('button', 'Crea in Projexa', 'px-btn px-sec');
    b.type = 'button';
    b.addEventListener('click', function () {
      b.disabled = true;
      avviso('');
      var lavoro = stato.lavoro;
      chiama('POST', '/lavori/' + encodeURIComponent(lavoro) + '/azioni/' + a.n, { projectId: selProgetto ? selProgetto.value : '' })
        .then(function (r) {
          a.creata = r.dati;
          fatto(r.dati);
          b.remove();
        })
        .catch(function (e) { b.disabled = false; avviso(e.message); });
    });
    k.appendChild(b);
    return k;
  }

  // ---------------------------------------------------------------------------
  // Appuntamento del calendario (2026-10-22): organizzatore e partecipanti verso Projexa
  // ---------------------------------------------------------------------------
  // In lettura (sei invitato) i campi sono valori; da organizzatore (modifica) sono oggetti da
  // leggere con getAsync. valore() restituisce sempre una Promise col valore.
  function valore(campo) {
    if (campo && typeof campo.getAsync === 'function') {
      return new Promise(function (ok) {
        campo.getAsync(function (r) { ok(r.status === Office.AsyncResultStatus.Succeeded ? r.value : null); });
      });
    }
    return Promise.resolve(campo == null ? null : campo);
  }
  function persona(x) { return x ? { nome: x.displayName || '', email: x.emailAddress || '' } : null; }
  var datiRiunione = null;

  function caricaRiunione(item) {
    datiRiunione = null;
    mostra('vistaRiunione', true); mostra('pxFoot', true);
    $('pxRiuRisultato').hidden = true;
    $('pxRiuRisultato').textContent = '';
    $('pxCollegaRiu').disabled = true;
    $('pxCollegaRiu').textContent = 'Collega a Projexa';
    Promise.all([valore(item.subject), valore(item.start), valore(item.end), valore(item.organizer),
      valore(item.requiredAttendees), valore(item.optionalAttendees), valore(item.location)]).then(function (v) {
      var org = persona(v[3]) || { nome: '', email: stato.mailbox }; // da organizzatore: sei tu
      datiRiunione = {
        oggetto: v[0] || '', inizio: v[1] ? new Date(v[1]).toISOString() : '', fine: v[2] ? new Date(v[2]).toISOString() : '',
        organizzatore: org, obbligatori: (v[4] || []).map(persona).filter(function (p) { return p && p.email; }),
        facoltativi: (v[5] || []).map(persona).filter(function (p) { return p && p.email; }), luogo: v[6] || ''
      };
      $('pxRiuOggetto').textContent = datiRiunione.oggetto || '(senza oggetto)';
      var inizio = v[1] ? new Date(v[1]) : null;
      $('pxRiuQuando').textContent = inizio ? inizio.toLocaleString('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      var n = datiRiunione.obbligatori.length + datiRiunione.facoltativi.length;
      $('pxRiuChi').textContent = 'Organizzatore: ' + (org.nome || org.email || '-') + ' · ' + n + ' partecipant' + (n === 1 ? 'e' : 'i');
      $('pxCollegaRiu').disabled = !datiRiunione.inizio;
    });
  }

  function collegaRiunione(projectId) {
    if (!datiRiunione) return;
    var b = $('pxCollegaRiu');
    b.disabled = true;
    avviso('');
    var corpo = {};
    for (var k in datiRiunione) corpo[k] = datiRiunione[k];
    corpo.projectId = projectId || '';
    var testoPrima = b.textContent;
    b.textContent = 'Aggiornamento…';
    chiama('POST', '/appuntamento', corpo).then(function (r) {
      mostraRiunione(r.dati);
      b.textContent = 'Aggiorna in Projexa';
      // Riscontro sempre visibile: il pannello si ridisegna uguale quando non cambia nulla.
      var ora = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      var riu = r.dati.riunioni || [];
      var cambiati = riu.filter(function (x) { return x.campi && x.campi.length; });
      avviso(!riu.length
        ? 'Salvato alle ' + ora + ': Projexa userà questi dati quando registri o carichi la riunione.'
        : cambiati.length
          ? 'Aggiornato alle ' + ora + ': completati ' + cambiati.map(function (x) { return x.campi.join(', '); }).join('; ') + '.'
          : 'Controllato alle ' + ora + ': in Projexa la riunione ha già cliente, progetto e destinatari, niente da cambiare (le scelte fatte a mano non si toccano).', true);
    }).catch(function (e) { b.textContent = testoPrima; avviso(e.message); }).then(function () { b.disabled = false; });
  }

  function mostraRiunione(d) {
    var box = $('pxRiuRisultato');
    box.textContent = '';
    box.hidden = false;
    box.appendChild(el('h3', 'Cliente e progetto'));
    var card = el('div', null, 'px-card');
    if (d.cliente) {
      card.appendChild(el('div', d.cliente.nome || '-', 'px-oggetto'));
      card.appendChild(el('div', 'Riconosciuto da: ' + (d.cliente.come === 'dominio' ? 'dominio di ' : '') + (d.cliente.indirizzo || ''), 'px-muted'));
      if (d.progetti && d.progetti.length > 1) {
        var sel = el('select');
        d.progetti.forEach(function (p) {
          var o = el('option', p.nome); o.value = p.id;
          if (d.progetto && d.progetto.id === p.id) o.selected = true;
          sel.appendChild(o);
        });
        card.appendChild(el('label', 'Progetto'));
        card.appendChild(sel);
        var rb = el('button', 'Usa questo progetto', 'px-btn px-sec');
        rb.type = 'button';
        rb.addEventListener('click', function () { collegaRiunione(sel.value); });
        card.appendChild(rb);
      } else {
        card.appendChild(el('div', 'Progetto: ' + (d.progetto ? d.progetto.nome : 'nessun progetto aperto'), 'px-muted'));
      }
    } else {
      card.appendChild(el('div', 'Nessun partecipante corrisponde ai contatti dei tuoi clienti: cliente e progetto li sceglierai in Projexa.', 'px-muted'));
    }
    box.appendChild(card);

    box.appendChild(el('h3', 'In Projexa'));
    if (d.riunioni && d.riunioni.length) {
      d.riunioni.forEach(function (x) {
        box.appendChild(el('p', '«' + (x.oggetto || d.oggetto) + '»: ' + (x.campi.length ? 'completati ' + x.campi.join(', ') + '.' : 'era già completa (le scelte fatte a mano non si toccano).')));
      });
    } else {
      box.appendChild(el('p', 'Salvato. Quando registri o carichi questa riunione, Projexa userà questi dati per cliente, progetto, destinatari del recap e nomi nella trascrizione. Nell\'elenco delle riunioni i partecipanti compaiono al prossimo aggiornamento.'));
    }

    var tutti = [];
    if (d.organizzatore) tutti.push(d.organizzatore);
    (d.partecipanti || []).forEach(function (p) { tutti.push(p); });
    if (tutti.length) {
      box.appendChild(el('h3', 'Partecipanti (' + tutti.length + ')'));
      var ul = el('ul', null, 'px-lista');
      tutti.forEach(function (p) {
        // Nome uguale all'indirizzo (succede all'organizzatore): una volta sola.
        var nome = p.nome && p.nome.toLowerCase() !== String(p.email).toLowerCase() ? p.nome + ' · ' : '';
        ul.appendChild(el('li', nome + p.email + (p.tipo === 'organizzatore' ? ' (organizzatore)' : p.tipo === 'facoltativo' ? ' (facoltativo)' : '')));
      });
      box.appendChild(ul);
    }
  }

  // Risposta a tutti: Outlook apre la bozza con mittente, destinatari e Cc, oggetto «RE: …».
  function rispondiATutti(testo) {
    var esc = String(testo).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    var html = '<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">' + esc.replace(/\r?\n/g, '<br>') + '</div>';
    try {
      Office.context.mailbox.item.displayReplyAllForm(html);
    } catch (e) {
      avviso('Outlook non ha aperto la risposta: usa «Copia» e incolla il testo.');
    }
  }

  // ---------------------------------------------------------------------------
  // Avvio
  // ---------------------------------------------------------------------------
  Office.onReady(function (info) {
    if (info.host !== Office.HostType.Outlook) {
      mostra('vistaFuori', true);
      return;
    }
    stato.mailbox = String((Office.context.mailbox.userProfile || {}).emailAddress || '').toLowerCase();
    stato.token = Office.context.roamingSettings.get(CHIAVE_TOKEN) || '';
    $('pxCollega').addEventListener('click', collega);
    $('pxCodice').addEventListener('keydown', function (e) { if (e.key === 'Enter') collega(); });
    $('pxAnalizza').addEventListener('click', function () { analizza(''); });
    $('pxScollega').addEventListener('click', scollega);
    $('pxCollegaRiu').addEventListener('click', function () { collegaRiunione(''); });
    // Pannello fissato: cambiando email si riparte da quella nuova.
    try {
      Office.context.mailbox.addHandlerAsync(Office.EventType.ItemChanged, function () {
        $('pxAnalizza').textContent = 'Analizza con Projexa';
        avviso('');
        if (stato.token) caricaEmailCorrente();
      });
    } catch (e) { /* client senza l'evento */ }
    if (!stato.token) { vistaCollega(); return; }
    caricaUtente().catch(function (e) { if (stato.token) { vistaAnalisi(); avviso(e.message); } });
  });
})();
