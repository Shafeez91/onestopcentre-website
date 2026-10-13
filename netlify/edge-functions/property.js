// One Stop Centre – server-side pages (Netlify Edge Function)
// Builds the homepage data, every /property/... page and /sitemap.xml fresh from the database,
// so Google, WhatsApp and Facebook always see the latest titles, photos and prices.
const SB_URL = "https://deethrwnmyezwsohmhzl.supabase.co";
const SB_KEY = "sb_publishable_gaiT2UF6vtI42BbYH1egKg_T_yLT83g";
const SITE = "https://onestopcentreproperty.com/";
const OG_DEFAULT = SITE + "og-default.jpg";

function kit(P, S) {
  const window = {};
  const $ = () => null;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
 const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
 const today=()=>new Date().toISOString().slice(0,10);
 const clean=v=>{v=String(v??'').trim();return /^(none|null|undefined)$/i.test(v)?'':v};
 const ex=s=>esc(clean(s));
 const siteBase=()=>{let u=clean(($('s_site')&&$('s_site').value)||S.site);if(!u)return '';if(!/^https?:\/\//i.test(u))u='https://'+u;return u.replace(/[#?].*$/,'').replace(/\/+$/,'')+'/'};
 const kebab=s=>clean(s).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70).replace(/-+$/,'');
 function canon(v){return Array.isArray(v)?'['+v.map(canon).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}':JSON.stringify(v===undefined?null:v)}
 window.__canon=canon;
 function hash(str){let h=2166136261;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)}return (h>>>0).toString(36)}
 /* Give every property a permanent URL slug and a last-modified date. New properties get theirs automatically. */
 function stamp(){
  const used=new Set();let changed=false;
  P.forEach(p=>{if(p.slug&&!used.has(p.slug))used.add(p.slug);else if(p.slug){p.slug='';}});
  P.forEach(p=>{
   if(!p.slug){let b=kebab([p.n,p.l].filter(Boolean).join(' '))||('property-'+String(p.id).replace(/\W/g,'').slice(-6));let s=b,i=2;while(used.has(s))s=b+'-'+i++;p.slug=s;used.add(s);changed=true}
   const {sh,mod,...rest}=p;const h=hash(canon(rest));if(p.sh!==h){p.sh=h;p.mod=today();changed=true}
  });
  return changed;
 }
 window.seoStamp=stamp;
 const nums=p=>[...(p.types||[]).map(t=>t.price),p.p].map(x=>+String(x||'').replace(/[^\d.]/g,'')).filter(n=>n>=10000);
 const priceTxt=p=>{const n=nums(p);if(!n.length)return clean(p.p)&&!/enquire/i.test(p.p)?clean(p.p):'';return 'from RM'+Math.min(...n).toLocaleString('en-MY')};
 const cover=p=>(p.gallery&&p.gallery.find(Boolean))||p.img||'';
 function pTitle(p){return clean(p.seoT)||(clean(p.n)+(clean(p.l)?' – '+clean(p.l):'')+' | One Stop Centre')}
 function pDesc(p){
  if(clean(p.seoD))return clean(p.seoD).replace(/\s+/g,' ').slice(0,300);
  const bits=[clean(p.t)||clean(p.c)||'Property',clean(p.l)&&'in '+clean(p.l),clean(p.d)&&'by '+clean(p.d)].filter(Boolean).join(' ');
  const more=[clean(p.s),clean(p.z),priceTxt(p),clean(p.tenure)].filter(Boolean).join(' · ');
  const hl=(p.hl||[]).map(clean).filter(Boolean).slice(0,3).join(', ');
  return (clean(p.n)+': '+bits+'. '+more+(hl?'. '+hl:'')+'. Compare layouts, prices and maintenance fees.').replace(/\s+/g,' ').slice(0,300);
 }
 const siteDesc=()=>{const dv=new Set(P.map(p=>clean(p.d)).filter(Boolean)).size,ar=new Set(P.map(p=>clean(p.l)).filter(Boolean)).size,pl=(n,w)=>n+' '+w+(n===1?'':'s');return `Browse ${pl(P.length,'new launch and ready home')} in ${pl(ar,'area')} across Klang Valley from ${pl(dv,'developer')}. Compare layouts, sizes, maintenance fees and prices, then talk to us directly.`};
 /* Visible "All properties" directory: plain links every crawler can follow */
 function dirHtml(pack){
  const list=[...P].sort((a,b)=>clean(a.n).localeCompare(clean(b.n)));
  return `<h2>All properties</h2><p class="sub">Every project on One Stop Centre, A to Z.</p><ul class="seodir">`+list.map(p=>`<li><a href="${pack?'/property/'+p.slug+'/':'#p='+esc(p.id)}" data-pid="${esc(p.id)}">${ex(p.n)}</a><span>${[ex(p.l),ex(p.t||p.c),esc(priceTxt(p))].filter(Boolean).join(' · ')}</span></li>`).join('')+`</ul>`;
 }
 function listLd(base){
  const g=[{"@type":"RealEstateAgent","name":"One Stop Centre Property Lists","description":siteDesc(),...(base?{"url":base}:{}),...(S.email?{"email":S.email}:{}),...(S.wa?{"telephone":'+'+S.wa.replace(/\D/g,'')}:{}),"areaServed":"Klang Valley, Malaysia"},
   {"@type":"ItemList","name":"Property listings","numberOfItems":P.length,"itemListElement":P.map((p,i)=>({"@type":"ListItem","position":i+1,"name":clean(p.n),...(base?{"url":base+'property/'+p.slug+'/'}:{})}))}];
  return JSON.stringify({"@context":"https://schema.org","@graph":g}).replace(/</g,'\\u003c');
 }

 function pageCss(){return `:root{--ink:#0f1b33;--mute:#5b6784;--acc:#c8102e;--navy:#0c1f4a;--line:#dfe4ee;--bg:#f1f4fa}*{box-sizing:border-box}body{margin:0;font-family:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6}a{color:var(--acc)}header.top{background:linear-gradient(180deg,#060f26,#0c1f4a);color:#fff;padding:14px 5%;display:flex;justify-content:space-between;align-items:center;gap:12px}header.top a{color:#fff;text-decoration:none;font-weight:700}.wrap{max-width:980px;margin:0 auto;padding:22px 5% 60px}nav.bc{font-size:.85rem;color:var(--mute);margin-bottom:10px}nav.bc a{color:var(--mute)}h1{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:clamp(1.8rem,5vw,2.6rem);line-height:1.15;margin:.2em 0}h2{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:1.35rem;margin:1.8em 0 .5em}.lead{color:var(--mute);margin:0 0 14px}.pills{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.pills span{background:#fff;border:1px solid var(--line);border-radius:30px;padding:5px 12px;font-size:.85rem}.hl span{background:#fdecef;border-color:#f6c6ce;color:var(--acc);font-weight:600}.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:16px 0}.gal img:first-child{grid-column:1/-1;aspect-ratio:16/9}.gal img{width:100%;max-width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;display:block;background:#dde3ef}.price{font-size:1.5rem;font-weight:700;color:var(--navy)}.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px}.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:520px;background:#fff;border-radius:12px;overflow:hidden}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);font-size:.92rem}th{background:#f6f8fc}dl{display:grid;grid-template-columns:minmax(120px,max-content) 1fr;gap:6px 16px;margin:0}dt{color:var(--mute)}dd{margin:0;font-weight:600}ul.cols{columns:2 220px;padding-left:1.1em}.cta{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0}.cta a{display:inline-block;padding:12px 20px;border-radius:30px;font-weight:700;text-decoration:none}.wa{background:#1fae5b;color:#fff}.alt{background:#fff;border:1px solid var(--line);color:var(--ink)}.lay img{max-width:100%;border-radius:10px}footer{text-align:center;color:var(--mute);font-size:.85rem;padding:30px 5%;border-top:1px solid var(--line)}.rel{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;padding:0;list-style:none}.rel li{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px}.rel small{display:block;color:var(--mute)}`}
 function propPage(p,base,imgs,rel){
  const url=base+'property/'+p.slug+'/',title=pTitle(p),desc=pDesc(p);
  const absImg=imgs.map(i=>/^https?:/.test(i)?i:url+i);
  const n=nums(p),wa=S.wa?'https://wa.me/'+S.wa.replace(/\D/g,'')+'?text='+encodeURIComponent('Hi, I am interested in '+clean(p.n)+' ('+url+')'):'';
  const facts=[['Location',p.l],['Developer',p.d],['Category',p.c],['Property type',p.t],['Status',p.s],['Price',priceTxt(p)||p.p],['Built-up size',p.z],['Bedrooms',p.b&&(p.b+' max')],['Tenure',[clean(p.tenure),clean(p.lease)&&clean(p.lease)+' years'].filter(Boolean).join(', ')],['Completion',p.year],['Storeys',p.height],['Furnishing',p.furn],['Maintenance fee',clean(p.maintPsf)&&'RM'+clean(p.maintPsf)+' psf'],['Address',p.address]].filter(f=>clean(f[1]));
  const T=(p.types||[]).filter(t=>t&&(t.name||t.size||t.price));
  const near=p.near||{},nl=(k,lab)=>(near[k]||[]).filter(x=>x&&x.n).length?`<h3>${lab}</h3><ul class="cols">${near[k].filter(x=>x&&x.n).map(x=>`<li>${ex(x.n)}${clean(x.d)?' ('+ex(x.d)+')':''}${clean(x.st)?' – '+ex(x.st):''}${clean(x.y)?', '+ex(x.y):''}</li>`).join('')}</ul>`:'';
  const nearHtml=nl('transit','Transit')+nl('schools','Schools')+nl('uni','Universities')+nl('amen','Shopping & amenities')+nl('future','Future developments');
  const concl=p.concl&&clean(p.concl.text);
  const ld={"@context":"https://schema.org","@graph":[
   {"@type":"RealEstateListing","@id":url+'#listing',"url":url,"name":clean(p.n),"description":desc,...(absImg.length?{"image":absImg}:{}),...(p.mod?{"dateModified":p.mod}:{}),
    ...(n.length?{"offers":{"@type":"AggregateOffer","priceCurrency":"MYR","lowPrice":Math.min(...n),"highPrice":Math.max(...n),"offerCount":Math.max(1,T.length),"availability":"https://schema.org/InStock","url":url}}:{}),
    "about":{"@type":/landed|link|terrace|semi|bungalow|storey/i.test(p.t)?"SingleFamilyResidence":"ApartmentComplex","name":clean(p.n),"address":{"@type":"PostalAddress",...(clean(p.address)?{"streetAddress":clean(p.address)}:{}),"addressLocality":clean(p.l),"addressRegion":"Klang Valley","addressCountry":"MY"},...(+p.b?{"numberOfBedrooms":+p.b}:{}),...((p.facilities||[]).length?{"amenityFeature":p.facilities.filter(Boolean).map(f=>({"@type":"LocationFeatureSpecification","name":clean(f),"value":true}))}:{}),...(clean(p.mapUrl)?{"hasMap":clean(p.mapUrl)}:{})},
    ...(clean(p.d)?{"provider":{"@type":"Organization","name":clean(p.d)}}:{})},
   {"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"All properties","item":base},...(clean(p.l)?[{"@type":"ListItem","position":2,"name":clean(p.l),"item":base+'#loc='+encodeURIComponent(clean(p.l))}]:[]),{"@type":"ListItem","position":clean(p.l)?3:2,"name":clean(p.n),"item":url}]}]};
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><meta name="robots" content="index, follow, max-image-preview:large"><link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="One Stop Centre Property Lists"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}">${absImg[0]?`<meta property="og:image" content="${esc(absImg[0])}"><meta name="twitter:card" content="summary_large_image">`:''}
<meta name="theme-color" content="#0a1a3a"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600&family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g,'\\u003c')}<\/script><style>${pageCss()}</style></head>
<body><header class="top"><a href="../../">◆ One Stop Centre</a>${wa?`<a href="${esc(wa)}" rel="noopener">Enquire</a>`:''}</header>
<main class="wrap"><nav class="bc" aria-label="Breadcrumb"><a href="../../">All properties</a>${clean(p.l)?' › '+ex(p.l):''} › ${ex(p.n)}</nav>
<article><h1>${ex(p.n)}</h1><p class="lead">${[ex(p.t||p.c),clean(p.l)&&'in '+ex(p.l),clean(p.d)&&'by '+ex(p.d)].filter(Boolean).join(' ')}${clean(p.s)?' · '+ex(p.s):''}</p>
${priceTxt(p)?`<p class="price">${esc(priceTxt(p))}</p>`:''}
${(p.hl||[]).filter(x=>clean(x)).length?`<div class="pills hl">${p.hl.filter(x=>clean(x)).map(x=>`<span>${ex(x)}</span>`).join('')}</div>`:''}
${imgs.length?`<div class="gal">${imgs.map((s,i)=>`<img src="${esc(s)}" alt="${ex(p.n)}${clean(p.l)?', '+ex(p.l):''} – photo ${i+1}" loading="${i?'lazy':'eager'}" decoding="async">`).join('')}</div>`:''}
<div class="cta">${wa?`<a class="wa" href="${esc(wa)}" rel="noopener">WhatsApp us about ${ex(p.n)}</a>`:''}${/^https?:/.test(p.brochure||'')?`<a class="alt" href="${esc(p.brochure)}" rel="noopener" target="_blank">📄 Download brochure (PDF)</a>`:''}<a class="alt" href="../../#p=${esc(p.id)}">Compare, loan check &amp; full details</a></div>
${clean(p.desc)?`<h2>About ${ex(p.n)}</h2><p>${ex(p.desc).replace(/\n+/g,'</p><p>')}</p>`:''}
<h2>Key facts</h2><div class="card"><dl>${facts.map(f=>`<dt>${f[0]}</dt><dd>${ex(f[1])}</dd>`).join('')}</dl></div>
${T.length?`<h2>Layouts &amp; prices</h2><div class="tw"><table><thead><tr><th>Type</th><th>Size (sqft)</th><th>Beds</th><th>Baths</th><th>Car parks</th><th>Price</th></tr></thead><tbody>${T.map(t=>`<tr><td>${ex(t.name)}</td><td>${ex(t.size)}</td><td>${ex(t.beds)}</td><td>${ex(t.baths)}</td><td>${ex(t.carparks)}</td><td>${ex(t.price)}</td></tr>`).join('')}</tbody></table></div>`:''}
${(p.towers||[]).filter(t=>t&&t.name).length?`<h2>Towers</h2><ul>${p.towers.filter(t=>t&&t.name).map(t=>`<li>${ex(t.name)}${clean(t.floors)?' – '+ex(t.floors)+' floors':''}${clean(t.units)?', '+ex(t.units)+' units':''}</li>`).join('')}</ul>`:''}
${(p.facilities||[]).filter(Boolean).length?`<h2>Facilities</h2><ul class="cols">${p.facilities.filter(Boolean).map(f=>`<li>${ex(f)}</li>`).join('')}</ul>`:''}
${(p.furnList||[]).filter(Boolean).length?`<h2>Furnishing</h2><ul class="cols">${p.furnList.filter(Boolean).map(f=>`<li>${ex(f)}</li>`).join('')}</ul>`:''}
${nearHtml?`<h2>What's nearby</h2>${nearHtml}`:''}
${concl?`<h2>Our take</h2><p>${ex(concl).replace(/\n+/g,'</p><p>')}</p>`:''}
${(p.videos||[]).filter(v=>v&&/^https?:/.test(v.url||'')).length?`<h2>Videos</h2><ul>${p.videos.filter(v=>v&&/^https?:/.test(v.url||'')).map(v=>`<li><a href="${esc(v.url)}" rel="noopener">${ex(v.title||v.cat||'Video')}</a></li>`).join('')}</ul>`:''}
${clean(p.mapUrl)&&/^https?:/.test(p.mapUrl)?`<p><a href="${esc(clean(p.mapUrl))}" rel="noopener">Open location in Google Maps</a></p>`:''}
</article>
${rel.length?`<h2>More properties${clean(p.l)?' near '+ex(p.l):''}</h2><ul class="rel">${rel.map(r=>`<li><a href="../${r.slug}/">${ex(r.n)}</a><small>${[ex(r.l),esc(priceTxt(r))].filter(Boolean).join(' · ')}</small></li>`).join('')}</ul>`:''}
</main><footer>© ${new Date().getFullYear()} One Stop Centre Property Lists · Prices and availability are indicative; please confirm with us. · <a href="../../">All properties</a></footer></body></html>`;
 }
 function related(p){const same=P.filter(x=>x!==p&&clean(x.l).toLowerCase()===clean(p.l).toLowerCase());const others=P.filter(x=>x!==p&&!same.includes(x)&&clean(x.d)===clean(p.d));return [...same,...others].slice(0,6)}

  return { clean, esc, priceTxt, pTitle, pDesc, siteDesc, dirHtml, listLd, propPage, related, cover };
}

async function sb(path) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, { headers: { apikey: SB_KEY, Accept: "application/json" } });
  if (!r.ok) throw new Error("db " + r.status);
  return r.json();
}
async function loadAll() {
  const [rows, st] = await Promise.all([
    sb("projects?select=id,data&published=eq.true"),
    sb("settings?select=data&id=eq.1"),
  ]);
  const S = (st && st[0] && st[0].data) || {};
  const ord = S.order || [], ix = {};
  ord.forEach((id, i) => { ix[id] = i; });
  rows.sort((a, b) => (a.id in ix ? ix[a.id] : 1e9) - (b.id in ix ? ix[b.id] : 1e9));
  const P = rows.map((r) => r.data).filter((p) => p && p.slug);
  return { P, S: { email: S.email || "", wa: S.wa || "", site: S.site || SITE, vo: S.vo, loan: S.loan } };
}
const H = (type, extra) => new Headers({ "content-type": type, "cache-control": "public, max-age=0, must-revalidate", "x-content-type-options": "nosniff", ...(extra || {}) });

function notFound() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Property not found | One Stop Centre</title><meta name="robots" content="noindex"><style>body{font-family:system-ui,-apple-system,sans-serif;background:#0c1f4a;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px}a{color:#fff;background:#c8102e;padding:12px 20px;border-radius:999px;text-decoration:none;display:inline-block;margin-top:12px}</style></head><body><main><h1>This property is no longer listed</h1><p>It may have been sold out or renamed.</p><a href="/">See all properties</a></main></body></html>`;
  return new Response(html, { status: 404, headers: H("text/html; charset=utf-8") });
}

export default async (request, context) => {
  const url = new URL(request.url);
  const path = url.pathname;
  const pm = path.match(/^\/property\/([^\/]+)\/?$/);
  const isHome = path === "/" || path === "/index.html";
  const isMap = path === "/sitemap.xml";
  if (!pm && !isHome && !isMap) return;

  let D;
  try { D = await loadAll(); } catch (e) { return; } // database unreachable: serve the normal files
  if (!D.P.length) return;
  const K = kit(D.P, D.S);

  if (isMap) {
    const t = new Date().toISOString().slice(0, 10);
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>' + SITE + "</loc><lastmod>" + t + "</lastmod></url>\n" +
      D.P.map((p) => "  <url><loc>" + K.esc(SITE + "property/" + p.slug + "/") + "</loc><lastmod>" + (/^\d{4}-\d\d-\d\d$/.test(p.mod || "") ? p.mod : t) + "</lastmod></url>").join("\n") + "\n</urlset>\n";
    return new Response(xml, { headers: H("application/xml; charset=utf-8") });
  }

  if (pm) {
    const slug = decodeURIComponent(pm[1]);
    const p = D.P.find((x) => x.slug === slug);
    if (!p) return notFound();
    if (!path.endsWith("/")) return Response.redirect(url.origin + path + "/", 301);
    const seen = new Set(), imgs = [];
    [...(p.gallery || []), p.img, ...(p.types || []).map((t) => t && t.img)].forEach((u) => {
      if (typeof u === "string" && /^https:\/\//.test(u) && !seen.has(u)) { seen.add(u); imgs.push(u); }
    });
    let html = K.propPage(p, SITE, imgs, K.related(p));
    const priceShort = K.priceTxt(p);
    const ogTitle = K.clean(p.n) + (K.clean(p.l) ? " – " + K.clean(p.l) : "") + (priceShort ? " | " + priceShort.replace(/^from /, "From ") : "");
    const ot = K.esc(ogTitle);
    html = html.replace(/(<meta property="og:title" content=")[^"]*(")/, (m, a, b) => a + ot + b)
               .replace(/(<meta name="twitter:title" content=")[^"]*(")/, (m, a, b) => a + ot + b);
    if (!/property="og:image"/.test(html)) {
      html = html.replace("</head>", () => `<meta property="og:image" content="${OG_DEFAULT}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:image" content="${OG_DEFAULT}"></head>`);
    }
    return new Response(html, { headers: H("text/html; charset=utf-8") });
  }

  // Homepage: inject the latest data, counts, A–Z links and structured data into the page itself
  const res = await context.next();
  if (res.status !== 200) return res;
  let html = await res.text();
  const data = JSON.stringify({ email: D.S.email, wa: D.S.wa, site: D.S.site, vo: D.S.vo, loan: D.S.loan, projects: D.P }).replace(/</g, "\\u003c");
  html = html.replace(/<script id="data" type="application\/json">[\s\S]*?<\/script>/, () => '<script id="data" type="application/json" data-fresh="1">' + data + "</script>");
  const devs = new Set(D.P.map((p) => p.d).filter(Boolean)).size, areas = new Set(D.P.map((p) => p.l)).size;
  html = html.replace(/<div class="stt" id="stats">[\s\S]*?<\/div><\/div>/, () => `<div class="stt" id="stats"><div><b data-n="${D.P.length}">${D.P.length}</b><span>Projects</span></div><div><b data-n="${devs}">${devs}</b><span>Developers</span></div><div><b data-n="${areas}">${areas}</b><span>Areas</span></div></div>`);
  const a = html.indexOf('id="alldir"');
  if (a > 0) {
    const s = html.indexOf(">", a) + 1, e = html.indexOf("</section>", s);
    if (s > 0 && e > s) html = html.slice(0, s) + K.dirHtml(true) + html.slice(e);
  }
  const desc = K.esc(K.siteDesc());
  html = html.replace(/(<meta name="description" content=")[^"]*(")/, (m, a, b) => a + desc + b)
             .replace(/(<meta property="og:description" content=")[^"]*(")/, (m, a, b) => a + desc + b)
             .replace(/(<meta name="twitter:description" content=")[^"]*(")/, (m, a, b) => a + desc + b)
             .replace(/(<script type="application\/ld\+json" id="seo-ld">)[\s\S]*?(<\/script>)/, (m, x, y) => x + K.listLd(SITE).replace(/</g, "\\u003c") + y);
  const headers = new Headers(res.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.delete("content-length");
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  return new Response(html, { status: 200, headers });
};

export const config = { path: ["/", "/index.html", "/property/*", "/sitemap.xml"] };
