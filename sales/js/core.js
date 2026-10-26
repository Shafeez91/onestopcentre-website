// AI Sales dashboard — core helpers: Supabase client, state, escaping, toasts, modals, safe saves, drafts.
export const SB_URL = "https://deethrwnmyezwsohmhzl.supabase.co";
export const SB_KEY = "sb_publishable_gaiT2UF6vtI42BbYH1egKg_T_yLT83g";
export const SB = window.supabase.createClient(SB_URL, SB_KEY);

export const S = {
  session: null, email: "", role: null, settings: null, stages: [], sources: [], campaigns: [], team: [], projects: [], dirty: false,
};

const RANK = { viewer: 1, advisor: 2, manager: 3, owner: 4 };
export const can = (min) => (RANK[S.role] || 0) >= RANK[min];

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const attr = esc;

export const fmtDate = (d, withTime = true) => {
  if (!d) return "";
  const x = new Date(d);
  if (isNaN(x)) return "";
  return x.toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "short", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) });
};
export const ago = (d) => {
  if (!d) return "";
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
  return fmtDate(d, false);
};
export const money = (n) => (n || n === 0) && !isNaN(n) ? "RM" + Number(n).toLocaleString("en-MY", { maximumFractionDigits: 2 }) : "";
// <input type="datetime-local"> works in local browser time; convert carefully both ways
export const toLocalInput = (d) => { if (!d) return ""; const x = new Date(d); return new Date(x - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

export function projectName(id) { const p = S.projects.find((x) => x.id === id); return p ? p.name : id || ""; }
export function stageName(id) { return (S.stages.find((s) => s.id === id) || {}).name || ""; }
export function sourceName(id) { return (S.sources.find((s) => s.id === id) || {}).name || ""; }
// lowest layout price on the website listing — the "from" price
export function projectPriceFrom(id) {
  const p = S.projects.find((x) => x.id === id);
  if (!p) return null;
  const n = [...(p.data.types || []).map((t) => t && t.price), p.data.p].map((x) => +String(x || "").replace(/[^\d.]/g, "")).filter((v) => v >= 10000);
  return n.length ? Math.min(...n) : null;
}

/* ---------- toasts ---------- */
export function toast(msg, kind = "ok") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.setAttribute("role", kind === "err" ? "alert" : "status");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.classList.add("out"), kind === "err" ? 6000 : 3000);
  setTimeout(() => t.remove(), kind === "err" ? 6500 : 3500);
}

/* ---------- errors ---------- */
export function errText(e) {
  const m = (e && (e.message || e.error_description || e.details)) || String(e || "Unknown error");
  if (/row-level security|permission denied|not allowed|42501/i.test(m)) return "You do not have permission for this action.";
  if (/ai_contacts_phone_e164_key/.test(m)) return "Another contact already has this phone number.";
  if (/ai_leads_one_open_per_contact/.test(m)) return "This contact already has an open lead.";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Network problem — check your connection and try again. Nothing was lost.";
  return m;
}

/**
 * Runs a Supabase query and throws on error. For updates/deletes, pass expectRows so a silent
 * RLS refusal (0 rows changed) is reported instead of looking like success.
 */
export async function q(promise, { expectRows = false } = {}) {
  const { data, error, count } = await promise;
  if (error) throw error;
  if (expectRows && (!data || (Array.isArray(data) && data.length === 0))) throw new Error("permission denied: nothing was changed");
  return count !== undefined && count !== null && !data ? count : data;
}

/** Wraps a button action with a busy state and success / error feedback. */
export async function act(btn, fn, okMsg) {
  if (btn && btn.disabled) return;
  const label = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin" aria-hidden="true"></span> ' + (btn.dataset.busy || "Saving…"); }
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    console.error(e);
    toast(errText(e), "err");
    return undefined;
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; }
  }
}

/* ---------- forms & drafts (prevent data loss) ---------- */
const DKEY = (k) => "sales:draft:" + k;
export function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") o[el.name] = el.checked;
    else if (el.type === "number") o[el.name] = el.value === "" ? null : Number(el.value);
    else o[el.name] = el.value.trim() === "" ? null : el.value.trim();
  }
  return o;
}
function fill(form, o) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in o)) continue;
    if (el.type === "checkbox") el.checked = !!o[el.name];
    else el.value = o[el.name] ?? "";
  }
}
/** Keeps unsaved edits in sessionStorage so switching tabs, modals or pages never loses them. */
export function guardForm(form, key) {
  if (!form) return;
  form.dataset.draftKey = key;
  try {
    const d = sessionStorage.getItem(DKEY(key));
    if (d) { fill(form, JSON.parse(d)); form.classList.add("has-draft"); markDirty(true); }
  } catch { /* storage unavailable: drafts are a convenience only */ }
  const save = () => { try { sessionStorage.setItem(DKEY(key), JSON.stringify(formData(form))); } catch { /* ignore */ } form.classList.add("has-draft"); markDirty(true); };
  form.addEventListener("input", save);
  form.addEventListener("change", save);
}
export function clearDraft(form) {
  if (!form) return;
  try { sessionStorage.removeItem(DKEY(form.dataset.draftKey)); } catch { /* ignore */ }
  form.classList.remove("has-draft");
  markDirty($$("form.has-draft").length > 0);
}
export function discardDraft(form) { clearDraft(form); }
export function markDirty(v) { S.dirty = v; }
export function hasUnsaved() { return $$("form.has-draft").length > 0; }

/* ---------- modal ---------- */
export function modal(title, bodyHtml, { wide = false } = {}) {
  const dlg = document.createElement("dialog");
  dlg.className = "modal" + (wide ? " wide" : "");
  dlg.innerHTML = `<div class="m-head"><h3>${esc(title)}</h3><button class="icon" data-close aria-label="Close">✕</button></div><div class="m-body">${bodyHtml}</div>`;
  document.body.appendChild(dlg);
  const close = () => {
    const f = dlg.querySelector("form.has-draft");
    if (f && !confirm("Close and keep your unsaved draft for later? (Cancel to stay)")) return;
    dlg.close(); dlg.remove();
  };
  dlg.querySelector("[data-close]").onclick = close;
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dlg.showModal();
  dlg.done = () => { dlg.close(); dlg.remove(); };
  return dlg;
}

export function badge(text, kind = "") { return `<span class="badge ${esc(kind)}">${esc(text)}</span>`; }
export const TEMP_LABEL = { hot: "Hot", warm: "Warm", nurture: "Nurture", unqualified: "Unqualified" };
export const tempBadge = (t) => badge(TEMP_LABEL[t] || t || "—", "t-" + (t || "none"));
export const opt = (v, label, sel) => `<option value="${attr(v)}"${String(sel ?? "") === String(v) ? " selected" : ""}>${esc(label)}</option>`;
export const empty = (msg) => `<div class="empty">${esc(msg)}</div>`;
export const ro = (min) => (can(min) ? "" : " disabled title=\"Your role cannot change this\"");

/** Server API call with the signed-in user's token. */
export async function api(path, init = {}) {
  const { data: { session } } = await SB.auth.getSession();
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", authorization: "Bearer " + (session?.access_token || ""), ...(init.headers || {}) } });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok) throw new Error((body && body.error) || "Server error " + r.status);
  return body;
}

/* ---------- shared lookups ---------- */
export async function loadLookups() {
  const [settings, stages, sources, campaigns, team, projects] = await Promise.all([
    q(SB.from("ai_settings").select("*").eq("id", 1).maybeSingle()),
    q(SB.from("ai_pipeline_stages").select("*").order("position")),
    q(SB.from("ai_lead_sources").select("*").order("name")),
    q(SB.from("ai_campaigns").select("*").order("created_at", { ascending: false })),
    q(SB.from("ai_team_members").select("*").order("email")),
    q(SB.from("projects").select("id,slug,published,data,updated_at")),
  ]);
  S.settings = settings;
  S.stages = stages || [];
  S.sources = sources || [];
  S.campaigns = campaigns || [];
  S.team = team || [];
  S.projects = (projects || []).map((p) => ({ id: p.id, slug: p.slug, published: p.published, name: (p.data && p.data.n) || p.id, area: p.data && p.data.l, data: p.data || {} }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const flag = (k) => !!(S.settings && S.settings.flags && S.settings.flags[k]);
