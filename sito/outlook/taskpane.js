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
    mostra('vistaAnalisi', false); mostra('vistaFuori', false); mostra('pxFoot', false);
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

  function analizza(projectId) {
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
        emailId: stato.emailId, projectId: projectId || ''
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
      return;
    }
    var c = r.cliente || {};
    box.appendChild(el('h3', 'Cliente e progetto'));
    var card = el('div', null, 'px-card');
    card.appendChild(el('div', c.nome || '-', 'px-oggetto'));
    card.appendChild(el('div', 'Riconosciuto da: ' + (c.come === 'dominio' ? 'dominio di ' : (c.come === 'destinatario' ? 'destinatario ' : 'mittente ')) + (c.indirizzo || '') + (c.contatto ? ' (' + c.contatto + ')' : ''), 'px-muted'));
    if (r.progetti && r.progetti.length > 1) {
      var sel = el('select');
      r.progetti.forEach(function (p) {
        var o = el('option', p.nome); o.value = p.id;
        if (r.progetto && r.progetto.id === p.id) o.selected = true;
        sel.appendChild(o);
      });
      var lab = el('label', 'Progetto (cambia e rianalizza se non è quello giusto)');
      card.appendChild(lab); card.appendChild(sel);
      var rb = el('button', 'Rianalizza con questo progetto', 'px-btn px-sec');
      rb.type = 'button';
      rb.addEventListener('click', function () { analizza(sel.value); });
      card.appendChild(rb);
    } else {
      card.appendChild(el('div', 'Progetto: ' + (r.progetto ? r.progetto.nome : 'nessun progetto aperto'), 'px-muted'));
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
        var esito = s.esito === 'creata' ? ['Issue creata', 'px-verde'] : (s.esito === 'gia_presente' ? ['Già presente', 'px-arancio'] : ['Non creata', 'px-rosso']);
        var riga = el('div');
        riga.appendChild(el('span', esito[0], 'px-tag ' + esito[1]));
        riga.appendChild(el('span', s.priorita + ' · ' + s.categoria, 'px-tag'));
        k.appendChild(riga);
        k.appendChild(el('div', s.descrizione));
        if (s.esito === 'gia_presente' && s.issueDescrizione) k.appendChild(el('div', 'Issue esistente [' + (s.issueStato || '') + ']: ' + s.issueDescrizione, 'px-muted'));
        if (s.errore) k.appendChild(el('div', s.errore, 'px-muted'));
        box.appendChild(k);
      });
    }

    if (r.ticket && r.ticket.length) {
      box.appendChild(el('h3', 'Ticket citati'));
      r.ticket.forEach(function (x) {
        var k = el('div', null, 'px-card');
        k.appendChild(el('div', x.codice + ' · ' + x.sistema, 'px-oggetto'));
        if (x.nonTrovato) k.appendChild(el('div', 'Non presente tra i ticket di questo cliente in Projexa', 'px-muted'));
        else {
          k.appendChild(el('div', 'Stato: ' + (x.stato || '-') + ' · In carico: ' + (x.inCarico || '-')));
          k.appendChild(el('div', 'Release/versione: ' + (x.release || 'non indicata') + ' · Aperto ' + (x.apertura || '-') + (x.chiusura ? ' · Chiuso ' + x.chiusura : ''), 'px-muted'));
        }
        if (x.risposta) k.appendChild(el('div', x.risposta));
        box.appendChild(k);
      });
    }

    if (r.release || (r.releasePianificate && r.releasePianificate.length)) {
      box.appendChild(el('h3', 'Release'));
      if (r.release) box.appendChild(el('p', r.release));
      if (r.releasePianificate && r.releasePianificate.length) {
        var ul = el('ul', null, 'px-lista');
        r.releasePianificate.forEach(function (x) { ul.appendChild(el('li', x.release + ': ' + x.data)); });
        box.appendChild(ul);
      }
    }

    if (r.puntiAttenzione && r.puntiAttenzione.length) {
      box.appendChild(el('h3', 'Da verificare'));
      var ul2 = el('ul', null, 'px-lista');
      r.puntiAttenzione.forEach(function (x) { ul2.appendChild(el('li', x)); });
      box.appendChild(ul2);
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
