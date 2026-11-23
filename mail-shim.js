/* Parcel Finder — standalone mail connection (multiple accounts).
   Gmail via Google sign-in + Gmail API; Outlook/Hotmail via Microsoft sign-in + Microsoft Graph.
   Exposes the same callTool('Gmail', tool, input) interface the app already uses, so every
   feature (deliveries, receipts, subscriptions, unsubscribe) works across all accounts.
   Item ids are prefixed "<accountId>~<id>" so each action goes to the right mailbox. */
(function(){
  const CFG = window.PF_CONFIG || {};
  const G_ID = CFG.clientId || '';
  const MS_ID = CFG.microsoftClientId || '';
  const G_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
  const MS_SCOPES = ['Mail.ReadWrite', 'Mail.Send', 'User.Read'];
  const SITE = location.origin + location.pathname.replace(/[^/]*$/, '');

  // ---------- account store ----------
  // {id, provider:'gmail'|'outlook', email, token, exp, homeAccountId}
  let accounts = load();
  function load(){
    try{
      const a = JSON.parse(localStorage.getItem('pfAccounts')||'null');
      if (a) return a;
      const old = JSON.parse(localStorage.getItem('pfGToken')||'null');   // migrate single-account 1.2
      if (old && old.email) return [{id:'g1', provider:'gmail', email:old.email, token:old.access_token, exp:old.exp}];
    }catch(e){}
    return [];
  }
  function save(){ try{ localStorage.setItem('pfAccounts', JSON.stringify(accounts)); localStorage.removeItem('pfGToken'); }catch(e){} }
  const nextId = p => p[0] + (Math.max(0, ...accounts.filter(a=>a.provider===p).map(a=>+a.id.slice(1)||0)) + 1);
  const gValid = a => a.token && a.exp > Date.now() + 60e3;
  const byId = id => accounts.find(a=>a.id===id);

  // ---------- Google ----------
  let gisReady = null, gClient = null;
  function loadScript(src){ return new Promise((res, rej)=>{ const s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
  function loadGis(){ return gisReady || (gisReady = loadScript('https://accounts.google.com/gsi/client')); }
  if (G_ID) loadGis().catch(()=>{});

  // Must run inside a tap (Google opens a popup)
  function googleSignIn(acct){
    return new Promise((resolve, reject)=>{
      if (!G_ID) return reject({code:'not_configured'});
      if (!window.google || !google.accounts) return reject({code:'gis_not_loaded'});
      gClient = gClient || google.accounts.oauth2.initTokenClient({client_id:G_ID, scope:G_SCOPE, callback:()=>{}});
      gClient.callback = async (r)=>{
        if (r.error) return reject({code:'denied', message:r.error});
        const tok = {token:r.access_token, exp: Date.now() + (r.expires_in||3600)*1000};
        try{
          const p = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {headers:{Authorization:'Bearer '+tok.token}}).then(x=>x.json());
          const email = (p.emailAddress||'').toLowerCase();
          let a = acct || accounts.find(x=>x.provider==='gmail' && x.email===email);
          if (!a){ a = {id: nextId('gmail'), provider:'gmail', email}; accounts.push(a); }
          Object.assign(a, tok, {email: email || a.email}); save(); updateUi(); resolve(a);
        }catch(e){ reject({code:'tool_error'}); }
      };
      gClient.requestAccessToken(acct ? {prompt:'', login_hint:acct.email} : {prompt:'select_account consent'});
    });
  }

  // ---------- Microsoft ----------
  let msalApp = null, msalReady = null;
  function loadMsal(){
    if (msalReady) return msalReady;
    msalReady = loadScript('vendor/msal-browser.min.js').then(async ()=>{
      msalApp = new window.msal.PublicClientApplication({auth:{clientId:MS_ID, authority:'https://login.microsoftonline.com/common', redirectUri:SITE}, cache:{cacheLocation:'localStorage'}});
      await msalApp.initialize();
      try{ await msalApp.handleRedirectPromise(); }catch(e){}
    });
    return msalReady;
  }
  if (MS_ID) loadMsal().catch(()=>{});

  async function outlookSignIn(){
    if (!MS_ID) throw {code:'not_configured'};
    await loadMsal();
    const r = await msalApp.loginPopup({scopes:MS_SCOPES, prompt:'select_account'});
    const email = (r.account.username||'').toLowerCase();
    let a = accounts.find(x=>x.provider==='outlook' && x.email===email);
    if (!a){ a = {id: nextId('outlook'), provider:'outlook', email}; accounts.push(a); }
    a.homeAccountId = r.account.homeAccountId; a.token = r.accessToken; a.exp = r.expiresOn ? +new Date(r.expiresOn) : Date.now()+3600e3;
    save(); updateUi(); return a;
  }
  async function outlookToken(a, interactive){
    if (gValid(a)) return a.token;
    await loadMsal();
    const account = msalApp.getAccountByHomeId(a.homeAccountId);
    try{
      const r = await msalApp.acquireTokenSilent({scopes:MS_SCOPES, account});
      a.token = r.accessToken; a.exp = +new Date(r.expiresOn); save(); return a.token;
    }catch(e){
      if (!interactive) throw {code:'not_connected'};
      const r = await msalApp.acquireTokenPopup({scopes:MS_SCOPES, account});
      a.token = r.accessToken; a.exp = +new Date(r.expiresOn); save(); return a.token;
    }
  }

  // ---------- HTTP ----------
  async function call(a, url, opts={}){
    let token = a.provider==='gmail' ? (gValid(a) ? a.token : null) : await outlookToken(a).catch(()=>null);
    if (!token) throw {code:'not_connected', account:a.email};
    const r = await fetch(url, {...opts, headers:{Authorization:'Bearer '+token, 'Content-Type':'application/json', ...(opts.headers||{})}});
    if (r.status === 401){ a.exp = 0; save(); updateUi(); throw {code:'not_connected', account:a.email}; }
    if (r.status === 429) throw {code:'rate_limited', retryable:true};
    if (!r.ok) throw {code:'tool_error', message:'Mail error '+r.status};
    return (r.status === 204 || r.status === 202) ? {} : r.json();
  }

  // ---------- shared parsing ----------
  const b64 = s=>{ try{ const bin = atob(s.replace(/-/g,'+').replace(/_/g,'/')); return new TextDecoder().decode(Uint8Array.from(bin, c=>c.charCodeAt(0))); }catch(e){ return ''; } };
  function htmlToText(h){
    return (h||'').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ')
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m,u,t)=>`${t.replace(/<[^>]+>/g,'')} ( ${u} )`)
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi,'\n').replace(/<[^>]+>/g,' ')
      .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;|&rsquo;/g,"'").replace(/&quot;/g,'"')
      .replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n\n');
  }
  async function pool(items, n, fn){
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({length:Math.min(n, items.length)}, async ()=>{ while (i < items.length){ const k = i++; out[k] = await fn(items[k]).catch(()=>null); } }));
    return out;
  }

  // ---------- Gmail provider ----------
  const GAPI = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const gHdr = (m, n)=> ((m.payload && m.payload.headers)||[]).find(h=>h.name.toLowerCase()===n.toLowerCase())?.value || '';
  function gParts(p, out={text:'', html:''}){
    if (!p) return out;
    if (p.mimeType === 'text/plain' && p.body && p.body.data && !out.text) out.text = b64(p.body.data);
    else if (p.mimeType === 'text/html' && p.body && p.body.data && !out.html) out.html = b64(p.body.data);
    (p.parts||[]).forEach(c=>gParts(c, out)); return out;
  }
  function addr(from){ const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/); return m ? {email:m[2].trim().toLowerCase(), name:m[1].trim()} : {email:from.trim().toLowerCase(), name:''}; }
  function gMap(a, m, full, withHtml){
    const f = addr(gHdr(m,'From'));
    const o = {id:`${a.id}~${m.id}`, threadId:`${a.id}~${m.threadId}`, subject:gHdr(m,'Subject'), sender:f.email, snippet:m.snippet||'',
      date:new Date(+m.internalDate || Date.parse(gHdr(m,'Date')) || Date.now()).toISOString(), labelIds:m.labelIds||[],
      addressDisplayNames:[{emailAddress:f.email, displayName:f.name}], viewUrl:`https://mail.google.com/mail/u/${encodeURIComponent(a.email)}/#all/${m.threadId}`, account:a.email};
    if (full){ const p = gParts(m.payload); o.plaintextBody = p.text || htmlToText(p.html) || m.snippet || ''; if (withHtml) o.htmlBody = p.html; }
    return o;
  }
  const gmail = {
    async search(a, {query, pageSize, pageToken, view}){
      const qs = new URLSearchParams({q:query||'', maxResults:String(pageSize||20)}); if (pageToken) qs.set('pageToken', pageToken);
      const r = await call(a, `${GAPI}/threads?${qs}`);
      const ids = (r.threads||[]).map(t=>t.id);
      if (view === 'THREAD_VIEW_IDS_ONLY') return {threads:ids.map(id=>({id:`${a.id}~${id}`})), next:r.nextPageToken};
      const threads = await pool(ids, 8, async id=>{
        const t = await call(a, `${GAPI}/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        const msgs = (t.messages||[]).map(m=>gMap(a, m, false));
        return {id:`${a.id}~${id}`, messageCount:msgs.length, viewUrl:msgs[0]&&msgs[0].viewUrl, messages: view==='THREAD_VIEW_SUMMARY' ? msgs.slice(-1) : msgs.slice(0,5)};
      });
      return {threads:threads.filter(Boolean), next:r.nextPageToken};
    },
    async thread(a, id, fmt){
      const t = await call(a, `${GAPI}/threads/${id}?format=full`);
      const msgs = (t.messages||[]).map(m=>gMap(a, m, fmt!=='MINIMAL' && fmt!=='METADATA_ONLY', fmt==='FULL_CONTENT'));
      return {id:`${a.id}~${t.id}`, viewUrl:msgs[0]&&msgs[0].viewUrl, messageCount:msgs.length, messages:msgs};
    },
    trash: (a, id)=>call(a, `${GAPI}/threads/${id}/trash`, {method:'POST'}),
    untrash: (a, id)=>call(a, `${GAPI}/threads/${id}/untrash`, {method:'POST'}),
    async send(a, {to=[], subject='', body=''}){
      const mime = [`To: ${to.join(', ')}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=UTF-8', '', body].join('\r\n');
      const raw = btoa(unescape(encodeURIComponent(mime))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      return call(a, `${GAPI}/messages/send`, {method:'POST', body:JSON.stringify({raw})});
    }
  };

  // ---------- Outlook provider (Microsoft Graph) ----------
  const MAPI = 'https://graph.microsoft.com/v1.0/me';
  // Translate the Gmail-style queries the app uses into Outlook search (KQL)
  function toKql(q){
    let since = null;
    q = q.replace(/newer_than:(\d+)([dmy])/g, (m,n,u)=>{ const d = new Date(); d.setDate(d.getDate() - n*(u==='y'?365:u==='m'?30:1)); since = d.toISOString().slice(0,10); return ''; });
    q = q.replace(/from:\(([^)]*)\)/g, (m,list)=>'(' + list.split(/\s+OR\s+/).map(x=>'from:'+x.trim()).join(' OR ') + ')');
    q = q.replace(/-?(in|category|list|label|is|has):\S+/g, '');
    for (let i=0;i<4;i++) q = q.replace(/\(\s*(OR\s+)+/g,'(').replace(/(\s+OR)+\s*\)/g,')').replace(/\bOR\s+(OR\s+)+/g,'OR ').replace(/\(\s*\)/g,'');
    q = q.replace(/\s+/g,' ').trim();
    const parts = []; if (q) parts.push(q); if (since) parts.push(`received>=${since}`);
    return parts.join(' AND ');
  }
  function oMap(a, m, full, withHtml){
    const f = (m.from && m.from.emailAddress) || {};
    const html = m.body && m.body.contentType === 'html' ? m.body.content : '';
    const o = {id:`${a.id}~${m.id}`, threadId:`${a.id}~${m.id}`, subject:m.subject||'', sender:(f.address||'').toLowerCase(), snippet:m.bodyPreview||'',
      date:m.receivedDateTime, labelIds:[m.inferenceClassification==='other'?'CATEGORY_PROMOTIONS':'CATEGORY_UPDATES'],
      addressDisplayNames:[{emailAddress:(f.address||'').toLowerCase(), displayName:f.name||''}], viewUrl:m.webLink||'https://outlook.live.com/mail/', account:a.email};
    if (full){ o.plaintextBody = html ? htmlToText(html) : (m.body && m.body.content) || m.bodyPreview || ''; if (withHtml) o.htmlBody = html; }
    return o;
  }
  const SEL = 'id,subject,from,receivedDateTime,bodyPreview,webLink,inferenceClassification';
  const outlook = {
    async search(a, {query, pageSize, pageToken, view}){
      const url = pageToken || `${MAPI}/messages?$search=${encodeURIComponent('"'+toKql(query||'').replace(/"/g,'\\"')+'"')}&$top=${pageSize||20}&$select=${SEL}`;
      const r = await call(a, url);
      const msgs = (r.value||[]).map(m=>oMap(a, m, false));
      return {threads: msgs.map(m=>view==='THREAD_VIEW_IDS_ONLY' ? {id:m.threadId} : {id:m.threadId, messageCount:1, viewUrl:m.viewUrl, messages:[m]}), next:r['@odata.nextLink']};
    },
    async thread(a, id, fmt){
      const m = await call(a, `${MAPI}/messages/${id}?$select=${SEL},body`, fmt==='FULL_CONTENT' ? {} : {headers:{Prefer:'outlook.body-content-type="html"'}});
      const o = oMap(a, m, fmt!=='MINIMAL' && fmt!=='METADATA_ONLY', fmt==='FULL_CONTENT');
      return {id:o.threadId, viewUrl:o.viewUrl, messageCount:1, messages:[o]};
    },
    async trash(a, id){
      const r = await call(a, `${MAPI}/messages/${id}/move`, {method:'POST', body:JSON.stringify({destinationId:'deleteditems'})});
      moved[`${a.id}~${id}`] = r.id; saveMoved(); return {};
    },
    async untrash(a, id){
      const cur = moved[`${a.id}~${id}`] || id;
      await call(a, `${MAPI}/messages/${cur}/move`, {method:'POST', body:JSON.stringify({destinationId:'inbox'})});
      delete moved[`${a.id}~${id}`]; saveMoved(); return {};
    },
    send: (a, {to=[], subject='', body=''})=>call(a, `${MAPI}/sendMail`, {method:'POST', body:JSON.stringify({message:{subject, body:{contentType:'Text', content:body}, toRecipients:to.map(x=>({emailAddress:{address:x}}))}, saveToSentItems:true})})
  };
  let moved = (()=>{ try{ return JSON.parse(localStorage.getItem('pfMoved')||'{}'); }catch(e){ return {}; } })();
  function saveMoved(){ try{ localStorage.setItem('pfMoved', JSON.stringify(moved)); }catch(e){} }

  const P = {gmail, outlook};
  const ready = a => a.provider==='gmail' ? gValid(a) : !!a.homeAccountId;
  function split(pid){ const i = String(pid).indexOf('~'); const a = byId(pid.slice(0,i)); if (!a) throw {code:'tool_error', message:'Account removed'}; return [a, pid.slice(i+1)]; }

  // ---------- the app-facing tools ----------
  const tools = {
    // Searches each connected account in turn; the page token remembers where it is.
    async search_threads(input){
      let st = {i:0, t:null}; try{ if (input.pageToken) st = JSON.parse(input.pageToken); }catch(e){}
      const live = accounts.filter(ready);
      if (!live.length) throw {code:'not_connected'};
      while (st.i < live.length){
        const a = live[st.i];
        try{
          const r = await P[a.provider].search(a, {...input, pageToken: st.t});
          const nextTok = r.next ? JSON.stringify({i:st.i, t:r.next}) : (st.i+1 < live.length ? JSON.stringify({i:st.i+1, t:null}) : undefined);
          if (r.threads.length || !nextTok) return {threads:r.threads, nextPageToken:nextTok};
          st = JSON.parse(nextTok);
        }catch(e){ st = {i:st.i+1, t:null}; }   // skip an account that fails, keep going
      }
      return {threads:[]};
    },
    async get_thread({threadId, messageFormat}){ const [a, id] = split(threadId); return P[a.provider].thread(a, id, messageFormat); },
    async trash_thread({threadId}){ const [a, id] = split(threadId); return P[a.provider].trash(a, id); },
    async untrash_thread({threadId}){ const [a, id] = split(threadId); return P[a.provider].untrash(a, id); },
    async send_message(input){
      let a = null;
      if (input.replyThreadId || input._thread){ try{ a = split(input.replyThreadId || input._thread)[0]; }catch(e){} }
      a = a || accounts.find(ready);
      if (!a) throw {code:'not_connected'};
      return P[a.provider].send(a, input);
    }
  };
  const bridge = { async callTool(server, tool, input){ if (!tools[tool]) throw {code:'tool_error', message:'unknown tool '+tool}; return {payload: await tools[tool](input||{})}; } };

  window.claude = { use: async (name)=> name === 'mcp' ? bridge : null };
  window.PF = {
    configured: !!(G_ID || MS_ID),
    isSignedIn: ()=> accounts.some(ready),
    account: ()=> accounts.filter(ready).map(a=>a.email).join(', '),
    accounts: ()=> accounts.slice(),
    needsReconnect: ()=> accounts.filter(a=>a.provider==='gmail' && !gValid(a)),
    addGmail: ()=>googleSignIn(null), addOutlook: outlookSignIn,
    reconnect: (a)=> a.provider==='gmail' ? googleSignIn(a) : outlookToken(a, true),
    remove(a){
      if (a.provider==='gmail' && a.token && window.google) try{ google.accounts.oauth2.revoke(a.token, ()=>{}); }catch(e){}
      if (a.provider==='outlook' && msalApp){ try{ const acc = msalApp.getAccountByHomeId(a.homeAccountId); acc && msalApp.clearCache({account:acc}); }catch(e){} }
      accounts = accounts.filter(x=>x!==a); save(); updateUi();
    },
    signIn: ()=>googleSignIn(null)
  };

  // ---------- Settings UI: account list ----------
  const ICON = {gmail:['G','#ea4335','Gmail'], outlook:['O','#0078d4','Outlook']};
  function updateUi(){
    const box = document.getElementById('gHint'), st = document.getElementById('gStatus');
    if (st){
      const live = accounts.filter(ready).length;
      st.textContent = !accounts.length ? 'No accounts yet' : `${live} of ${accounts.length} account${accounts.length>1?'s':''} connected`;
    }
    const title = st && st.parentElement && st.parentElement.querySelector('.t'); if (title) title.textContent = 'Email accounts';
    const av = st && st.parentElement && st.parentElement.previousElementSibling; if (av && av.classList.contains('avatar')){ av.textContent = '@'; av.style.background = 'var(--brand)'; }
    if (!box) return;
    box.hidden = false; box.style.display = 'block';
    const esc = s=>String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    box.innerHTML = accounts.map((a,i)=>{
      const [l,c,n] = ICON[a.provider]; const ok = ready(a);
      return `<div style="display:flex;align-items:center;gap:12px;padding:6px 0">
        <div class="avatar" style="background:${c};width:34px;height:34px;border-radius:10px;font-size:13px">${l}</div>
        <div style="flex:1;min-width:0"><div style="font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis">${esc(a.email)}</div>
          <div style="font-size:12px;color:${ok?'var(--ok)':'var(--warn)'}">${n} · ${ok?'Connected':'Tap Reconnect'}</div></div>
        ${ok?'':`<button class="btn" data-acct="re" data-i="${i}">Reconnect</button>`}
        <button class="btn danger" data-acct="rm" data-i="${i}" aria-label="Remove">✕</button></div>`;
    }).join('') +
    `<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      ${G_ID?'<button class="btn primary" data-acct="addG" style="flex:1;justify-content:center">+ Gmail</button>':''}
      ${MS_ID?'<button class="btn primary" data-acct="addO" style="flex:1;justify-content:center">+ Outlook</button>':'<button class="btn" disabled style="flex:1;justify-content:center" title="Outlook sign-in not set up yet">+ Outlook (soon)</button>'}
    </div>`;
    box.querySelectorAll('[data-acct]').forEach(b=>b.onclick = ()=>{
      const a = accounts[+b.dataset.i], t = window.toast || (()=>{});
      const fail = e=>t(e && e.code==='denied' ? 'Sign-in cancelled' : 'Couldn’t sign in');
      if (b.dataset.acct==='addG') googleSignIn(null).then(x=>t(`Added ${x.email}`), fail);
      if (b.dataset.acct==='addO') outlookSignIn().then(x=>t(`Added ${x.email}`), fail);
      if (b.dataset.acct==='re') PF.reconnect(a).then(()=>{ updateUi(); t('Reconnected'); }, fail);
      if (b.dataset.acct==='rm'){
        if (b.dataset.armed){ PF.remove(a); t('Account removed'); }
        else { b.dataset.armed = 1; b.textContent = 'Remove?'; setTimeout(()=>{ delete b.dataset.armed; b.textContent='✕'; }, 2500); }
      }
    });
  }

  // Gmail actions while nothing is connected: sign in first (inside the same tap), then continue.
  const GATED = '#refresh,#gScan,#subScan,#rcScan,#ctaScan,[data-a=unsub],[data-a=restore]';
  document.addEventListener('click', (e)=>{
    const el = e.target.closest(GATED);
    if (!el) return;
    const t = window.toast || (()=>{});
    if (!accounts.length){
      e.preventDefault(); e.stopImmediatePropagation();
      if (!G_ID && !MS_ID) return t('Sign-in isn’t set up yet');
      if (G_ID) googleSignIn(null).then(()=>el.click(), ()=>t('Sign-in cancelled'));
      else { typeof go==='function' && go('acct'); t('Add an email account first'); }
      return;
    }
    // One expired Gmail account can be refreshed per tap (Google needs a tap for each popup)
    const stale = accounts.find(a=>a.provider==='gmail' && !gValid(a));
    if (stale && !el.dataset.pfRetried){
      e.preventDefault(); e.stopImmediatePropagation();
      googleSignIn(stale).then(()=>{ el.dataset.pfRetried = 1; el.click(); delete el.dataset.pfRetried; },
                               ()=>{ el.dataset.pfRetried = 1; el.click(); delete el.dataset.pfRetried; });
    }
  }, true);
  document.addEventListener('DOMContentLoaded', updateUi);
  window.addEventListener('load', updateUi);
})();
