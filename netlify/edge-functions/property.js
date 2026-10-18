// One Stop Centre – server-side pages (Netlify Edge Function)
// Builds the homepage data, every /property/... page and /sitemap.xml fresh from the database,
// so Google, WhatsApp and Facebook always see the latest titles, photos and prices.
const SB_URL = "https://deethrwnmyezwsohmhzl.supabase.co";
const SB_KEY = "sb_publishable_gaiT2UF6vtI42BbYH1egKg_T_yLT83g";
const SITE = "https://onestopcentreproperty.com/";
const OG_DEFAULT = SITE + "og-default.jpg?v=2", OG_MS = SITE + "og-default-ms.jpg?v=2";

function kit(P, S, LANG) {
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
 const priceTxt=p=>{const n=nums(p);if(!n.length)return clean(p.p)&&!/enquire/i.test(p.p)?clean(p.p):'';return (MS?'dari RM':'from RM')+Math.min(...n).toLocaleString('en-MY')};
 const cover=p=>(p.gallery&&p.gallery.find(Boolean))||p.img||'';
 const tc=v=>{v=clean(v);return v&&v===v.toUpperCase()&&/[A-Z]{3}/.test(v)?v.toLowerCase().replace(/(^|[\s\-\/])([a-z])/g,(m,a,b)=>a+b.toUpperCase()):v};
 const cut=(s,n)=>{s=String(s).replace(/\s+/g,' ').trim();if(s.length<=n)return s;s=s.slice(0,n-1);return s.slice(0,Math.max(s.lastIndexOf(' '),n-25)).replace(/[\s,;:·–-]+$/,'')+'…'};
 let MS=LANG==='ms',LP=MS?'ms/':'';
 const MSV={'Condominium':'Kondominium','Serviced Apartment':'Pangsapuri Servis','Apartment':'Pangsapuri','Terrace House':'Rumah Teres','Semi-D House':'Rumah Berkembar','Bungalow':'Banglo','Townhouse':'Rumah Bandar','Affordable Housing':'Rumah Mampu Milik','Residential Land':'Tanah Kediaman','Commercial Land':'Tanah Komersial','Agricultural Land':'Tanah Pertanian','Industrial Land':'Tanah Perindustrian','Shop / Shoplot':'Kedai / Lot Kedai','Office':'Pejabat','Retail Space':'Ruang Runcit','Factory / Warehouse':'Kilang / Gudang','Residential':'Kediaman','Land':'Tanah','Commercial':'Komersial','Industrial':'Perindustrian','New Launch':'Pelancaran Baharu','Under Construction':'Dalam Pembinaan','Upcoming':'Akan Datang','Completed':'Siap','Sold Out':'Habis Dijual','Freehold':'Pegangan Bebas','Leasehold':'Pajakan','Malay Reserve':'Rizab Melayu','Furnished':'Berperabot','Partially Furnished':'Separa Berperabot','Unfurnished':'Tanpa Perabot','Yes':'Ya','No':'Tidak','Swimming pool':'Kolam renang','Gymnasium':'Gimnasium','Playground':'Taman permainan','Multipurpose hall':'Dewan serbaguna','BBQ area':'Kawasan BBQ','Jogging track':'Trek joging','Co-working space':'Ruang kerja bersama','Tennis court':'Gelanggang tenis','Badminton court':'Gelanggang badminton','Function room':'Bilik fungsi','Kids pool':'Kolam kanak-kanak','Reading room':'Bilik bacaan','Yoga deck':'Dek yoga','Pet-friendly area':'Kawasan mesra haiwan','24-hour security':'Keselamatan 24 jam','Retail podium':'Podium runcit','EV charging':'Pengecasan EV','Air-conditioners':'Penghawa dingin','Wardrobe':'Almari pakaian','Kitchen cabinet':'Kabinet dapur','Hob & hood':'Hob & hud','Refrigerator':'Peti sejuk','Washing machine':'Mesin basuh','Water heater':'Pemanas air'};
 const tv=v=>{v=clean(v);return MS&&MSV[v]||v};
 const shareV=p=>{const g=(p.gallery&&p.gallery[0])||p.img||'';const t=String(p.mod||'')+'|'+g+'|'+(p.n||'')+'|'+(p.seoT||'')+'|'+(p.seoD||'');let h=0;for(let i=0;i<t.length;i++)h=(h*31+t.charCodeAt(i))|0;return (h>>>0).toString(36).slice(0,6)};
 function pTitle(p){const own=clean(p.seoT);if(own)return /one stop centre/i.test(own)||(own+' | One Stop Centre').length>65?own:own+' | One Stop Centre';const pr=priceTxt(p);let t=clean(p.n)+(clean(p.l)?', '+tc(p.l):'');const a=pr?(MS?' | Dari ':' | From ')+pr.replace(/^(from|dari)\s+/i,''):'';if((t+a).length<=60)t+=a;if((t+' | One Stop Centre').length<=65)t+=' | One Stop Centre';return t}
 function pDesc(p){
  const own=MS?'':clean(p.seoD).replace(/\s+/g,' ');if(own.length>=110)return cut(own,158);
  const bits=MS?[tv(p.t)||tv(p.c)||'Hartanah',clean(p.l)&&'di '+tc(p.l),clean(p.d)&&'oleh '+clean(p.d)].filter(Boolean).join(' '):[clean(p.t)||clean(p.c)||'Property',clean(p.l)&&'in '+tc(p.l),clean(p.d)&&'by '+clean(p.d)].filter(Boolean).join(' ');
  const more=[tv(p.s),clean(p.z),priceTxt(p),tv(p.tenure)].filter(Boolean).join(' · ');
  const hl=(p.hl||[]).map(clean).filter(Boolean).slice(0,3).join(', ');
  const auto=clean(p.n)+': '+bits+'. '+more+(hl?'. '+hl:'')+(MS?'. Bandingkan pelan, harga dan yuran penyelenggaraan.':'. Compare layouts, prices and maintenance fees.');
  return cut(own?own.replace(/[.\s]*$/,'.')+' '+auto:auto,158);
 }
 const siteDesc=()=>{const dv=new Set(P.map(p=>clean(p.d)).filter(Boolean)).size,ar=new Set(P.map(p=>clean(p.l)).filter(Boolean)).size,pl=(n,w)=>n+' '+w+(n===1?'':'s');return MS?`Bandingkan ${P.length} rumah baharu & siap di ${ar} kawasan sekitar Lembah Klang daripada ${dv} pemaju. Lihat pelan, saiz, harga dan yuran penyelenggaraan.`:`Compare ${pl(P.length,'new launch & ready home')} in ${pl(ar,'area')} across Klang Valley from ${pl(dv,'developer')}. See layouts, sizes, prices and maintenance fees.`};
 /* Visible "All properties" directory: plain links every crawler can follow */
 function dirHtml(pack){
  const list=[...P].sort((a,b)=>clean(a.n).localeCompare(clean(b.n)));
  return `<h2>${MS?'Semua hartanah':'All properties'}</h2><p class="sub">${MS?'Semua projek di One Stop Centre, A hingga Z.':'Every project on One Stop Centre, A to Z.'}</p><ul class="seodir">`+list.map(p=>`<li><a href="${pack?'/'+LP+'property/'+p.slug+'/':'#p='+esc(p.id)}" data-pid="${esc(p.id)}">${ex(p.n)}</a><span>${[ex(p.l),esc(tv(p.t)||tv(p.c)),esc(priceTxt(p))].filter(Boolean).join(' · ')}</span></li>`).join('')+`</ul>`;
 }
 function listLd(base){
  const g=[...(base?[{"@type":"WebSite","@id":base+'#website',"name":"One Stop Centre Property Lists","alternateName":"One Stop Centre","url":base+LP,"inLanguage":MS?"ms-MY":"en-MY"}]:[]),{"@type":"RealEstateAgent",...(base?{"@id":base+'#agent',"logo":base+'icon-512.png',"image":base+'og-default.jpg'}:{}),"name":"One Stop Centre Property Lists","description":siteDesc(),...(base?{"url":base}:{}),...(S.email?{"email":S.email}:{}),...(S.wa?{"telephone":'+'+S.wa.replace(/\D/g,'')}:{}),"areaServed":"Klang Valley, Malaysia"},
   {"@type":"ItemList","name":"Property listings","numberOfItems":P.length,"itemListElement":P.map((p,i)=>({"@type":"ListItem","position":i+1,"name":clean(p.n),...(base?{"url":base+LP+'property/'+p.slug+'/'}:{})}))}];
  return JSON.stringify({"@context":"https://schema.org","@graph":g}).replace(/</g,'\\u003c');
 }

 function pageCss(){return `:root{--ink:#0f1b33;--mute:#5b6784;--acc:#c8102e;--navy:#0c1f4a;--line:#dfe4ee;--bg:#f1f4fa}*{box-sizing:border-box}body{margin:0;font-family:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6}a{color:var(--acc)}header.top{background:linear-gradient(180deg,#060f26,#0c1f4a);color:#fff;padding:14px 5%;display:flex;justify-content:space-between;align-items:center;gap:12px}header.top a{color:#fff;text-decoration:none;font-weight:700}.wrap{max-width:980px;margin:0 auto;padding:22px 5% 60px}nav.bc{font-size:.85rem;color:var(--mute);margin-bottom:10px}nav.bc a{color:var(--mute)}h1{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:clamp(1.8rem,5vw,2.6rem);line-height:1.15;margin:.2em 0}h2{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:1.35rem;margin:1.8em 0 .5em}.lead{color:var(--mute);margin:0 0 14px}.pills{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.pills span{background:#fff;border:1px solid var(--line);border-radius:30px;padding:5px 12px;font-size:.85rem}.hl span{background:#fdecef;border-color:#f6c6ce;color:var(--acc);font-weight:600}.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:16px 0}.gal img:first-child{grid-column:1/-1;aspect-ratio:16/9}.gal img{width:100%;max-width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;display:block;background:#dde3ef}.price{font-size:1.5rem;font-weight:700;color:var(--navy)}.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px}.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:520px;background:#fff;border-radius:12px;overflow:hidden}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);font-size:.92rem}th{background:#f6f8fc}dl{display:grid;grid-template-columns:minmax(120px,max-content) 1fr;gap:6px 16px;margin:0}dt{color:var(--mute)}dd{margin:0;font-weight:600}ul.cols{columns:2 220px;padding-left:1.1em}.cta{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0}.cta a{display:inline-block;padding:12px 20px;border-radius:30px;font-weight:700;text-decoration:none}.wa{background:#1fae5b;color:#fff}.alt{background:#fff;border:1px solid var(--line);color:var(--ink)}.lay img{max-width:100%;border-radius:10px}footer{text-align:center;color:var(--mute);font-size:.85rem;padding:30px 5%;border-top:1px solid var(--line)}.rel{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;padding:0;list-style:none}.rel li{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px}.rel small{display:block;color:var(--mute)}`}
 function autoAbout(p){if(MS)return autoAboutMS(p);const n=clean(p.n),ty=(clean(p.t)||clean(p.c)||'residential development').toLowerCase(),art=/^[aeiou]/.test(ty)?'an':'a',out=[];
  out.push(n+' is '+art+' '+ty+' '+(clean(p.l)?'in '+tc(p.l)+', Klang Valley':'in the Klang Valley')+(clean(p.d)?', developed by '+clean(p.d):'')+'.');
  const st=clean(p.s).toLowerCase(),yr=clean(p.year);const sp=/new launch/.test(st)?'a new launch':/under construction/.test(st)?'currently under construction':/upcoming/.test(st)?'an upcoming project':/complete|ready/.test(st)?'completed and ready to move in':st?'currently '+st:'';
  if(sp)out.push('It is '+sp+(yr&&!/complete|ready/.test(st)?', with expected completion in '+yr:'')+'.');else if(yr)out.push('Expected completion is '+yr+'.');
  const pr=priceTxt(p);if(pr)out.push('Prices start '+pr.replace(/^from/i,'from')+(clean(p.tenure)?' and the tenure is '+clean(p.tenure).toLowerCase():'')+'.');else if(clean(p.tenure))out.push('The tenure is '+clean(p.tenure).toLowerCase()+'.');
  const T=(p.types||[]).filter(t=>t&&t.name);if(T.length)out.push('There '+(T.length>1?'are '+T.length+' layout types':'is 1 layout type')+' to choose from'+(clean(p.z)?', with built-up sizes of '+clean(p.z)+' sqft':'')+'.');
  out.push('Contact One Stop Centre on WhatsApp for the latest availability, floor plans and offers.');return out.join(' ')}
 function autoAboutMS(p){const n=clean(p.n),low=w=>/^[A-Z][a-z]/.test(w)?w.toLowerCase():w,ty=(tv(p.t)||tv(p.c)||'projek kediaman').split(' ').map(low).join(' '),out=[];
  out.push(n+' ialah '+ty+' '+(clean(p.l)?'di '+tc(p.l)+', Lembah Klang':'di Lembah Klang')+(clean(p.d)?', dibangunkan oleh '+clean(p.d):'')+'.');
  const st=clean(p.s).toLowerCase(),yr=clean(p.year);const sp=/new launch/.test(st)?'Projek ini baru dilancarkan':/under construction/.test(st)?'Projek ini sedang dalam pembinaan':/upcoming/.test(st)?'Ini ialah projek akan datang':/complete|ready/.test(st)?'Projek ini telah siap dan sedia untuk diduduki':'';
  if(sp)out.push(sp+(yr&&!/complete|ready/.test(st)?', dengan jangkaan siap pada tahun '+yr:'')+'.');else if(yr)out.push('Jangkaan siap pada tahun '+yr+'.');
  const pr=priceTxt(p);if(pr)out.push('Harga bermula '+pr.replace(/^dari/i,'dari')+(clean(p.tenure)?' dan pegangannya ialah '+tv(p.tenure).toLowerCase():'')+'.');else if(clean(p.tenure))out.push('Pegangannya ialah '+tv(p.tenure).toLowerCase()+'.');
  const T=(p.types||[]).filter(t=>t&&t.name);if(T.length)out.push('Terdapat '+T.length+' jenis pelan untuk dipilih'+(clean(p.z)?', dengan saiz binaan '+clean(p.z)+' kaki persegi':'')+'.');
  out.push('Hubungi One Stop Centre melalui WhatsApp untuk ketersediaan unit, pelan lantai dan tawaran terkini.');return out.join(' ')}
 function propPage(p,base,imgs,rel){
  const T_=(en,ms)=>MS?ms:en;
  const enU=base+'property/'+p.slug+'/',msU=base+'ms/property/'+p.slug+'/',url=MS?msU:enU,home=base+LP,title=pTitle(p),desc=pDesc(p);
  const absImg=imgs.map(i=>/^https?:/.test(i)?i:url+i),ogImg=absImg[0]?absImg[0]+(absImg[0].includes('?')?'&':'?')+'v='+shareV(p):'';
  const n=nums(p),wa=S.wa?'https://wa.me/'+S.wa.replace(/\D/g,'')+'?text='+encodeURIComponent(T_('Hi, I am interested in ','Hai, saya berminat dengan ')+clean(p.n)+' ('+url+')'):'';
  const facts=[[T_('Location','Lokasi'),p.l],[T_('Developer','Pemaju'),p.d],[T_('Category','Kategori'),tv(p.c)],[T_('Property type','Jenis hartanah'),tv(p.t)],[T_('Status','Status'),tv(p.s)],[T_('Price','Harga'),priceTxt(p)||p.p],[T_('Built-up size','Saiz binaan'),p.z],[T_('Bedrooms','Bilik tidur'),p.b&&(p.b+T_(' max',' maks'))],[T_('Tenure','Pegangan'),[tv(p.tenure),clean(p.lease)&&clean(p.lease)+T_(' years',' tahun')].filter(Boolean).join(', ')],[T_('Completion','Jangkaan siap'),p.year],[T_('Storeys','Tingkat'),p.height],[T_('Furnishing','Perabot'),tv(clean(p.furn)==='Yes'?'Furnished':clean(p.furn)==='No'?'Unfurnished':p.furn)],[T_('Maintenance fee','Yuran penyelenggaraan'),clean(p.maintPsf)&&'RM'+clean(p.maintPsf)+' psf'],[T_('Address','Alamat'),p.address]].filter(f=>clean(f[1]));
  const T=(p.types||[]).filter(t=>t&&(t.name||t.size||t.price));
  const near=p.near||{},nl=(k,lab)=>(near[k]||[]).filter(x=>x&&x.n).length?`<h3>${lab}</h3><ul class="cols">${near[k].filter(x=>x&&x.n).map(x=>`<li>${ex(x.n)}${clean(x.d)?' ('+ex(x.d)+')':''}${clean(x.st)?' – '+ex(x.st):''}${clean(x.y)?', '+ex(x.y):''}</li>`).join('')}</ul>`:'';
  const nearHtml=nl('transit',T_('Transit','Pengangkutan awam'))+nl('schools',T_('Schools','Sekolah'))+nl('uni',T_('Universities','Universiti'))+nl('amen',T_('Shopping & amenities','Membeli-belah & kemudahan'))+nl('future',T_('Future developments','Pembangunan masa depan'));
  const concl=p.concl&&clean(p.concl.text);
  const ld={"@context":"https://schema.org","@graph":[
   {"@type":"RealEstateListing","@id":url+'#listing',"url":url,"name":clean(p.n),"description":desc,"inLanguage":T_('en-MY','ms-MY'),...(absImg.length?{"image":absImg}:{}),...(p.mod?{"dateModified":p.mod}:{}),
    ...(n.length?{"offers":{"@type":"AggregateOffer","priceCurrency":"MYR","lowPrice":Math.min(...n),"highPrice":Math.max(...n),"offerCount":Math.max(1,T.length),"availability":"https://schema.org/InStock","url":url}}:{}),
    "about":{"@type":/landed|link|terrace|semi|bungalow|storey|town/i.test(p.t)?"SingleFamilyResidence":"ApartmentComplex","name":clean(p.n),"address":{"@type":"PostalAddress",...(clean(p.address)?{"streetAddress":clean(p.address)}:{}),"addressLocality":clean(p.l),"addressRegion":"Klang Valley","addressCountry":"MY"},...(+p.b?{"numberOfBedrooms":+p.b}:{}),...((p.facilities||[]).length?{"amenityFeature":p.facilities.filter(Boolean).map(f=>({"@type":"LocationFeatureSpecification","name":clean(f),"value":true}))}:{}),...(clean(p.mapUrl)?{"hasMap":clean(p.mapUrl)}:{})},
    ...(clean(p.d)?{"provider":{"@type":"Organization","name":clean(p.d)}}:{})},
   {"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":T_('All properties','Semua hartanah'),"item":home},{"@type":"ListItem","position":2,"name":clean(p.n),"item":url}]}]};
  return `<!DOCTYPE html>
<html lang="${T_('en-MY','ms-MY')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><meta name="robots" content="index, follow, max-image-preview:large"><link rel="canonical" href="${esc(url)}"><link rel="alternate" hreflang="en-MY" href="${esc(enU)}"><link rel="alternate" hreflang="ms-MY" href="${esc(msU)}"><link rel="alternate" hreflang="x-default" href="${esc(enU)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="One Stop Centre Property Lists"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}"><meta property="og:locale" content="${T_('en_MY','ms_MY')}"><meta property="og:locale:alternate" content="${T_('ms_MY','en_MY')}">${absImg[0]?`<meta property="og:image" content="${esc(ogImg)}"><meta property="og:image:alt" content="${esc(clean(p.n))}${clean(p.l)?', '+esc(tc(p.l)):''}"><meta name="twitter:card" content="summary_large_image">`:''}<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#0a1a3a"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600&family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g,'\\u003c')}<\/script><style>${pageCss()}.lng{font-size:.8rem;opacity:.85}</style></head>
<body><header class="top"><a href="/${LP}">◆ One Stop Centre</a><span><a class="lng" href="${esc(MS?enU:msU)}" hreflang="${T_('ms','en')}" lang="${T_('ms','en')}">${T_('Bahasa Melayu','English')}</a>${wa?` &nbsp; <a href="${esc(wa)}" rel="noopener">${T_('Enquire','Tanya')}</a>`:''}</span></header>
<main class="wrap"><nav class="bc" aria-label="Breadcrumb"><a href="/${LP}">${T_('All properties','Semua hartanah')}</a>${clean(p.l)?' › '+ex(p.l):''} › ${ex(p.n)}</nav>
<article><h1>${ex(p.n)}</h1><p class="lead">${MS?[esc(tv(p.t)||tv(p.c)),clean(p.l)&&'di '+ex(p.l),clean(p.d)&&'oleh '+ex(p.d)].filter(Boolean).join(' '):[ex(p.t||p.c),clean(p.l)&&'in '+ex(p.l),clean(p.d)&&'by '+ex(p.d)].filter(Boolean).join(' ')}${clean(p.s)?' · '+esc(tv(p.s)):''}</p>
${priceTxt(p)?`<p class="price">${esc(priceTxt(p))}</p>`:''}
${(p.hl||[]).filter(x=>clean(x)).length?`<div class="pills hl">${p.hl.filter(x=>clean(x)).map(x=>`<span>${ex(x)}</span>`).join('')}</div>`:''}
${imgs.length?`<div class="gal">${imgs.map((s,i)=>`<img src="${esc(s)}" alt="${ex(p.n)}${clean(p.l)?', '+ex(p.l):''} – ${T_('photo','gambar')} ${i+1}" loading="${i?'lazy':'eager'}" decoding="async">`).join('')}</div>`:''}
<div class="cta">${wa?`<a class="wa" href="${esc(wa)}" rel="noopener">${T_('WhatsApp us about ','WhatsApp kami tentang ')}${ex(p.n)}</a>`:''}${/^https?:/.test(p.brochure||'')?`<a class="alt" href="${esc(p.brochure)}" rel="noopener" target="_blank">📄 ${T_('Download brochure (PDF)','Muat turun brosur (PDF)')}</a>`:''}<a class="alt" href="/${LP}#p=${esc(p.id)}">${T_('Compare, loan check &amp; full details','Bandingkan, semak pinjaman &amp; butiran penuh')}</a></div>
<h2>${T_('About','Tentang')} ${ex(p.n)}</h2>${clean(p.desc)?`<p>${ex(p.desc).replace(/\n+/g,'</p><p>')}</p>`:''}${!clean(p.desc)||MS?`<p>${esc(autoAbout(p))}</p>`:''}
<h2>${T_('Key facts','Fakta utama')}</h2><div class="card"><dl>${facts.map(f=>`<dt>${f[0]}</dt><dd>${ex(f[1])}</dd>`).join('')}</dl></div>
${T.length?`<h2>${T_('Layouts &amp; prices','Pelan &amp; harga')}</h2><div class="tw"><table><thead><tr><th>${T_('Type','Jenis')}</th><th>${T_('Size (sqft)','Saiz (kps)')}</th><th>${T_('Beds','Bilik')}</th><th>${T_('Baths','Bilik air')}</th><th>${T_('Car parks','Parkir')}</th><th>${T_('Price','Harga')}</th></tr></thead><tbody>${T.map(t=>`<tr><td>${ex(t.name)}</td><td>${ex(t.size)}</td><td>${ex(t.beds)}</td><td>${ex(t.baths)}</td><td>${ex(t.carparks)}</td><td>${ex(t.price)}</td></tr>`).join('')}</tbody></table></div>`:''}
${(p.towers||[]).filter(t=>t&&t.name).length?`<h2>${T_('Towers','Menara')}</h2><ul>${p.towers.filter(t=>t&&t.name).map(t=>`<li>${ex(t.name)}${clean(t.floors)?' – '+ex(t.floors)+T_(' floors',' tingkat'):''}${clean(t.units)?', '+ex(t.units)+T_(' units',' unit'):''}</li>`).join('')}</ul>`:''}
${(p.facilities||[]).filter(Boolean).length?`<h2>${T_('Facilities','Kemudahan')}</h2><ul class="cols">${p.facilities.filter(Boolean).map(f=>`<li>${esc(tv(f))}</li>`).join('')}</ul>`:''}
${(p.furnList||[]).filter(Boolean).length?`<h2>${T_('Furnishing','Perabot')}</h2><ul class="cols">${p.furnList.filter(Boolean).map(f=>`<li>${esc(tv(f))}</li>`).join('')}</ul>`:''}
${nearHtml?`<h2>${T_("What's nearby",'Kawasan sekitar')}</h2>${nearHtml}`:''}
${concl?`<h2>${T_('Our take','Pendapat kami')}</h2><p>${ex(concl).replace(/\n+/g,'</p><p>')}</p>`:''}
${(p.videos||[]).filter(v=>v&&/^https?:/.test(v.url||'')).length?`<h2>${T_('Videos','Video')}</h2><ul>${p.videos.filter(v=>v&&/^https?:/.test(v.url||'')).map(v=>`<li><a href="${esc(v.url)}" rel="noopener">${ex(v.title||v.cat||'Video')}</a></li>`).join('')}</ul>`:''}
${clean(p.mapUrl)&&/^https?:/.test(p.mapUrl)?`<p><a href="${esc(clean(p.mapUrl))}" rel="noopener">${T_('Open location in Google Maps','Buka lokasi di Google Maps')}</a></p>`:''}
</article>
${rel.length?`<h2>${T_('More properties in Klang Valley','Lagi hartanah di Lembah Klang')}</h2><ul class="rel">${rel.map(r=>`<li><a href="/${LP}property/${r.slug}/">${ex(r.n)}</a><small>${[ex(r.l),esc(priceTxt(r))].filter(Boolean).join(' · ')}</small></li>`).join('')}</ul>`:''}
</main><footer>© ${new Date().getFullYear()} One Stop Centre Property Lists · ${T_('Prices and availability are indicative; please confirm with us.','Harga dan ketersediaan adalah anggaran; sila sahkan dengan kami.')} · <a href="/${LP}">${T_('All properties','Semua hartanah')}</a></footer></body></html>`;
 }
 function related(p){const same=P.filter(x=>x!==p&&clean(x.l).toLowerCase()===clean(p.l).toLowerCase());const others=P.filter(x=>x!==p&&!same.includes(x)&&clean(x.d)===clean(p.d));return [...same,...others].slice(0,6)}

  return { clean, esc, priceTxt, pTitle, pDesc, siteDesc, dirHtml, listLd, propPage, related, cover };
}

async function sb(path) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, { headers: { apikey: SB_KEY, Accept: "application/json" } });
  if (!r.ok) throw new Error("db " + r.status);
  return r.json();
}
function normAreas(L){if(!Array.isArray(L))return;const tcw=w=>(w.length<=2||!/[AEIOU]/.test(w))?w:w.charAt(0)+w.slice(1).toLowerCase();const tc=v=>v.split(/(\s+|-|\/|\()/).map(w=>/^[A-Z0-9]+$/.test(w)?tcw(w):w).join('');const key=v=>v.replace(/\s+/g,' ').trim().toLowerCase();const pick={};
 L.forEach(p=>{if(!p||typeof p.l!=='string')return;const v=p.l.replace(/\s+/g,' ').trim(),k=v.toLowerCase();if(!k)return;const mixed=v!==v.toUpperCase();if(!pick[k]||(mixed&&pick[k]===pick[k].toUpperCase()))pick[k]=v});
 L.forEach(p=>{if(!p||typeof p.l!=='string')return;const k=key(p.l);if(!k)return;let v=pick[k];if(v===v.toUpperCase())v=tc(v);p.l=v})}
/* Property types: one list for the search filter, the editor and every page */
const PT_GROUPS=[['Residential',['Condominium','Serviced Apartment','Apartment','Terrace House','Semi-D House','Bungalow','Townhouse','SOHO / SOFO / SOVO','Affordable Housing']],['Land',['Residential Land','Commercial Land','Agricultural Land','Industrial Land']],['Commercial',['Shop / Shoplot','Office','Retail Space']],['Industrial',['Factory / Warehouse']]];
const PT_ALL=PT_GROUPS.flatMap(g=>g[1]);
const ptGroup=t=>(PT_GROUPS.find(g=>g[1].includes(t))||[''])[0];
function ptype(p){const t=String(p.t||'').trim(),c=String(p.c||'').trim();if(PT_ALL.includes(t))return t;if(PT_ALL.includes(c))return c;const x=(t+' '+c).toLowerCase();
 const A=[[/serviced|service residence|service suite/,'Serviced Apartment'],[/soho|sofo|sovo/,'SOHO / SOFO / SOVO'],[/affordable|mampu|pr1ma|rumawip|residensi wilayah|rumah selangorku/,'Affordable Housing'],[/semi[- ]?d/,'Semi-D House'],[/bungalow/,'Bungalow'],[/town ?house/,'Townhouse'],[/terrace|link house/,'Terrace House'],[/condo|highrise|high-rise|high rise/,'Condominium'],[/apartment|flat/,'Apartment'],[/agricultur/,'Agricultural Land'],[/industrial land/,'Industrial Land'],[/commercial land/,'Commercial Land'],[/residential land|\bland\b/,'Residential Land'],[/factory|warehouse/,'Factory / Warehouse'],[/shop/,'Shop / Shoplot'],[/office/,'Office'],[/retail|mall/,'Retail Space']];
 for(const [r,v] of A)if(r.test(x))return v;return ''}
function normTypes(L){const fixed=[];if(!Array.isArray(L))return fixed;L.forEach(p=>{if(!p)return;const nt=ptype(p);if(nt&&(p.t!==nt||p.c!==ptGroup(nt))){p.t=nt;p.c=ptGroup(nt);fixed.push(String(p.id))}});return fixed}
function typeMatch(p,v){if(!v)return true;if(v.startsWith('g:'))return ptGroup(p.t)===v.slice(2)||p.c===v.slice(2);return p.t===v}

// search engines and link-preview robots (WhatsApp, Facebook, Telegram…) get the fast, text-first project page
const BOTS = /bot|crawl|spider|slurp|facebookexternalhit|facebot|whatsapp|telegram|twitter|linkedin|discord|slack|skype|pinterest|embedly|quora|vkshare|google|bing|yandex|baidu|duckduck|applebot|petal|semrush|ahrefs|lighthouse|headless|preview|validator|curl|wget|python|node-fetch|axios/i;
const isBot = (req) => { const ua = req.headers.get("user-agent") || ""; return !ua || BOTS.test(ua); };
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
  normTypes(P); // one property-type list (Condominium, Serviced Apartment, ...)
  normAreas(P); // one spelling per area, e.g. "WANGSA MAJU" and "Wangsa Maju" become "Wangsa Maju"
  return { P, S: { email: S.email || "", wa: S.wa || "", site: S.site || SITE, vo: S.vo, loan: S.loan } };
}
// Browsers always re-check; Netlify's CDN keeps a copy for 60 s and serves it instantly while refreshing in the background,
// so pages (and EN/BM switching) load fast and the database is asked far less often. Edits show within about a minute.
const CDN = "public, durable, max-age=60, stale-while-revalidate=86400";
const H = (type, extra) => new Headers({ "content-type": type, "cache-control": "public, max-age=0, must-revalidate", "netlify-cdn-cache-control": CDN, "x-content-type-options": "nosniff", ...(extra || {}) });

function notFound() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Property not found | One Stop Centre</title><meta name="robots" content="noindex"><style>body{font-family:system-ui,-apple-system,sans-serif;background:#0c1f4a;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px}a{color:#fff;background:#c8102e;padding:12px 20px;border-radius:999px;text-decoration:none;display:inline-block;margin-top:12px}</style></head><body><main><h1>This property is no longer listed</h1><p>It may have been sold out or renamed.</p><a href="/">See all properties</a></main></body></html>`;
  return new Response(html, { status: 404, headers: H("text/html; charset=utf-8", { "netlify-cdn-cache-control": "public, max-age=30" }) });
}

export default async (request, context) => {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/ms") return Response.redirect(url.origin + "/ms/" + url.search, 301);
  const ms = /^\/ms\//.test(path), lang = ms ? "ms" : "en", rest = ms ? path.slice(3) : path; // Bahasa Melayu lives under /ms/
  const pm = rest.match(/^\/property\/([^\/]+)\/?$/);
  if (path === "/index.html" || path === "/property.html") return Response.redirect(url.origin + "/", 301); // one address per page
  if (path === "/admin" || path === "/admin/") {
    // short, easy-to-remember login address: hands over to the dashboard on the homepage, never indexed
    const hop = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Admin | One Stop Centre</title><meta http-equiv="refresh" content="0;url=/#admin"><script>location.replace("/#admin")</script></head><body><a href="/#admin">Open admin</a></body></html>';
    return new Response(hop, { status: 200, headers: H("text/html; charset=utf-8", { "x-robots-tag": "noindex, nofollow", "cache-control": "no-store", "netlify-cdn-cache-control": "no-store" }) });
  }
  const isHome = rest === "/";
  let PROP = null;
  const isMap = path === "/sitemap.xml";
  if (ms && rest === "/sitemap.xml") return Response.redirect(url.origin + "/sitemap.xml", 301);
  if (!pm && !isHome && !isMap) return;

  let D;
  try { D = await loadAll(); } catch (e) { return; } // database unreachable: serve the normal files
  if (!D.P.length) return;
  const K = kit(D.P, D.S, lang);

  if (isMap) {
    // lastmod only when we truly know the date a listing last changed (set on every save)
    const ok = (d) => /^\d{4}-\d\d-\d\d$/.test(d || "");
    const lm = (d) => (ok(d) ? "<lastmod>" + d + "</lastmod>" : "");
    const newest = D.P.map((p) => p.mod).filter(ok).sort().pop();
    // every published property gets its own entry, with up to 10 of its photos for Google Images
    const imgsOf = (p) => { const seen = new Set(), o = []; [...(p.gallery || []), p.img, ...(p.types || []).map((t) => t && t.img)].forEach((u) => { if (typeof u === "string" && /^https:\/\//.test(u) && !seen.has(u)) { seen.add(u); o.push(u); } }); return o.slice(0, 10); };
    const xe = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // each page is listed in English and Bahasa Melayu, and each version names the other (hreflang)
    const alt = (en, bm) => '<xhtml:link rel="alternate" hreflang="en-MY" href="' + xe(en) + '"/><xhtml:link rel="alternate" hreflang="ms-MY" href="' + xe(bm) + '"/><xhtml:link rel="alternate" hreflang="x-default" href="' + xe(en) + '"/>';
    const pair = (en, bm, extra) => "  <url><loc>" + xe(en) + "</loc>" + alt(en, bm) + extra + "</url>\n  <url><loc>" + xe(bm) + "</loc>" + alt(en, bm) + extra + "</url>";
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n' +
      pair(SITE, SITE + "ms/", lm(newest)) + "\n" +
      D.P.map((p) => pair(SITE + "property/" + p.slug + "/", SITE + "ms/property/" + p.slug + "/", lm(p.mod) + imgsOf(p).map((u) => "<image:image><image:loc>" + xe(u) + "</image:loc></image:image>").join(""))).join("\n") + "\n</urlset>\n";
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
    if (!/property="og:image"/.test(html)) {
      html = html.replace("</head>", () => `<meta property="og:image" content="${OG_DEFAULT}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:image" content="${OG_DEFAULT}"><meta name="twitter:card" content="summary_large_image"></head>`);
    }
    // the copy for people and the copy for crawlers differ, so the CDN must not mix them up
    if (isBot(request)) return new Response(html, { headers: H("text/html; charset=utf-8", { "netlify-cdn-cache-control": "no-store", "vary": "User-Agent" }) });
    PROP = { p, html };
  }

  // Homepage (and, for people, project pages): inject the latest data, counts, A–Z links and structured data
  const res = await context.next();
  if (res.status !== 200) return res;
  let html = await res.text();
  if (pm && PROP) {
    // people get the full website with this project open; head tags (title, preview, Google data) are the project's own
    const TAGS = /<title>[\s\S]*?<\/title>|<meta name="description"[^>]*>|<meta name="robots"[^>]*>|<link rel="canonical"[^>]*>|<link rel="alternate"[^>]*>|<meta property="og:[^"]*"[^>]*>|<meta name="twitter:[^"]*"[^>]*>|<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g;
    const ph = PROP.html, pHead = ph.slice(0, ph.indexOf("</head>")), keep = (pHead.match(TAGS) || []).join("");
    const he = html.indexOf("</head>");
    html = html.slice(0, he).replace(TAGS, "") + keep + html.slice(he);
    const lang = (ph.match(/<html lang="([^"]+)"/) || [])[1] || "en-MY";
    html = html.replace(/<html lang="[^"]*"/, '<html lang="' + lang + '"' + (ms ? ' data-lang="ms"' : ""));
  }
  const data = JSON.stringify({ email: D.S.email, wa: D.S.wa, site: D.S.site, vo: D.S.vo, loan: D.S.loan, projects: D.P }).replace(/</g, "\\u003c");
  html = html.replace(/<script id="data" type="application\/json">[\s\S]*?<\/script>/, () => '<script id="data" type="application/json" data-fresh="1">' + data + "</script>");
  const devs = new Set(D.P.map((p) => p.d).filter(Boolean)).size, areas = new Set(D.P.map((p) => p.l)).size;
  const LB = ms ? ["Projek", "Pemaju", "Kawasan"] : ["Projects", "Developers", "Areas"];
  html = html.replace(/<div class="stt" id="stats">[\s\S]*?<\/div><\/div>/, () => `<div class="stt" id="stats"><div><b data-n="${D.P.length}">${D.P.length}</b><span>${LB[0]}</span></div><div><b data-n="${devs}">${devs}</b><span>${LB[1]}</span></div><div><b data-n="${areas}">${areas}</b><span>${LB[2]}</span></div></div>`);
  const a = html.indexOf('id="alldir"');
  if (a > 0) {
    const s = html.indexOf(">", a) + 1, e = html.indexOf("</section>", s);
    if (s > 0 && e > s) html = html.slice(0, s) + K.dirHtml(true) + html.slice(e);
  }
  const desc = K.esc(K.siteDesc());
  if (!PROP) html = html.replace(/(<meta name="description" content=")[^"]*(")/, (m, a, b) => a + desc + b)
             .replace(/(<meta property="og:description" content=")[^"]*(")/, (m, a, b) => a + desc + b)
             .replace(/(<meta name="twitter:description" content=")[^"]*(")/, (m, a, b) => a + desc + b)
             .replace(/(<script type="application\/ld\+json" id="seo-ld">)[\s\S]*?(<\/script>)/, (m, x, y) => x + K.listLd(SITE).replace(/</g, "\\u003c") + y);
  const ALT = `<link rel="alternate" hreflang="en-MY" href="${SITE}"><link rel="alternate" hreflang="ms-MY" href="${SITE}ms/"><link rel="alternate" hreflang="x-default" href="${SITE}">`;
  if (ms && !PROP) {
    const t = "Rumah Baharu &amp; Siap di Lembah Klang | One Stop Centre";
    html = html.replace(/<html lang="[^"]*"/, '<html lang="ms-MY" data-lang="ms"')
               .replace(/<title>[^<]*<\/title>/, "<title>" + t + "</title>")
               .replace(/(<meta property="og:title" content=")[^"]*(")/, (m, a, b) => a + t + b)
               .replace(/(<meta name="twitter:title" content=")[^"]*(")/, (m, a, b) => a + t + b)
               .replace(/(<link rel="canonical" href=")[^"]*(")/, (m, a, b) => a + SITE + "ms/" + b)
               .replace(/(<meta property="og:url" content=")[^"]*(")/, (m, a, b) => a + SITE + "ms/" + b)
               .replace(/(<meta property="og:locale" content=")[^"]*(")/, (m, a, b) => a + "ms_MY" + b)
               .replace(/(<meta property="og:image" content=")[^"]*(")/, (m, a, b) => a + OG_MS + b)
               .replace(/(<meta name="twitter:image" content=")[^"]*(")/, (m, a, b) => a + OG_MS + b)
               .replace(/<span class="eyebrow">Klang Valley · New launches &amp; ready homes<\/span><span class="h1t">Find the home that fits <em>your life\.<\/em><\/span>/, '<span class="eyebrow">Lembah Klang · Projek baharu &amp; rumah siap</span><span class="h1t">Cari rumah yang sesuai dengan <em>gaya hidup anda.</em></span>');
  }
  if (!PROP) html = html.replace("</head>", () => ALT + "</head>");
  const headers = new Headers(res.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.delete("content-length");
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  headers.set("netlify-cdn-cache-control", PROP ? "no-store" : CDN);
  if (PROP) headers.set("vary", "User-Agent");
  return new Response(html, { status: 200, headers });
};

export const config = { cache: "manual", path: ["/", "/index.html", "/property.html", "/admin", "/admin/", "/property/*", "/sitemap.xml", "/ms", "/ms/", "/ms/property/*"] };
