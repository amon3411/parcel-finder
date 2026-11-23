
const CARRIERS = {
  UPS:    {color:'#6b4a2b', url:n=>`https://www.ups.com/track?tracknum=${n}`},
  USPS:   {color:'#2f5aa8', url:n=>`https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`},
  FedEx:  {color:'#4d148c', url:n=>`https://www.fedex.com/fedextrack/?trknbr=${n}`},
  DHL:    {color:'#c99a00', url:n=>`https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${n}`},
  Amazon: {color:'#d27b00', url:()=>`https://www.amazon.com/gp/css/order-history`},
  OnTrac: {color:'#0a7d4f', url:n=>`https://www.ontrac.com/tracking/?number=${n}`},
  LaserShip:{color:'#0a7d4f', url:n=>`https://www.ontrac.com/tracking/?number=${n}`},
  Walmart:{color:'#0071ce', url:n=>`https://www.walmart.com/orders/${n}`},
  AmazonOrder:{color:'#d27b00', url:n=>`https://www.amazon.com/gp/your-account/order-details?orderID=${n}`},
  'Intl Post': {color:'#5a6170', url:n=>`https://parcelsapp.com/en/tracking/${n}`},
  Other:  {color:'#5a6170', url:n=>`https://parcelsapp.com/en/tracking/${n}`}
};
const STATUSES = ['Ordered','Label created','Shipped','In transit','Out for delivery','Delivered'];
const STEP = {'Ordered':1,'Label created':1,'Shipped':2,'In transit':3,'Delayed':3,'Exception':3,'Out for delivery':4,'Delivered':5};
const SHIP_WORDS = /(track|tracking|shipment|shipped|package|parcel|fedex|dhl|ups|usps|delivery|carrier|waybill|airbill)/i;

const PATTERNS = [
  [/\b1Z[0-9A-Z]{16}\b/g, 'UPS', false],
  [/\bTBA\d{12}\b/g, 'Amazon', false],
  [/\b9[2-5]\d{18,24}\b/g, 'USPS', false],
  [/\b420\d{5}9[2-5]\d{20}\b/g, 'USPS', false],
  [/\b[A-Z]{2}\d{9}US\b/g, 'USPS', false],
  [/\b[A-Z]{2}\d{9}(?!US)[A-Z]{2}\b/g, 'Intl Post', true],
  [/\b[CD]\d{14}\b/g, 'OnTrac', true],
  [/\b(?:96\d{20}|\d{15}|\d{12})\b/g, 'FedEx', true],
  [/\bJJD\d{18}\b|\b\d{10}\b/g, 'DHL', true],
];

// ---------- storage ----------
let store = load();   // {num, carrier, title, merchant, status, eta, order, items, source, link, emailDate, added}
let orders = loadKey('pfOrders', []); // {order, merchant, title, source, link, emailDate}
function loadKey(k, d){ try{ return JSON.parse(localStorage.getItem(k)||'null') ?? d; }catch(e){ return d; } }
function load(){
  const s = loadKey('parcelFinder2', null);
  if (s) return s;
  // migrate v1 list
  return loadKey('parcelFinder', []).filter(x=>x.carrier!=='Order').map(x=>({num:x.num,carrier:x.carrier,title:x.label,merchant:x.from,status:x.done?'Delivered':'Shipped',eta:'',source:x.source||'Pasted',link:x.link||'',emailDate:x.added,added:x.added}));
}
function save(){ try{ localStorage.setItem('parcelFinder2', JSON.stringify(store)); localStorage.setItem('pfOrders', JSON.stringify(orders)); }catch(e){} }

// ---------- email decoding ----------
function decodeQP(s){ return s.replace(/=\r?\n/g,'').replace(/=([0-9A-F]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16))); }
function decodeEmail(raw){
  let out = raw.replace(/Content-Transfer-Encoding:\s*base64[^\n]*\n(?:[^\n]*\n)*?\r?\n([A-Za-z0-9+/=\r\n]{40,})/gi,(m,b)=>{
    try{ const bin = atob(b.replace(/\s+/g,'')); return m + '\n' + new TextDecoder().decode(Uint8Array.from(bin,c=>c.charCodeAt(0))); }catch(e){ return m; }
  });
  if (/quoted-printable/i.test(out) || /=\r?\n/.test(out)) out = decodeQP(out);
  return out;
}
function stripHtml(s){
  return s.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ')
          .replace(/<br\s*\/?>|<\/p>|<\/tr>|<\/div>/gi,'\n').replace(/<[^>]+>/g,' ')
          .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#\d+;/g,' ').replace(/[ \t]+/g,' ');
}
function header(raw, name){
  const m = raw.match(new RegExp('^'+name+':\\s*(.+)$','im'));
  return m ? m[1].trim().replace(/=\?[^?]+\?[QB]\?([^?]*)\?=/gi,(_,t)=>t.replace(/_/g,' ')) : '';
}
function prettyDomain(d){
  d = (d||'').toLowerCase().replace(/^(mail|email|e|info|ship|shipping|orders?|noreply|no-reply|transaction|em|t|m)\./,'');
  const base = d.split('.').slice(-2,-1)[0] || d;
  return base ? base.charAt(0).toUpperCase()+base.slice(1) : '';
}

// ---------- regex extraction (always runs) ----------
function regexTracking(text){
  const found = new Map();
  for (const [re, carrier, needsCtx] of PATTERNS){
    re.lastIndex = 0; let m;
    while ((m = re.exec(text))){
      const n = m[0];
      if ([...found.keys()].some(k=>k.includes(n))) continue;
      if (needsCtx){
        const ctx = text.slice(Math.max(0,m.index-120), m.index+20);
        if (!SHIP_WORDS.test(ctx)) continue;
        if (/(phone|tel|call|fax|zip|account|invoice)\W{0,15}$/i.test(text.slice(Math.max(0,m.index-25), m.index))) continue;
        if (carrier==='DHL' && !/dhl/i.test(ctx)) continue;
      }
      found.set(n, carrier);
    }
  }
  return found;
}
function regexOrders(text){
  const out = new Set(); let m;
  const res = [/\b\d{3}-\d{7}-\d{7}\b/g, /order\s*(?:#|number|no\.?|id)\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{4,24})\b/gi];
  for (const re of res){ while ((m = re.exec(text))){ const n=(m[1]||m[0]).toUpperCase(); if (/\d/.test(n)) out.add(n); } }
  return [...out];
}
function regexStatus(text){
  if (/out for delivery/i.test(text)) return 'Out for delivery';
  if (/(has been|was|been) delivered|delivered today|package delivered|your (package|order|item)s? (was |has been )?delivered/i.test(text)) return 'Delivered';
  if (/delay|exception|running late/i.test(text)) return 'Delayed';
  if (/in transit/i.test(text)) return 'In transit';
  if (/shipped|on (its|the) way|has left|dispatched/i.test(text)) return 'Shipped';
  if (/label (created|has been created)|preparing (your|for) shipment/i.test(text)) return 'Label created';
  return 'Shipped';
}
const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
function regexEta(text, ref){
  const re = new RegExp(`(arriv\\w*|estimated delivery|expected delivery|delivery date|deliver(?:y|ed)? by|get it by|scheduled delivery)[^\\n]{0,40}?\\b(${MONTHS})\\w*\\.?\\s+(\\d{1,2})`,'i');
  const m = text.match(re);
  if (!m){
    const base = new Date(ref||Date.now());
    if (/(arriv\w*|deliver\w*)\s+(by\s+)?today/i.test(text)) return base.toISOString().slice(0,10);
    if (/(arriv\w*|deliver\w*)\s+(by\s+)?tomorrow/i.test(text)){ base.setDate(base.getDate()+1); return base.toISOString().slice(0,10); }
    const w = text.match(/(arriv\w*|deliver\w*|get it)\s+(by\s+|on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i);
    if (w){ const want = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(w[3].toLowerCase());
      for (let i=0;i<7;i++){ if (base.getDay()===want) return base.toISOString().slice(0,10); base.setDate(base.getDate()+1); } }
    return '';
  }
  const mo = MONTHS.split('|').indexOf(m[2].toLowerCase().slice(0,3));
  const base = new Date(ref||Date.now());
  let d = new Date(base.getFullYear(), mo, +m[3]);
  if (d - base < -60*864e5) d = new Date(base.getFullYear()+1, mo, +m[3]);
  return d.toISOString().slice(0,10);
}

// ---------- Claude extraction (when available) ----------
let sample = null, mcp = null;
async function aiExtract(text, meta){
  if (!sample) return null;
  const prompt = `You extract shipment info from one email. Today is ${new Date().toISOString().slice(0,10)}; the email was sent ${meta.date||'recently'}.
Return ONLY JSON: {"merchant": string|null, "items": string|null (short product names, max 80 chars), "order": string|null,
 "status": order-level status (same choices as below) or null, "eta": "YYYY-MM-DD"|null (order-level, for emails with no tracking number),
 "shipments":[{"tracking": string, "carrier": "UPS"|"USPS"|"FedEx"|"DHL"|"Amazon"|"OnTrac"|"LaserShip"|"Other",
   "status": "Ordered"|"Label created"|"Shipped"|"In transit"|"Out for delivery"|"Delivered"|"Delayed",
   "eta": "YYYY-MM-DD"|null}]}
For "eta" use the delivery date or the LATEST date of a delivery window the email states (e.g. "arriving Nov 24-26" -> the 26th); if the email says "today"/"tomorrow", convert using the sent date. If delivered, eta = delivery date.
Use only tracking numbers that literally appear in the email. If there is no tracking number, return "shipments": [].
Subject: ${meta.subject||''}
From: ${meta.from||''}
---
${text.slice(0,7000)}`;
  try{ return await sample.json(prompt, {modelTier:'quick'}); }
  catch(e){ if (e && (e.code==='not_granted')) sample = null; return null; }
}

// typical business-day transit when the email gives no date
const TRANSIT = {AmazonOrder:[1,3], Walmart:[1,4], UPS:[1,5], FedEx:[1,5], USPS:[2,5], Amazon:[1,3], DHL:[2,6], OnTrac:[1,3], LaserShip:[1,3], 'Intl Post':[7,21], Other:[3,8]};
function addBiz(date, n){ const d = new Date(date); d.setHours(12,0,0,0); while (n>0){ d.setDate(d.getDate()+1); if (d.getDay()%6) n--; } return d; }
function estimate(it){
  if (it.eta || it.status==='Delivered') return null;
  const today = new Date(); today.setHours(12,0,0,0);
  if (it.status==='Out for delivery') return {from:today, to:today};
  const [a,b] = TRANSIT[it.carrier] || TRANSIT.Other;
  const shipped = new Date(it.emailDate || it.added);
  let from = addBiz(shipped, it.status==='Label created'||it.status==='Ordered' ? a+1 : a);
  let to = addBiz(shipped, it.status==='Label created'||it.status==='Ordered' ? b+1 : b);
  if (it.status==='Delayed') to = addBiz(to, 2);
  if (to < today) return {from:today, to:today, late:true};
  if (from < today) from = today;
  return {from, to};
}
function sortDate(it){ if (it.eta) return it.eta; const e = estimate(it); return e ? e.from.toISOString().slice(0,10) : '9999'; }

function rank(s){ return {'Out for delivery':0,'Delayed':1,'In transit':2,'Shipped':3,'Label created':4,'Ordered':5,'Delivered':9}[s] ?? 5; }

function upsert(rec){
  const ex = store.find(s=>s.num===rec.num);
  if (!ex){ store.unshift({...rec, added:Date.now()}); return 1; }
  const newer = (rec.emailDate||0) >= (ex.emailDate||0);
  for (const k of ['title','merchant','items','order','link','carrier']) if (rec[k] && (!ex[k] || newer && k==='link')) ex[k]=rec[k];
  if (newer){ if (rec.status) ex.status = rec.status; if (rec.eta) ex.eta = rec.eta; ex.emailDate = rec.emailDate; }
  return 0;
}

async function processEmail(raw, meta){
  const decoded = decodeEmail(raw);
  const plain = stripHtml(decoded);
  const scanTextAll = decoded + '\n' + plain;
  meta.subject = meta.subject || header(raw,'Subject');
  const fromHdr = header(raw,'From');
  meta.from = meta.from || fromHdr;
  const fromDomain = (meta.from.match(/@([\w.-]+)/)||[])[1] || '';
  const emailDate = meta.date ? Date.parse(meta.date) : (Date.parse(header(raw,'Date')) || Date.now());

  const rx = regexTracking(scanTextAll);
  const ai = await aiExtract(plain.length > 200 ? plain : scanTextAll, {...meta, date:new Date(emailDate).toISOString().slice(0,10)});
  const merchant = (ai && ai.merchant) || prettyDomain(fromDomain);
  const title = (ai && ai.items) || meta.subject || 'Package';
  const squash = s=>String(s||'').replace(/[\s-]/g,'').toUpperCase();
  const textSquashed = squash(scanTextAll);

  const shipments = new Map();
  if (ai && Array.isArray(ai.shipments)){
    for (const s of ai.shipments){
      const n = squash(s.tracking);
      if (n.length < 8 || !textSquashed.includes(n)) continue; // reject anything not in the email
      shipments.set(n, {carrier: CARRIERS[s.carrier] ? s.carrier : (rx.get(n)||'Other'), status: STATUSES.includes(s.status)||s.status==='Delayed' ? s.status : '', eta: /^\d{4}-\d{2}-\d{2}$/.test(s.eta||'') ? s.eta : ''});
    }
  }
  for (const [n,c] of rx) if (!shipments.has(n)) shipments.set(n, {carrier:c});

  let added = 0;
  const fallbackStatus = regexStatus(plain), fallbackEta = regexEta(plain, emailDate);
  for (const [num, s] of shipments){
    added += upsert({num, carrier:s.carrier, title, merchant, items: ai&&ai.items||'', order: ai&&ai.order||'',
      status: s.status || fallbackStatus, eta: s.eta || fallbackEta, source: meta.source, link: meta.link||'', emailDate});
  }
  // orders with no tracking yet
  const ordNums = ai && ai.order ? [String(ai.order).toUpperCase()] : regexOrders(plain);
  const retailer = /amazon/i.test(fromDomain+merchant) ? 'AmazonOrder' : /walmart/i.test(fromDomain+merchant) ? 'Walmart' : '';
  const st = (ai && ai.status) || regexStatus(plain);
  const shipSignal = /shipped|on (its|the) way|out for delivery|delivered|arriving|in transit/i.test(plain + ' ' + meta.subject);
  if (!shipments.size && ordNums.length && shipSignal){
    // no tracking number in the email (common for Amazon & Walmart) — track by order number
    const o = ordNums[0];
    const eta = (ai && /^\d{4}-\d{2}-\d{2}$/.test(ai.eta||'') && ai.eta) || fallbackEta;
    added += upsert({num:o, isOrder:true, carrier: retailer || 'Other', title, merchant, items: ai&&ai.items||'', order:o,
      status: st, eta, source: meta.source, link: meta.link||'', emailDate});
    orders = orders.filter(x=>x.order!==o);
    return {added, found:1};
  }
  if (!shipments.size){
    for (const o of ordNums){
      if (store.some(s=>s.order && s.order.toUpperCase()===o) || orders.some(x=>x.order===o)) continue;
      orders.unshift({order:o, merchant, title, source:meta.source, link:meta.link||'', emailDate});
    }
  } else {
    // a tracking email arrived for this order — drop it from the waiting list
    orders = orders.filter(x=>!ordNums.includes(x.order));
    store = store.filter(x=>!(x.isOrder && ordNums.includes(String(x.num).toUpperCase())));
  }
  return {added, found: shipments.size};
}

