# Phase 1 — Baseline audit of the existing website

Audited on 2026-10-26 at commit `1790392` (branch `main`). Nothing in this list may be removed or changed by the AI Sales module.

## 1. Stack and deployment

| Item | Finding |
|---|---|
| Framework | **None.** Hand-written vanilla JS single-file app. Not React. No build step, no `package.json`, no bundler. |
| Pages | `index.html` (~509 KB: homepage, listings, detail views, calculators, admin CMS, all CSS/JS inline) and `property.html` (~508 KB, near-identical copy served for `/property/*`). `404.html`. |
| Hosting | Netlify site `onestopcentreproperty` (plan `nf_team_dev`), domain `onestopcentreproperty.com`. `netlify.toml` = `publish = "."` — **the repo root is published as-is**, so any file added to the repo is publicly downloadable unless blocked. |
| Server code | One Netlify **Edge Function**: `netlify/edge-functions/property.js`. No Netlify Functions. |
| Database | Supabase project `deethrwnmyezwsohmhzl` ("One Stop Centre", ap-southeast-1, Postgres 17). |
| Client library | `@supabase/supabase-js@2.49.4` from jsDelivr, publishable (anon) key in page. |
| Fonts | Google Fonts (Fraunces, Plus Jakarta Sans). |

## 2. URLs, routing and SEO (must be preserved)

| URL | Served by | Behaviour |
|---|---|---|
| `/` | Edge fn + `index.html` | Injects fresh projects JSON (`#data`), stats counters, A–Z directory (`#alldir`), JSON-LD (`#seo-ld`), meta description, hreflang EN/BM. CDN cache 60 s + SWR 1 day. |
| `/ms/`, `/ms/*` | Edge fn / `_redirects` → `index.html` | Bahasa Melayu version: `lang="ms-MY"`, canonical `/ms/`, BM title, BM OG image. `/ms` → 301 `/ms/`. |
| `/property/<slug>/`, `/ms/property/<slug>/` | Edge fn + `property.html` | Crawlers/link-preview bots get a fast text-first SEO page (title, description, canonical, hreflang, OG/Twitter, `RealEstateListing` + `BreadcrumbList` JSON-LD, WhatsApp CTA, brochure link). People get the full app with the property's head tags. Missing trailing slash → 301. Unknown → 404 page. Retired slug `m-mira-wangsa-maju` → 301 `m-mira-wangsa-maju-2`. |
| `/sitemap.xml` | Edge fn (fallback: `_redirects` → Supabase Storage copy) | Home + every published property, EN + BM pairs with hreflang, `lastmod`, up to 10 images each. |
| `/admin`, `/admin/` | Edge fn | `noindex` hop page → `/#admin` (admin dashboard lives inside `index.html`). |
| `/index.html`, `/property.html` | Edge fn | 301 → `/`. |
| `robots.txt` | static | Allow all; sitemap link. |
| IndexNow | client (admin save) | Key file `bf692282dcf951b27c365c5a201d5bb7.txt`; pings api.indexnow.org on publish. |
| `_headers` | static | nosniff, referrer policy, `X-Frame-Options: SAMEORIGIN`, Permissions-Policy. |

## 3. Public website features (in `index.html` / `property.html`)

- Property listing grid with search, area/type/budget/bedroom/tenure/furnishing filters, sort, chips, result count.
- Property detail view (`#detail`): gallery, layouts & prices table, towers, facilities, furnishing list, nearby (transit/schools/uni/amenities/future), "Our take", videos (YouTube/Vimeo), Google Maps, brochure PDF.
- Compare tray (`#cmpbar`, `#cmpm`) and compare modal.
- Loan / monthly instalment calculator (`#calc`, `#dcalc`, `#pop_calc`), budget matcher (`#bm-*`).
- Share buttons: per-project share (`#ac_share`, `#shs_*` incl. WhatsApp / copy link / image), share-site (`#shareSite`), PDF export (`#ac_pdf`).
- Favourites (`localStorage osc_fav`), welcome overlay, voice-over/intro (`osc_vo_*`), language switch EN/BM (`osc_lang`, `#i18n-ms` dictionary).
- Enquiry form (`#q_*`) → inserts into `public.leads` (with honeypot `#q_hp`, 60 s client throttle, consent=true).
- Floating WhatsApp button (`#fab-wa`), contact links (`wa.me/<settings.wa>`).
- Responsive layout (mobile bottom sheet `#bm-mobile`, safe-area insets, `interactive-widget=resizes-content`).

## 4. Existing admin dashboard (CMS) — inside `index.html`

- Login via Supabase Auth email + password; must be in `public.admins` (checked with `rpc('is_admin')`). Password reset email, set-new-password, recovery-key flow.
- Tabs: **home** (overview), **leads** (pipeline status, add manual lead, search, Excel export, delete), **projects** (grid + full editor: details, types/layouts, towers, gallery, videos, brochure upload ≤25 MB, location, nearby with "AI draft" via `window.claude` when run inside Claude, SEO title/description, publish), **health** (content health checks), settings (email, WhatsApp number, site URL, voice-over, loan defaults, ordering, import/export, credentials).
- Save: upserts changed projects to `public.projects`, **deletes projects removed in the editor**, updates `settings.data`, uploads `sitemap.xml` to Storage, pings IndexNow.
- Media: uploaded to Storage bucket `photos` (public) under `p/<id>/<hash>.<ext>` and `b/<id>/...pdf`.

## 5. Database (live, read-only inspection)

| Table | Rows | Columns | RLS policies |
|---|---|---|---|
| `projects` | 8 (7 published) | `id text pk`, `slug text unique`, `data jsonb`, `published bool`, `updated_at` | public SELECT where published or admin; admin ALL |
| `settings` | 1 | `id int pk check id=1`, `data jsonb` (`email, wa, site, vo, loan, order`), `updated_at` | public SELECT; admin UPDATE |
| `leads` | 2 | `id uuid`, `created_at`, `name`, `phone`, `email`, `project`, `message`, `consent bool check consent`, `status text default 'new'` | anon/auth INSERT; admin SELECT/UPDATE/DELETE |
| `admins` | 1 | `email text pk` | RLS on, no policies (read via `is_admin()` only) |

Functions/triggers: `is_admin()` (security definer), `leads_guard` (BEFORE INSERT: global rate limit 30 / 10 min, forces status/created_at), `notify_new_lead` (AFTER INSERT: Telegram alert via `pg_net`, token from Vault), `touch_updated` on projects/settings.
Extensions: pgcrypto, uuid-ossp, supabase_vault, pg_net, pg_stat_statements. **No** pgvector, **no** pg_cron.
Storage: bucket `photos` (public). Migrations recorded: `stage1_security_hardening`, `stage1b_telegram_token_from_vault`.

`projects.data` JSON keys (the property knowledge source of truth): `id, slug, n` (name), `l` (area), `d` (developer), `c` (category), `t` (type), `s` (status), `p` (price text), `z` (size), `b` (beds), `tenure, lease, year` (completion), `height, towers, types[] {name,size,beds,baths,carparks,price,img}`, `facilities, furn, furnList, maintPsf, address, latlng, mapUrl, mapImg, near{transit,schools,uni,amen,future}, nearby, hl` (highlights), `desc, concl, gallery, img, videos, brochure, seoT, seoD, mod, sh, rate, layouts, carpark, h`.

## 6. Pre-existing observations (not changed by this work — for your decision)

1. Supabase advisor: `is_admin()` is executable by `anon` (low risk: it only returns true/false for the caller).
2. Supabase advisor: `pg_net` extension installed in `public`; leaked-password protection disabled in Auth.
3. Because `publish = "."`, the edge-function source `netlify/edge-functions/property.js` is publicly downloadable (it contains only the publishable key, which is public by design).
4. The CMS save deletes `public.projects` rows that are no longer in the editor list. **Consequence for the new module:** it must never hold a foreign key to `public.projects` (that would make those deletes fail and break saving).
5. Table names `projects` and `leads` collide with the master brief's entity names. **Consequence:** all new tables use the `ai_` prefix.

## 7. Regression suite created from this baseline

`ai-sales/tests/regression/` — run with `ai-sales/run-tests.sh`:
- **protected-files**: SHA-256 of all 25 original files must stay identical; `_redirects`, `_headers`, `robots.txt` must keep every original line in order (append-only); no root `package.json` may appear (keeps Netlify's build a plain static publish).
- **edge-function**: 15 behavioural tests of homepage injection, BM homepage, property SEO pages (bot + human), 301/404 rules, sitemap, `/admin` hop, DB-down fallback, and that the edge function's routes are unchanged.

Result on the untouched baseline: **40/40 passed**.
