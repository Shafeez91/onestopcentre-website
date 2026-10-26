// Regression tests for the existing server-side pages (netlify/edge-functions/property.js):
// homepage data injection, EN/BM switching, property pages, SEO tags, sitemap, /admin hop and redirects.
// The database is replaced by an in-memory test fixture; nothing here touches production.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INDEX = readFileSync(path.join(root, "index.html"), "utf8");
const PROPERTY = readFileSync(path.join(root, "property.html"), "utf8");

// TEST FIXTURE ONLY – not real listings
const FIXTURE = [
  { id: "t1", slug: "test-residence-cheras", n: "Test Residence", l: "Cheras", d: "Test Developer", t: "Condominium", c: "Residential", s: "New Launch", p: "", tenure: "Freehold", mod: "2026-10-01",
    types: [{ name: "Type A", size: "800", beds: "3", baths: "2", price: "RM450,000" }], gallery: ["https://example.test/a.jpg"], facilities: ["Swimming pool"] },
  { id: "t2", slug: "m-mira-wangsa-maju-2", n: "Test Mira 2", l: "Wangsa Maju", d: "Test Developer", t: "Condominium", c: "Residential", s: "Completed", p: "RM476,000", mod: "2026-09-01", types: [] },
];
let dbDown = false;
const realFetch = globalThis.fetch;
let handler, config;

before(async () => {
  globalThis.fetch = async (url) => {
    if (dbDown) return new Response("down", { status: 503 });
    const u = String(url);
    if (u.includes("/rest/v1/projects")) return Response.json(FIXTURE.map((p) => ({ id: p.id, data: structuredClone(p) })));
    if (u.includes("/rest/v1/settings")) return Response.json([{ data: { email: "test@example.test", wa: "60123456789", order: ["t1", "t2"] } }]);
    throw new Error("unexpected fetch " + u);
  };
  const mod = await import(pathToFileURL(path.join(root, "netlify/edge-functions/property.js")).href);
  handler = mod.default; config = mod.config;
});
after(() => { globalThis.fetch = realFetch; });

const UA_HUMAN = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1";
const call = (p, ua = UA_HUMAN) => {
  const req = new Request("https://onestopcentreproperty.com" + p, { headers: { "user-agent": ua } });
  const page = /\/property\//.test(p) ? PROPERTY : INDEX;
  return handler(req, { next: async () => new Response(page, { status: 200, headers: { "content-type": "text/html" } }) });
};

test("edge function routes are exactly the original ones (new module paths are not intercepted)", () => {
  assert.deepEqual(config.path, ["/", "/index.html", "/property.html", "/admin", "/admin/", "/property/*", "/sitemap.xml", "/ms", "/ms/", "/ms/property/*"]);
  assert.ok(!config.path.some((p) => p.startsWith("/sales") || p.startsWith("/api")));
});

test("homepage: fresh data, stats, A–Z directory, structured data and hreflang", async () => {
  const r = await call("/");
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<script id="data" type="application\/json" data-fresh="1">/);
  assert.match(h, /"slug":"test-residence-cheras"/);
  assert.match(h, /<b data-n="2">2<\/b><span>Projects<\/span>/);
  assert.match(h, /href="\/property\/test-residence-cheras\/"/);
  assert.match(h, /hreflang="ms-MY" href="https:\/\/onestopcentreproperty.com\/ms\/"/);
  assert.match(h, /"@type":"ItemList"/);
  assert.match(h, /<meta name="description" content="Compare new launch/);
  assert.match(r.headers.get("netlify-cdn-cache-control"), /max-age=60/);
});

test("Bahasa Melayu homepage: language, canonical, title and OG image", async () => {
  const h = await (await call("/ms/")).text();
  assert.match(h, /<html lang="ms-MY" data-lang="ms"/);
  assert.match(h, /<link rel="canonical" href="https:\/\/onestopcentreproperty.com\/ms\/"/);
  assert.match(h, /Rumah Baharu &amp; Siap di Lembah Klang/);
  assert.match(h, /og-home-2026-ms.jpg/);
  assert.match(h, /<span>Projek<\/span>/);
});

test("/ms redirects to /ms/", async () => {
  const r = await call("/ms");
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "https://onestopcentreproperty.com/ms/");
});

test("property page for crawlers/link previews: SEO title, canonical, hreflang, OG, JSON-LD, WhatsApp CTA", async () => {
  const r = await call("/property/test-residence-cheras/", "WhatsApp/2.23 A");
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<title>Test Residence, Cheras \| From RM450,000 \| One Stop Centre<\/title>/);
  assert.match(h, /<link rel="canonical" href="https:\/\/onestopcentreproperty.com\/property\/test-residence-cheras\/">/);
  assert.match(h, /hreflang="ms-MY" href="https:\/\/onestopcentreproperty.com\/ms\/property\/test-residence-cheras\/"/);
  assert.match(h, /<meta property="og:image" content="https:\/\/example.test\/a.jpg\?v=/);
  assert.match(h, /"@type":"RealEstateListing"/);
  assert.match(h, /"lowPrice":450000/);
  assert.match(h, /https:\/\/wa.me\/60123456789\?text=/);
  assert.equal(r.headers.get("vary"), "User-Agent");
});

test("property page in Bahasa Melayu", async () => {
  const h = await (await call("/ms/property/test-residence-cheras/", "Googlebot/2.1")).text();
  assert.match(h, /<html lang="ms-MY">/);
  assert.match(h, /Kondominium di Cheras/);
  assert.match(h, /dari RM450,000/);
});

test("property page for people: full site with the property's own head tags", async () => {
  const h = await (await call("/property/test-residence-cheras/")).text();
  assert.match(h, /<link rel="canonical" href="https:\/\/onestopcentreproperty.com\/property\/test-residence-cheras\/">/);
  assert.match(h, /data-fresh="1"/);
  const head = h.slice(0, h.indexOf("</head>"));
  assert.equal((head.match(/<link rel="canonical"/g) || []).length, 1, "exactly one canonical tag in <head>");
});

test("property URL without trailing slash → 301; unknown → 404; retired slug → 301 to replacement", async () => {
  let r = await call("/property/test-residence-cheras");
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "https://onestopcentreproperty.com/property/test-residence-cheras/");
  r = await call("/property/does-not-exist/");
  assert.equal(r.status, 404);
  assert.match(r.headers.get("netlify-cdn-cache-control"), /max-age=30/);
  r = await call("/property/m-mira-wangsa-maju/");
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "https://onestopcentreproperty.com/property/m-mira-wangsa-maju-2/");
});

test("sitemap lists home and every property in EN and BM with hreflang and images", async () => {
  const r = await call("/sitemap.xml");
  assert.match(r.headers.get("content-type"), /application\/xml/);
  const x = await r.text();
  assert.match(x, /<loc>https:\/\/onestopcentreproperty.com\/<\/loc>/);
  assert.match(x, /<loc>https:\/\/onestopcentreproperty.com\/ms\/property\/test-residence-cheras\/<\/loc>/);
  assert.match(x, /<image:loc>https:\/\/example.test\/a.jpg<\/image:loc>/);
  assert.match(x, /<lastmod>2026-10-01<\/lastmod>/);
  assert.equal((x.match(/<url>/g) || []).length, 6);
});

test("/admin hop page is noindex and points to the existing dashboard", async () => {
  const r = await call("/admin");
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(await r.text(), /location.replace\("\/#admin"\)/);
});

test("/index.html and /property.html redirect to /", async () => {
  for (const p of ["/index.html", "/property.html"]) {
    const r = await call(p);
    assert.equal(r.status, 301);
    assert.equal(r.headers.get("location"), "https://onestopcentreproperty.com/");
  }
});

test("database unreachable → falls through to the static files", async () => {
  dbDown = true;
  try { assert.equal(await call("/"), undefined); } finally { dbDown = false; }
});
