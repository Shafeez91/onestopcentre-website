// AI Sales dashboard — shell, sign-in, navigation and routing.
import { SB, S, $, $$, esc, q, act, toast, loadLookups, flag, hasUnsaved, errText, can } from "./core.js";
import * as crm from "./crm.js";
import * as kb from "./knowledge.js";
import * as adm from "./admin.js";
import * as ait from "./aitest.js";
import * as wfp from "./workflows.js";
import { icon } from "./icons.js";
import { dashboard } from "./dashboard.js";
import { leadWorkspace } from "./lead.js";
import { inbox } from "./inbox.js";

// grouped navigation: [group, [[route, label, icon]]]
const NAV = [
  ["Overview", [["overview", "Dashboard", "dashboard"], ["inbox", "WhatsApp inbox", "inbox"], ["handover", "Handover queue", "flag"]]],
  ["Sales & Clients", [["leads", "Leads & CRM", "users"], ["pipeline", "Pipeline", "columns"], ["appointments", "Tasks & appointments", "calendar"], ["workflows", "Follow-up workflows", "workflow"]]],
  ["AI & Knowledge", [["settings", "AI agent settings", "sliders"], ["ai-test", "AI test console", "sparkle"], ["properties", "Property projects", "building"], ["knowledge", "Knowledge base", "book"], ["templates", "Templates & objections", "quote"]]],
  ["Reporting", [["reports", "Reports", "chart"], ["campaigns", "Campaigns", "megaphone"], ["followups", "Follow-up automation", "refresh"]]],
  ["Administration", [["team", "Team & permissions", "team"], ["integrations", "Integrations", "plug"], ["audit", "Consent, security & audit", "shield"]]],
];
const NAV_ITEM = Object.fromEntries(NAV.flatMap(([g, items]) => items.map(([k, l]) => [k, { group: g, label: l }])));
const ROUTES = {
  overview: (el) => dashboard(el), inbox: (el, p) => inbox(el, p), leads: (el, p) => crm.leads(el, p), lead: (el, p, id) => leadWorkspace(el, p, id),
  "ai-test": (el, p) => ait.aitest(el, p), workflows: (el, p) => wfp.workflows(el, p), workflow: (el, p, id) => wfp.workflow(el, p, id),
  // the RMK page before workflows were configurable: same pipeline, now the RMK workflow
  rmk: (el, p) => wfp.workflow(el, new URLSearchParams({ view: { settings: "stages" }[p.get("view")] || p.get("view") || "board" }), "rmk"),
  pipeline: (el) => crm.pipeline(el), appointments: (el, p) => crm.appointments(el, p), handover: (el) => crm.handover(el),
  properties: (el) => kb.properties(el), property: (el, p, id) => kb.property(el, id), knowledge: (el, p) => kb.knowledge(el, p),
  templates: (el, p) => adm.templates(el, p), followups: (el) => adm.followups(el), campaigns: (el) => adm.campaigns(el), reports: (el, p) => adm.reports(el, p),
  settings: (el, p, id) => (id === "pipeline" ? adm.stages(el) : adm.settings(el, p)), team: (el) => adm.team(el), integrations: (el) => adm.integrations(el), audit: (el, p) => adm.audit(el, p),
};
const NAV_OF = { lead: "leads", property: "properties", workflow: "workflows", rmk: "workflows" };
const DETAIL = { lead: "Lead", property: "Project", workflow: "Workflow" };
const NAV_KEY = "sales:nav-collapsed";

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
  let collapsed = false;
  try { collapsed = localStorage.getItem(NAV_KEY) === "1"; } catch { /* storage is optional */ }
  root.innerHTML = `
  <div class="shell${collapsed ? " collapsed" : ""}" id="shell">
  <nav class="side" id="side" aria-label="AI Sales sections">
    <div class="side-head"><a class="brand" href="#/overview"><img src="/osc-logo-96.png" width="30" height="30" alt=""><span>One Stop Centre<small>AI Sales</small></span></a>
      <button class="icon collapse" id="cbtn" aria-label="Collapse menu" aria-pressed="${collapsed}" title="Collapse menu">${icon("collapse")}</button></div>
    ${NAV.map(([g, items]) => `<p class="grp">${esc(g)}</p>${items.map(([k, l, i]) => `<a href="#/${k}" data-nav="${k}" title="${esc(l)}">${icon(i)}<span>${esc(l)}</span></a>`).join("")}`).join("")}
    <p class="grp">Website</p><a href="/" target="_blank" rel="noopener" title="Open website">${icon("external")}<span>Open website</span></a><a href="/#admin" target="_blank" rel="noopener" title="Website admin">${icon("external")}<span>Website admin</span></a>
  </nav>
  <div class="scrim" id="scrim"></div>
  <div class="col">
    <header class="top">
      <button class="icon menu" id="mbtn" aria-label="Open menu" aria-expanded="false">${icon("menu", { size: 22 })}</button>
      <nav class="crumbs" id="crumbs" aria-label="Breadcrumb"></nav>
      <form class="gsearch" id="gsearch" role="search"><label class="sr" for="gq">Search leads</label>${icon("search", { size: 18 })}<input id="gq" name="q" type="search" placeholder="Search leads: name, phone, OSC code" autocomplete="off"></form>
      <div class="top-actions">
        <div class="pop"><button class="icon tbtn" id="addbtn" aria-label="Quick add" aria-haspopup="true" aria-expanded="false">${icon("plus")}</button>
          <div class="pop-menu" id="addmenu" hidden>${can("advisor") ? `<a href="#/leads?new=1">${icon("users", { size: 18 })}New lead</a>` : ""}
            ${can("manager") ? `<a href="#/workflows?new=1">${icon("workflow", { size: 18 })}New follow-up workflow</a>` : ""}
            <a href="#/appointments">${icon("calendar", { size: 18 })}Appointments</a><a href="#/ai-test">${icon("sparkle", { size: 18 })}Test the AI</a></div></div>
        <div class="pop"><button class="icon tbtn" id="bellbtn" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">${icon("bell")}<span class="dot" id="belldot" hidden></span></button>
          <div class="pop-menu wide" id="bellmenu" hidden><p class="note">Checking…</p></div></div>
        <div class="pop"><button class="who" id="whobtn" aria-haspopup="true" aria-expanded="false"><span class="av">${esc((S.email || "?")[0].toUpperCase())}</span><span class="role">${esc(S.role)}</span></button>
          <div class="pop-menu" id="whomenu" hidden><p class="note">Signed in as<br><b>${esc(S.email)}</b></p><button class="link" id="so">${icon("logout", { size: 18 })}Sign out</button></div></div>
      </div>
    </header>
    <main class="main" id="view" tabindex="-1"></main>
  </div></div>
  ${flag("module_enabled") ? "" : `<div class="banner">The AI Sales workspace is switched off for non-owners (Settings → Feature switches).</div>`}`;
  $("#so").onclick = signOut;
  const shellEl = $("#shell"), side = $("#side"), mbtn = $("#mbtn"), scrim = $("#scrim");
  const setMenu = (open) => { side.classList.toggle("open", open); scrim.classList.toggle("on", open); mbtn.setAttribute("aria-expanded", String(open)); };
  mbtn.onclick = () => setMenu(!side.classList.contains("open"));
  scrim.onclick = () => setMenu(false);
  side.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
  $("#cbtn").onclick = () => {
    const c = !shellEl.classList.contains("collapsed");
    shellEl.classList.toggle("collapsed", c); $("#cbtn").setAttribute("aria-pressed", String(c));
    try { localStorage.setItem(NAV_KEY, c ? "1" : "0"); } catch { /* ignore */ }
  };
  $("#gsearch").onsubmit = (e) => { e.preventDefault(); const v = $("#gq").value.trim(); location.hash = "#/leads?" + new URLSearchParams(v ? { q: v } : {}); };
  // small pop-up menus: one open at a time, closed by a click elsewhere or Escape
  const pops = [["addbtn", "addmenu"], ["bellbtn", "bellmenu"], ["whobtn", "whomenu"]];
  const closeAll = () => pops.forEach(([b, m]) => { $("#" + m).hidden = true; $("#" + b).setAttribute("aria-expanded", "false"); });
  pops.forEach(([b, m]) => { $("#" + b).onclick = (e) => { e.stopPropagation(); const open = $("#" + m).hidden; closeAll(); if (open) { $("#" + m).hidden = false; $("#" + b).setAttribute("aria-expanded", "true"); if (b === "bellbtn") loadAlerts(); } }; });
  if (!shell.bound) { // once per page load, not per sign-in
    shell.bound = true;
    document.addEventListener("click", (e) => { if (!e.target.closest(".pop-menu")) closeAll(); else if (e.target.closest("a")) closeAll(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
  }
  loadAlerts();
}

/** What needs a person now: open hand-overs, overdue tasks, workflow leads needing a person, unconfirmed visits. */
let alertsAt = 0;
async function loadAlerts() {
  alertsAt = Date.now();
  const count = (b) => q(b).catch(() => 0);
  const head = (t) => SB.from(t).select("id", { count: "exact", head: true });
  const [ho, tasks, wf, appts] = await Promise.all([
    count(head("ai_handover_events").eq("status", "open")),
    count(head("ai_tasks").eq("status", "open").lt("due_at", new Date().toISOString())),
    count(head("ai_workflow_leads").eq("status", "human")),
    count(head("ai_appointments").eq("status", "pending_confirmation")),
  ]);
  const rows = [[ho, "buyer(s) waiting for a person", "#/handover", "flag"], [tasks, "overdue follow-up task(s)", "#/leads", "task"],
    [wf, "workflow lead(s) need a person", "#/workflows", "workflow"], [appts, "appointment(s) to confirm", "#/appointments", "calendar"]].filter(([n]) => Number(n) > 0);
  const total = rows.reduce((a, [n]) => a + Number(n), 0), dot = $("#belldot"), menu = $("#bellmenu");
  if (!dot || !menu) return;
  dot.hidden = !total; dot.textContent = total > 99 ? "99+" : String(total);
  menu.innerHTML = rows.length ? `<p class="note">Needs attention</p>${rows.map(([n, l, h, i]) => `<a href="${h}">${icon(i, { size: 18 })}<b>${esc(n)}</b> ${esc(l)}</a>`).join("")}` : `<p class="note">Nothing needs attention right now.</p>`;
}

function crumbs(name, id) {
  const el = $("#crumbs");
  if (!el) return;
  const key = NAV_OF[name] || (ROUTES[name] ? name : "overview"), it = NAV_ITEM[key];
  el.innerHTML = it ? `<span>${esc(it.group)}</span><i aria-hidden="true">/</i>${DETAIL[name] ? `<a href="#/${key}">${esc(it.label)}</a><i aria-hidden="true">/</i><b>${esc(DETAIL[name])}</b>` : `<b>${esc(it.label)}</b>`}` : "";
  document.title = `${it && !DETAIL[name] ? it.label : DETAIL[name] || "AI Sales"} | AI Sales`;
}

let renderSeq = 0, shownPath = null;
async function route() {
  const view = $("#view");
  if (!view) return;
  const [path, qs] = (location.hash.replace(/^#\/?/, "") || "overview").split("?");
  const [name, id] = path.split("/");
  const fn = ROUTES[name] || ROUTES.overview;
  const nav = NAV_OF[name] || (ROUTES[name] ? name : "overview");
  $$("[data-nav]").forEach((a) => { a.classList.toggle("on", a.dataset.nav === nav); if (a.dataset.nav === nav) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  crumbs(name, id);
  if (Date.now() - alertsAt > 60e3) loadAlerts();
  const seq = ++renderSeq;
  // a new page starts at the top; a tab or filter change on the same page keeps the current content and scroll
  // position until the new content is ready (blanking it first collapsed the page and threw the reader to the top).
  // Opening a chat in the inbox counts as a new page, so the conversation starts at its top.
  const samePage = path === shownPath && name !== "inbox" && view.firstElementChild && !view.querySelector(".loading");
  if (!samePage) { view.innerHTML = `<div class="loading"><span class="spin"></span> Loading…</div>`; window.scrollTo(0, 0); }
  else view.setAttribute("aria-busy", "true");
  // the page is built off-screen in its own container, which then goes on screen as a whole. Pages keep a reference
  // to this container and re-render into it after a save, so it must stay the live element (moving only its
  // children left saves refreshing a detached copy: "Saved" appeared but the screen did not change)
  const page = document.createElement("div");
  page.className = "page";
  try {
    await fn(page, new URLSearchParams(qs || ""), id && decodeURIComponent(id));
    if (seq !== renderSeq) return; // a newer navigation won
    const y = window.scrollY;
    view.replaceChildren(page);
    shownPath = path;
    if (samePage) window.scrollTo(0, y);
  } catch (e) {
    console.error(e);
    if (seq !== renderSeq) return;
    view.innerHTML = `<div class="card error"><h2>Could not load this page</h2><p>${esc(errText(e))}</p><button class="btn" id="retry">Retry</button></div>`;
    $("#retry").onclick = () => route();
    shownPath = null;
  }
  view.removeAttribute("aria-busy");
  if (!samePage) view.focus({ preventScroll: true });
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
