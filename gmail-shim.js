/* Parcel Finder — standalone Gmail connection.
   Replaces the Claude connector with Google's own sign-in + the Gmail API,
   exposing the same callTool('Gmail', tool, input) interface the app uses. */
(function(){
  const CLIENT_ID = (window.PF_CONFIG && window.PF_CONFIG.clientId) || '';
  const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
  const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
  let tokenClient = null, gisReady = null;
  let tok = (()=>{ try{ return JSON.parse(localStorage.getItem('pfGToken')||'null'); }catch(e){ return null; } })();

  const valid = ()=> tok && tok.access_token && tok.exp > Date.now() + 60e3;
  function saveTok(t){ tok = t; try{ t ? localStorage.setItem('pfGToken', JSON.stringify(t)) : localStorage.removeItem('pfGToken'); }catch(e){} }

  function loadGis(){
    if (gisReady) return gisReady;
    gisReady = new Promise((res, rej)=>{
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = ()=>res(); s.onerror = ()=>rej(new Error('gis_load_failed')); document.head.appendChild(s);
    });
    return gisReady;
  }
  loadGis().catch(()=>{});

  // Must be called from a tap (Google opens a popup)
  function signIn(hint){
    return new Promise((resolve, reject)=>{
      if (!CLIENT_ID) return reject({code:'not_configured'});
      if (!window.google || !google.accounts){ return reject({code:'gis_not_loaded'}); }
      tokenClient = tokenClient || google.accounts.oauth2.initTokenClient({client_id: CLIENT_ID, scope: SCOPE, callback: ()=>{}});
      tokenClient.callback = (r)=>{
        if (r.error) return reject({code:'denied', message:r.error});
        saveTok({access_token:r.access_token, exp: Date.now() + (r.expires_in||3600)*1000, email: tok && tok.email});
        profile().then(()=>{ updateUi(); resolve(); }, ()=>{ updateUi(); resolve(); });
      };
      tokenClient.requestAccessToken({prompt: tok && tok.email ? '' : 'consent', login_hint: hint || (tok && tok.email) || undefined});
    });
  }
  function signOut(){
    if (tok && tok.access_token && window.google) try{ google.accounts.oauth2.revoke(tok.access_token, ()=>{}); }catch(e){}
    saveTok(null); updateUi();
  }

  async function api(path, opts={}){
    if (!valid()) throw {code:'not_connected', message:'Sign in to Gmail'};
    const r = await fetch(API + path, {...opts, headers:{Authorization:'Bearer '+tok.access_token, 'Content-Type':'application/json', ...(opts.headers||{})}});
    if (r.status === 401){ saveTok({...tok, exp:0}); updateUi(); throw {code:'not_connected', message:'Session expired'}; }
    if (r.status === 429) throw {code:'rate_limited', retryable:true};
    if (!r.ok) throw {code:'tool_error', message: 'Gmail error '+r.status};
    return r.status === 204 ? {} : r.json();
  }
  async function profile(){ const p = await api('/profile'); tok.email = p.emailAddress; saveTok(tok); return p; }

  // ---- message parsing ----
  const b64 = s=>{ try{ const bin = atob(s.replace(/-/g,'+').replace(/_/g,'/')); return new TextDecoder().decode(Uint8Array.from(bin, c=>c.charCodeAt(0))); }catch(e){ return ''; } };
  const hdr = (m, n)=> ((m.payload && m.payload.headers)||[]).find(h=>h.name.toLowerCase()===n.toLowerCase())?.value || '';
  function parts(p, out={text:'', html:''}){
    if (!p) return out;
    if (p.mimeType === 'text/plain' && p.body && p.body.data && !out.text) out.text = b64(p.body.data);
    else if (p.mimeType === 'text/html' && p.body && p.body.data && !out.html) out.html = b64(p.body.data);
    (p.parts||[]).forEach(c=>parts(c, out));
    return out;
  }
  function htmlToText(h){
    return h.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ')
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m,u,t)=>`${t.replace(/<[^>]+>/g,'')} ( ${u} )`)
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi,'\n').replace(/<[^>]+>/g,' ')
      .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;|&rsquo;/g,"'").replace(/&quot;/g,'"')
      .replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n\n');
  }
  function addr(from){
    const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
    return m ? {email:m[2].trim().toLowerCase(), name:m[1].trim()} : {email:from.trim().toLowerCase(), name:''};
  }
  const viewUrl = id => `https://mail.google.com/mail/u/${encodeURIComponent((tok&&tok.email)||'0')}/#all/${id}`;
  function mapMsg(m, full, withHtml){
    const a = addr(hdr(m,'From'));
    const o = {id:m.id, threadId:m.threadId, subject:hdr(m,'Subject'), sender:a.email, snippet:m.snippet||'',
      date: new Date(+m.internalDate || Date.parse(hdr(m,'Date')) || Date.now()).toISOString(),
      labelIds:m.labelIds||[], addressDisplayNames:[{emailAddress:a.email, displayName:a.name}], viewUrl:viewUrl(m.threadId)};
    if (full){
      const p = parts(m.payload);
      o.plaintextBody = p.text || (p.html ? htmlToText(p.html) : m.snippet||'');
      if (withHtml) o.htmlBody = p.html;
    }
    return o;
  }
  async function pool(items, n, fn){
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({length:Math.min(n, items.length)}, async ()=>{ while (i < items.length){ const k = i++; out[k] = await fn(items[k]).catch(()=>null); } }));
    return out;
  }

  const tools = {
    async search_threads({query='', pageSize=20, pageToken, view}){
      const qs = new URLSearchParams({q:query, maxResults:String(pageSize)}); if (pageToken) qs.set('pageToken', pageToken);
      const r = await api('/threads?'+qs);
      const ids = (r.threads||[]).map(t=>t.id);
      if (view === 'THREAD_VIEW_IDS_ONLY') return {threads: ids.map(id=>({id})), nextPageToken:r.nextPageToken};
      const threads = await pool(ids, 8, async id=>{
        const t = await api(`/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        const msgs = (t.messages||[]).map(m=>mapMsg(m,false));
        return {id, messageCount: msgs.length, viewUrl:viewUrl(id), messages: view==='THREAD_VIEW_SUMMARY' ? msgs.slice(-1) : msgs.slice(0,5)};
      });
      return {threads: threads.filter(Boolean), nextPageToken:r.nextPageToken};
    },
    async get_thread({threadId, messageFormat}){
      const t = await api(`/threads/${threadId}?format=full`);
      return {id:t.id, viewUrl:viewUrl(t.id), messageCount:(t.messages||[]).length,
        messages:(t.messages||[]).map(m=>mapMsg(m, messageFormat!=='MINIMAL' && messageFormat!=='METADATA_ONLY', messageFormat==='FULL_CONTENT'))};
    },
    async trash_thread({threadId}){ return api(`/threads/${threadId}/trash`, {method:'POST'}); },
    async untrash_thread({threadId}){ return api(`/threads/${threadId}/untrash`, {method:'POST'}); },
    async send_message({to=[], subject='', body=''}){
      const mime = [`To: ${to.join(', ')}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=UTF-8', '', body].join('\r\n');
      const raw = btoa(unescape(encodeURIComponent(mime))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      return api('/messages/send', {method:'POST', body:JSON.stringify({raw})});
    }
  };
  const gmail = {
    async callTool(server, tool, input){
      if (!tools[tool]) throw {code:'tool_error', message:'unknown tool '+tool};
      return {payload: await tools[tool](input||{})};
    }
  };

  // The app asks for capabilities via claude.use(); answer with the Gmail bridge.
  window.claude = { use: async (name)=> name === 'mcp' ? gmail : null };
  window.PF = { signIn, signOut, isSignedIn: valid, account: ()=>tok && tok.email, configured: !!CLIENT_ID };

  // ---- UI glue ----
  function updateUi(){
    const st = document.getElementById('gStatus'), hint = document.getElementById('gHint'), btn = document.getElementById('gAuth');
    if (!st) return;
    if (!CLIENT_ID){ st.textContent = 'Not set up yet'; return; }
    if (valid()){ st.textContent = tok.email ? `Signed in as ${tok.email}` : 'Signed in'; }
    else if (tok && tok.email){ st.textContent = `${tok.email} · tap to reconnect`; }
    else st.textContent = 'Not signed in';
    if (hint) hint.hidden = false;
    if (btn){ btn.textContent = valid() ? 'Sign out' : 'Sign in with Google'; btn.className = valid() ? 'btn' : 'btn primary'; }
  }
  // Any Gmail action while signed out: sign in first (inside the same tap), then continue.
  const GATED = '#refresh,#gScan,#subScan,#rcScan,#ctaScan,[data-a=unsub],[data-a=restore]';
  document.addEventListener('click', (e)=>{
    const el = e.target.closest(GATED);
    if (!el || valid()) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!CLIENT_ID){ window.toast && toast('Google sign-in isn’t set up yet'); return; }
    signIn().then(()=>{ el.click(); }, (err)=>{ window.toast && toast(err && err.code==='denied' ? 'Sign-in cancelled' : 'Couldn’t sign in'); });
  }, true);
  document.addEventListener('DOMContentLoaded', ()=>{
    const item = document.getElementById('gHint');
    if (item){
      item.hidden = false;
      item.innerHTML = '<button class="btn primary full" id="gAuth">Sign in with Google</button>';
      item.querySelector('#gAuth').onclick = ()=> valid() ? signOut() : signIn().catch(()=>{});
    }
    updateUi();
  });
  window.addEventListener('load', updateUi);
})();
