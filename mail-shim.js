/* Parcel Finder — standalone mail connection (multiple Gmail accounts).
   Gmail via Google sign-in + Gmail API.
   Exposes the same callTool('Gmail', tool, input) interface the app already uses, so every
   feature (deliveries, receipts, subscriptions, unsubscribe) works across all accounts.
   Item ids are prefixed "<accountId>~<id>" so each action goes to the right mailbox. */
(function(){
  const CFG = window.PF_CONFIG || {};
  const G_ID = CFG.clientId || '';
  const G_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
  const SITE = location.origin + location.pathname.replace(/[^/]*$/, '');

  // ---------- account store ----------
  // {id, provider:'gmail', email, token, exp}
  let accounts = load().filter(a=>a.provider==='gmail');
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

  // ---------- automatic Gmail reconnect ----------
  // Google's 1-hour access tokens can't be refreshed in the background without a server, so when the
  // app opens (or comes back to the screen) with an expired Gmail account, it does a quick full-page
  // hop to Google with prompt=none. If you're still signed in to Google on this phone, Google sends a
  // fresh token straight back with no screens to tap. One hop per expired account.
  const REDIRECT = SITE;
  const TRIED = 'pfSilentTried';
  function tried(){ try{ return JSON.parse(sessionStorage.getItem(TRIED)||'{}'); }catch(e){ return {}; } }
  function markTried(id, ok){ const t = tried(); t[id] = {at:Date.now(), ok}; try{ sessionStorage.setItem(TRIED, JSON.stringify(t)); }catch(e){} }
  // 1) Coming back from Google? Pick the token out of the address and tidy the address bar.
  (function catchRedirect(){
    const h = new URLSearchParams(location.hash.slice(1));
    const st = h.get('state') || '';
    if (!st.startsWith('pfsilent.')) return;
    const [, id, nonce] = st.split('.');
    const expect = sessionStorage.getItem('pfSilentNonce');
    sessionStorage.removeItem('pfSilentNonce');
    history.replaceState(null, '', location.pathname + location.search);
    const a = byId(id);
    if (!a || nonce !== expect) return;
    if (h.get('access_token')){
      a.token = h.get('access_token'); a.exp = Date.now() + (+h.get('expires_in')||3600)*1000; save(); markTried(id, true);
    } else markTried(id, false);   // Google needs a tap (signed out of Google, etc.) — show Reconnect instead
  })();
  // 2) Any Gmail account still expired that we haven't just tried? Hop to Google for it.
  function silentRefresh(){
    if (!G_ID || document.visibilityState === 'hidden') return false;
    if (document.body && (document.body.classList.contains('syncing') || document.body.classList.contains('sheet-open'))) return false;   // never interrupt a scan or an open sheet
    const t = tried(), now = Date.now();
    const a = accounts.find(x=>x.provider==='gmail' && x.email && !(x.token && x.exp > now + 5*60e3) && !(t[x.id] && now - t[x.id].at < 10*60e3));
    if (!a) return false;
    const nonce = Math.random().toString(36).slice(2);
    sessionStorage.setItem('pfSilentNonce', nonce); markTried(a.id, null);
    const q = new URLSearchParams({client_id:G_ID, redirect_uri:REDIRECT, response_type:'token', scope:G_SCOPE,
      include_granted_scopes:'true', prompt:'none', login_hint:a.email, state:`pfsilent.${a.id}.${nonce}`});
    document.documentElement.classList.add('pf-reconnecting');
    location.replace('https://accounts.google.com/o/oauth2/v2/auth?' + q);
    return true;
  }
  const hopping = silentRefresh();   // on open
  // Back to the app after a while (Google tokens last an hour): reconnect again if needed
  document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState === 'visible') silentRefresh(); });
  // Small "Reconnecting…" cover while hopping, so the app doesn't flash
  const rc = document.createElement('style');
  rc.textContent = `html.pf-reconnecting body>*{visibility:hidden}
    html.pf-reconnecting body::after{content:"Reconnecting your email…";position:fixed;inset:0;display:grid;place-items:center;font:600 15px Inter,system-ui,sans-serif;color:#8d93a5;background:var(--bg,#0b0d12)}`;
  document.head.appendChild(rc);

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

  // ---------- HTTP ----------
  async function call(a, url, opts={}){
    const token = gValid(a) ? a.token : null;
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

  const P = {gmail};
  const ready = a => gValid(a);
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
    reconnecting: ()=>hopping,
    configured: !!G_ID,
    isSignedIn: ()=> accounts.some(ready),
    account: ()=> accounts.filter(ready).map(a=>a.email).join(', '),
    accounts: ()=> accounts.slice(),
    needsReconnect: ()=> accounts.filter(a=>a.provider==='gmail' && !gValid(a)),
    addGmail: ()=>googleSignIn(null),
    reconnect: (a)=> googleSignIn(a),
    remove(a){
      if (a.provider==='gmail' && a.token && window.google) try{ google.accounts.oauth2.revoke(a.token, ()=>{}); }catch(e){}
      accounts = accounts.filter(x=>x!==a); save(); updateUi();
    },
    signIn: ()=>googleSignIn(null)
  };

  // ---------- Settings UI: account list ----------
  const ICON = {gmail:['G','#ea4335','Gmail']};
  function updateUi(){
    const box = document.getElementById('gHint');
    if (!box) return;
    box.hidden = false; box.style.cssText = 'display:block;padding:4px 14px 12px';
    const esc = s=>String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const rows = accounts.map((a,i)=>{
      const [l,c,n] = ICON[a.provider]; const ok = ready(a);
      return `<div class="acct">
        <div class="avatar" style="background:${c}">${l}</div>
        <div class="acct-t"><div class="acct-e">${esc(a.email)}</div>
          <div class="acct-s"><span class="dot" style="background:${ok?'var(--ok)':'var(--warn)'}"></span>${n} · ${ok?'Connected':'Signed out'}</div></div>
        ${ok?'':`<button class="btn sm" data-acct="re" data-i="${i}">Reconnect</button>`}
        <button class="btn sm icon danger" data-acct="rm" data-i="${i}" aria-label="Remove ${esc(a.email)}">✕</button></div>`;
    }).join('');
    box.innerHTML = (rows || '<div class="acct-empty">No email accounts yet — add one to start scanning.</div>') +
      `<div class="acct-add">
        ${G_ID?'<button class="btn" data-acct="addG"><span class="avatar mini" style="background:#ea4335">G</span>Add Gmail</button>':''}
      </div>`;
    box.querySelectorAll('[data-acct]').forEach(b=>b.onclick = ()=>{
      const a = accounts[+b.dataset.i], t = window.toast || (()=>{});
      const fail = e=>t(e && e.code==='denied' ? 'Sign-in cancelled' : 'Couldn’t sign in');
      if (b.dataset.acct==='addG') googleSignIn(null).then(x=>t(`Added ${x.email}`), fail);
      if (b.dataset.acct==='re') PF.reconnect(a).then(()=>{ updateUi(); t('Reconnected'); }, fail);
      if (b.dataset.acct==='rm'){
        if (b.dataset.armed){ PF.remove(a); t('Account removed'); }
        else { b.dataset.armed = 1; b.textContent = 'Remove?'; b.classList.remove('icon'); setTimeout(()=>{ if (b.isConnected){ delete b.dataset.armed; b.textContent='✕'; b.classList.add('icon'); } }, 2500); }
      }
    });
  }
  // styles for the account list (kept with the code that draws it)
  const css = document.createElement('style');
  css.textContent = `.acct{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
    .acct .avatar{width:36px;height:36px;border-radius:11px;font-size:14px;flex:none}
    .acct-t{flex:1;min-width:0}.acct-e{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .acct-s{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mute);margin-top:2px}
    .acct-s .dot{width:7px;height:7px;border-radius:50%}
    .btn.icon{width:32px;height:32px;padding:0;justify-content:center}
    .acct-empty{font-size:13.5px;color:var(--mute);padding:10px 0}
    .acct-add{display:flex;gap:8px;margin-top:12px}.acct-add .btn{flex:1;justify-content:center}
    .avatar.mini{width:20px;height:20px;border-radius:6px;font-size:11px;color:#fff;display:inline-grid;place-items:center}`;
  document.head.appendChild(css);

  // Gmail actions while nothing is connected: sign in first (inside the same tap), then continue.
  const GATED = '#refresh,#gScan,#subScan,#rcScan,#ctaScan,[data-a=unsub],[data-a=restore]';
  document.addEventListener('click', (e)=>{
    const el = e.target.closest(GATED);
    if (!el) return;
    const t = window.toast || (()=>{});
    if (!accounts.length){
      e.preventDefault(); e.stopImmediatePropagation();
      if (!G_ID) return t('Sign-in isn’t set up yet');
      googleSignIn(null).then(()=>el.click(), ()=>t('Sign-in cancelled'));
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
