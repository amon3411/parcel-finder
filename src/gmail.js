
const gBtn = document.getElementById('gScan'), gStatus = document.getElementById('gStatus');
function seenThreads(){ try{ return new Set(JSON.parse(localStorage.getItem('pfThreads')||'[]')); }catch(e){ return new Set(); } }
function saveSeen(set){ try{ localStorage.setItem('pfThreads', JSON.stringify([...set].slice(-1000))); }catch(e){} }
function payloadOf(r){
  let p = r && (r.payload ?? r);
  if (p && p.content && Array.isArray(p.content)) p = p.content.map(c=>c.text||'').join('');
  if (typeof p === 'string'){ try{ p = JSON.parse(p); }catch(e){} }
  return p || {};
}
(async ()=>{
  try{ [mcp, sample] = await Promise.all([claude.use('mcp'), claude.use('sample')]); }catch(e){}
  if (mcp){
    gBtn.disabled = rBtn.disabled = false; document.getElementById('subScan').disabled = false; document.getElementById('rcScan').disabled = false; gStatus.textContent = (()=>{ const t = loadKey('pfLastScan',0); if (window.PF && !PF.isSignedIn()) return 'Add an account above'; return t ? 'Last scan '+new Date(t).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) : 'Not scanned yet'; })();
    // auto-refresh on open if you've scanned before and it's been 30+ min
    const last = loadKey('pfLastScan', 0);
    if (last && Date.now()-last > 30*60e3 && (!window.PF || PF.isSignedIn())) scanGmail(7, true);
  }
  else { gStatus.textContent = 'Not available here'; document.getElementById('gHint').hidden = false; }
})();

const rBtn = document.getElementById('refresh');
let scanning = false;
function showLast(){ const t = loadKey('pfLastScan', 0); document.getElementById('lastRefresh').textContent = t ? `Updated ${new Date(t).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}` : 'Your deliveries'; }
showLast();
rBtn.onclick = ()=>scanGmail(loadKey('pfLastScan',0) ? 7 : +document.getElementById('gRange').value, true);
gBtn.onclick = ()=>scanGmail(+document.getElementById('gRange').value, false);

async function scanGmail(days, isRefresh){
  if (!mcp || scanning) return;
  scanning = true; gBtn.disabled = rBtn.disabled = true;
  rBtn.classList.add('busy'); document.body.classList.add('syncing'); render();
  const q = `newer_than:${days}d (tracking OR "tracking number" OR shipped OR "has shipped" OR "on its way" OR "out for delivery" OR delivered OR "order number" OR "order confirmation" OR arriving OR from:amazon.com OR from:walmart.com) -in:sent -category:promotions`;
  try{
    gStatus.textContent = 'Searching…';
    const threads = []; let token = '';
    for (let page=0; page<3; page++){
      const res = payloadOf(await mcp.callTool('Gmail','search_threads',{query:q,pageSize:50,view:'THREAD_VIEW_SUMMARY',...(token?{pageToken:token}:{})}));
      (res.threads||[]).forEach(t=>threads.push(t));
      token = res.nextPageToken; if (!token) break;
    }
    const seen = seenThreads();
    // key on message count so a thread that gets a new "delivered" message is re-read
    const todo = threads.filter(t=>!seen.has(`${t.id}:${t.messageCount||1}`));
    let added=0, done=0;
    for (let i=0;i<todo.length;i+=4){
      await Promise.all(todo.slice(i,i+4).map(async t=>{
        try{
          const th = payloadOf(await mcp.callTool('Gmail','get_thread',{threadId:t.id,messageFormat:'PLAIN_TEXT'}));
          const msgs = th.messages||[];
          // process each message oldest→newest so the latest status wins
          for (const m of msgs){
            const r = await processEmail(m.plaintextBody||m.snippet||'', {subject:m.subject||'', from:m.sender||'', date:m.date, source:m.account||'Gmail', link:m.viewUrl||th.viewUrl||''});
            added += r.added;
          }
          seen.add(`${t.id}:${t.messageCount||msgs.length||1}`);
        }catch(e){}
        done++; gStatus.textContent = `Reading ${done}/${todo.length}…`; setProgress(done/todo.length);
      }));
      save(); render();
    }
    saveSeen(seen); save(); render();
    let swept = 0; try{ swept = await sweepBlocked(); }catch(e){}
    try{ localStorage.setItem('pfLastScan', JSON.stringify(Date.now())); }catch(e){} showLast();
    gStatus.textContent = `Last scan ${new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}`;
    const parts = [todo.length ? `${added} new package${added===1?'':'s'}` : (isRefresh ? 'Up to date' : 'No new shipping emails')];
    if (swept) parts.push(`${swept} blocked email${swept===1?'':'s'} cleared`);
    toast(parts.join(' · '));
  }catch(e){
    const code = e && (e.code||e.message) || '';
    gStatus.textContent = /not_connected|authz|denied/i.test(code) ? (window.PF ? 'Signed out — tap refresh to sign in' : 'Gmail not connected — connect it in Claude') : 'Scan failed — try again';
  }
  scanning = false; gBtn.disabled = rBtn.disabled = false; rBtn.classList.remove('busy'); document.body.classList.remove('syncing');
}
