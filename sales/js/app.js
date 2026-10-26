// AI Sales dashboard — shell, sign-in, navigation and routing.
import { SB, S, $, $$, esc, q, act, toast, loadLookups, flag, hasUnsaved, errText } from "./core.js";
import * as crm from "./crm.js";
import * as kb from "./knowledge.js";
import * as adm from "./admin.js";

const NAV = [
  ["Sales", [["overview", "Overview", "◎"], ["inbox", "WhatsApp inbox", "✉"], ["leads", "Leads & CRM", "☺"], ["pipeline", "Pipeline", "▤"], ["appointments", "Appointments", "◷"], ["handover", "Handover queue", "⚑"]]],
  ["Knowledge", [["properties", "Property projects", "⌂"], ["knowledge", "Knowledge base", "❏"], ["templates", "Templates & objections", "❝"]]],
  ["Automation", [["followups", "Follow-up automation", "↻"], ["campaigns", "Campaigns", "◈"], ["reports", "Reports", "▥"]]],
  ["Admin", [["settings", "AI agent settings", "⚙"], ["team", "Team & permissions", "⚇"], ["integrations", "Integrations", "⇄"], ["audit", "Consent, security & audit", "⛨"]]],
];
const ROUTES = {
  overview: (el) => crm.overview(el), inbox: (el) => crm.inbox(el), leads: (el, p) => crm.leads(el, p), lead: (el, p, id) => crm.leadDetail(el, id),
  pipeline: (el) => crm.pipeline(el), appointments: (el, p) => crm.appointments(el, p), handover: (el) => crm.handover(el),
  properties: (el) => kb.properties(el), property: (el, p, id) => kb.property(el, id), knowledge: (el, p) => kb.knowledge(el, p),
  templates: (el, p) => adm.templates(el, p), followups: (el) => adm.followups(el), campaigns: (el) => adm.campaigns(el), reports: (el, p) => adm.reports(el, p),
  settings: (el, p, id) => (id === "pipeline" ? adm.stages(el) : adm.settings(el, p)), team: (el) => adm.team(el), integrations: (el) => adm.integrations(el), audit: (el, p) => adm.audit(el, p),
};
const NAV_OF = { lead: "leads", property: "properties" };

const root = $("#app");

function loginView(msg = "") {
  root.innerHTML = `<main class="login"><form id="lf" class="card">
    <img src="/osc-logo-96.png" width="56" height="56" alt="">
    <h1>AI Sales</h1><p class="sub">One Stop Centre · staff sign-in</p>
    <label>Email<input name="email" type="email" autocomplete="username" required></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <p class="err" role="alert">${esc(msg)}</p>
    <button class="btn pri" data-busy="Signing in…">Sign in</button>
    <button class="link" type="button" id="forgot">Forgot password?</button>
    <p class="note">Same account as the website admin. Staff accounts are created by an owner.</p></form></main>`;
  const f = $("#lf");
  f.onsubmit = (e) => { e.preventDefault();
    act(f.querySelector(".btn"), async () => {
      const { error } = await SB.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
      if (error) { f.querySelector(".err").textContent = /invalid/i.test(error.message) ? "Incorrect email or password." : error.message; return; }
      await boot();
    }); };
  $("#forgot").onclick = () => { const email = f.email.value.trim(); if (!email) { f.querySelector(".err").textContent = "Enter your email first."; return; }
    act($("#forgot"), async () => { const { error } = await SB.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/sales/" }); if (error) throw error; f.querySelector(".err").textContent = "If this account exists, a reset link has been emailed."; }); };
}

function newPasswordView() {
  root.innerHTML = `<main class="login"><form id="pf" class="card"><h1>Set a new password</h1>
    <label>New password (min 10 characters)<input name="p1" type="password" minlength="10" autocomplete="new-password" required></label>
    <label>Confirm<input name="p2" type="password" minlength="10" autocomplete="new-password" required></label>
    <p class="err" role="alert"></p><button class="btn pri">Save password</button></form></main>`;
  const f = $("#pf");
  f.onsubmit = (e) => { e.preventDefault(); if (f.p1.value !== f.p2.value) { f.querySelector(".err").textContent = "Passwords do not match."; return; }
    act(f.querySelector(".btn"), async () => { const { error } = await SB.auth.updateUser({ password: f.p1.value }); if (error) throw error; history.replaceState(null, "", "/sales/"); await boot(); }, "Password saved"); };
}

function noAccess(text) {
  root.innerHTML = `<main class="login"><div class="card"><h1>AI Sales</h1><p>${esc(text)}</p><p class="note">Signed in as ${esc(S.email)}</p><button class="btn" id="so">Sign out</button></div></main>`;
  $("#so").onclick = signOut;
}

async function signOut() {
  if (hasUnsaved() && !confirm("You have unsaved drafts in this tab. Sign out anyway?")) return;
  await SB.auth.signOut();
  try { Object.keys(sessionStorage).filter((k) => k.startsWith("sales:draft:")).forEach((k) => sessionStorage.removeItem(k)); } catch { /* ignore */ }
  loginView();
}

function shell() {
  root.innerHTML = `
  <header class="top"><button class="icon menu" id="mbtn" aria-label="Open menu" aria-expanded="false">☰</button><a class="brand" href="#/overview"><img src="/osc-logo-96.png" width="28" height="28" alt=""> <span>AI Sales</span></a>
    <span class="who"><span class="role">${esc(S.role)}</span> <span class="em">${esc(S.email)}</span> <button class="link" id="so">Sign out</button></span></header>
  <div class="layout"><nav class="side" id="side" aria-label="AI Sales sections">${NAV.map(([g, items]) => `<p class="grp">${esc(g)}</p>${items.map(([k, l, i]) => `<a href="#/${k}" data-nav="${k}"><span class="ic" aria-hidden="true">${i}</span>${esc(l)}</a>`).join("")}`).join("")}
    <p class="grp">Website</p><a href="/" target="_blank" rel="noopener"><span class="ic" aria-hidden="true">↗</span>Open website</a><a href="/#admin" target="_blank" rel="noopener"><span class="ic" aria-hidden="true">↗</span>Website admin</a></nav>
  <div class="scrim" id="scrim"></div><main class="main" id="view" tabindex="-1"></main></div>
  ${flag("module_enabled") ? "" : `<div class="banner">The AI Sales workspace is switched off for non-owners (Settings → Feature switches).</div>`}`;
  $("#so").onclick = signOut;
  const side = $("#side"), mbtn = $("#mbtn"), scrim = $("#scrim");
  const setMenu = (open) => { side.classList.toggle("open", open); scrim.classList.toggle("on", open); mbtn.setAttribute("aria-expanded", String(open)); };
  mbtn.onclick = () => setMenu(!side.classList.contains("open"));
  scrim.onclick = () => setMenu(false);
  side.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
}

let renderSeq = 0;
async function route() {
  const view = $("#view");
  if (!view) return;
  const [path, qs] = (location.hash.replace(/^#\/?/, "") || "overview").split("?");
  const [name, id] = path.split("/");
  const fn = ROUTES[name] || ROUTES.overview;
  const nav = NAV_OF[name] || (ROUTES[name] ? name : "overview");
  $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === nav));
  const seq = ++renderSeq;
  view.innerHTML = `<div class="loading"><span class="spin"></span> Loading…</div>`;
  const tmp = document.createElement("div");
  try {
    await fn(tmp, new URLSearchParams(qs || ""), id && decodeURIComponent(id));
    if (seq !== renderSeq) return; // a newer navigation won
    view.replaceChildren(...tmp.childNodes);
  } catch (e) {
    console.error(e);
    if (seq !== renderSeq) return;
    view.innerHTML = `<div class="card error"><h2>Could not load this page</h2><p>${esc(errText(e))}</p><button class="btn" id="retry">Retry</button></div>`;
    $("#retry").onclick = () => route();
  }
  view.focus({ preventScroll: true });
  view.scrollTop = 0;
}

async function boot() {
  const { data: { session } } = await SB.auth.getSession();
  if (!session) return loginView();
  S.session = session;
  S.email = String(session.user.email || "").toLowerCase();
  try {
    S.role = await q(SB.rpc("ai_role"));
  } catch (e) {
    return noAccess(/ai_role|function|404|PGRST202/.test(String(e.message)) ? "The AI Sales database has not been installed yet. Apply the migrations in ai-sales/supabase/migrations first." : errText(e));
  }
  if (!S.role) return noAccess("Your account does not have access to AI Sales. Ask an owner to add you under Team & permissions.");
  try { await loadLookups(); } catch (e) { return noAccess("Could not load settings: " + errText(e)); }
  if (!flag("module_enabled") && S.role !== "owner") return noAccess("The AI Sales workspace is currently switched off by an owner.");
  shell();
  route();
}

window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (e) => { if (hasUnsaved()) { e.preventDefault(); e.returnValue = ""; } });
SB.auth.onAuthStateChange((evt) => {
  if (evt === "PASSWORD_RECOVERY") newPasswordView();
  if (evt === "SIGNED_OUT" && $("#view")) loginView("You have been signed out.");
});
window.addEventListener("unhandledrejection", (e) => { console.error(e.reason); toast(errText(e.reason), "err"); });
if (/type=(recovery|invite)/.test(location.hash)) {
  // Supabase puts the recovery/invite token in the URL hash; the client picks it up and fires PASSWORD_RECOVERY / SIGNED_IN
  SB.auth.getSession().then(({ data }) => (data.session ? newPasswordView() : loginView()));
} else boot();
