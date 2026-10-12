// Adds each property's title, description and poster image to /property/... pages,
// so WhatsApp, Facebook and Google see them without running JavaScript.
const SB_URL = "https://deethrwnmyezwsohmhzl.supabase.co";
const SB_KEY = "sb_publishable_gaiT2UF6vtI42BbYH1egKg_T_yLT83g";
const SITE = "https://onestopcentreproperty.com/";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clean = (v) => { v = String(v ?? "").trim(); return /^(none|null|undefined)$/i.test(v) ? "" : v.replace(/\s+/g, " "); };
const num = (v) => { const m = String(v ?? "").replace(/,/g, "").match(/\d+(\.\d+)?/); return m ? parseFloat(m[0]) : 0; };

function priceText(p) {
  const n = [...(p.types || []), ...(p.layouts || [])].map((u) => num(u && u.price)).filter((x) => x >= 10000);
  if (n.length) return "from RM" + Math.min(...n).toLocaleString("en-MY");
  return clean(p.p) && !/enquire/i.test(p.p) ? clean(p.p) : "";
}
function describe(p) {
  if (clean(p.seoD)) return clean(p.seoD).slice(0, 300);
  const bits = [clean(p.t) || clean(p.c) || "Property", clean(p.l) && "in " + clean(p.l), clean(p.d) && "by " + clean(p.d)].filter(Boolean).join(" ");
  const more = [clean(p.s), clean(p.z), priceText(p), clean(p.tenure)].filter(Boolean).join(" · ");
  return (clean(p.n) + ": " + bits + ". " + more + ". Compare layouts, prices and maintenance fees.").slice(0, 300);
}
function poster(p) {
  const all = [...(p.gallery || []), p.img, ...(p.types || []).map((t) => t && t.img)];
  return all.find((u) => typeof u === "string" && /^https:\/\//.test(u)) || SITE + "og-default.jpg";
}

export default async (request, context) => {
  const res = await context.next();
  const m = new URL(request.url).pathname.match(/^\/property\/([^\/]+)\/?$/);
  if (!m || res.status !== 200) return res;
  let p = null;
  try {
    const slug = decodeURIComponent(m[1]);
    const r = await fetch(`${SB_URL}/rest/v1/projects?select=data&published=eq.true&slug=eq.${encodeURIComponent(slug)}&limit=1`, {
      headers: { apikey: SB_KEY, Accept: "application/json" },
    });
    if (r.ok) { const rows = await r.json(); p = rows && rows[0] && rows[0].data; }
  } catch (e) { p = null; }
  if (!p || !p.slug) return res;

  const title = clean(p.seoT) || clean(p.n) + (clean(p.l) ? " – " + clean(p.l) : "") + " | One Stop Centre";
  const price = priceText(p);
  const ogTitle = clean(p.n) + (clean(p.l) ? " – " + clean(p.l) : "") + (price ? " | " + price.replace(/^from /, "From ") : "");
  const desc = describe(p);
  const url = SITE + "property/" + p.slug + "/";
  const img = poster(p);
  const tags =
    `<title>${esc(title)}</title>` +
    `<meta name="description" content="${esc(desc)}">` +
    `<link rel="canonical" href="${esc(url)}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:site_name" content="One Stop Centre Property Lists">` +
    `<meta property="og:title" content="${esc(ogTitle)}">` +
    `<meta property="og:description" content="${esc(desc)}">` +
    `<meta property="og:url" content="${esc(url)}">` +
    (img ? `<meta property="og:image" content="${esc(img)}"><meta property="og:image:secure_url" content="${esc(img)}"><meta property="og:image:alt" content="${esc(clean(p.n))}"><meta name="twitter:image" content="${esc(img)}">` : "") +
    `<meta name="twitter:card" content="${img ? "summary_large_image" : "summary"}">` +
    `<meta name="twitter:title" content="${esc(ogTitle)}">` +
    `<meta name="twitter:description" content="${esc(desc)}">`;

  let html = await res.text();
  html = html.replace(/<title>[\s\S]*?<\/title>/i, "").replace(/<\/head>/i, tags + "</head>");
  const headers = new Headers(res.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.delete("content-length");
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  return new Response(html, { status: 200, headers });
};

export const config = { path: "/property/*" };
