// AI Sales dashboard — WhatsApp inbox in three panels: conversations (search, filters, last message, who is
// handling), the conversation itself (the same view as the lead workspace, so there is one history) and the
// client beside it (AI summary, next action, key facts, quick links into the lead workspace).
import { SB, S, can, $, $$, esc, attr, fmtDate, ago, q, badge, empty, keepPlace, projectName, flag, tempBadge } from "./core.js";
import { contactName, ownership, thread } from "./crm.js";
import { showValue } from "../shared/profile.mjs";
import { icon } from "./icons.js";

const FILTERS = { all: "All", unread: "Unread", person: "Waiting for a person", ai: "AI handling", human: "A person handling" };
const stageChip = (id) => { const s = S.stages.find((x) => x.id === id); return s ? `<span class="stage-chip c-${attr(s.color || "slate")}">${esc(s.name)}</span>` : ""; };
const preview = (m) => !m ? "" : (m.direction === "inbound" ? "" : m.sender_type === "ai" ? "AI: " : m.sender_type === "system" ? "Auto: " : "You: ") + (m.body || (m.media || []).map((x) => "[" + x.type + "]").join(" ") || "");

export async function inbox(el, params) {
  const sel = params.get("c") || "", f = FILTERS[params.get("f")] ? params.get("f") : "all", needle = (params.get("q") || "").trim().toLowerCase();
  const rows = (await q(SB.from("ai_conversations").select("*, contact:ai_contacts(full_name,phone_e164,wa_id), lead:ai_leads(id,lead_code,ai_paused,closed_at,stage_id,handover_status,temperature,primary_project_id,owner_email,qualification,profile,ai_summary)")
    .eq("status", "open").order("last_inbound_at", { ascending: false, nullsFirst: false }).limit(200))) || [];
  // the latest message of each conversation, for the preview line
  const ids = rows.map((c) => c.id);
  const msgs = ids.length ? (await q(SB.from("ai_messages").select("conversation_id,direction,sender_type,body,media,created_at").in("conversation_id", ids).order("created_at", { ascending: false }).limit(1500)).catch(() => [])) || [] : [];
  const last = {};
  for (const m of msgs) if (!last[m.conversation_id]) last[m.conversation_id] = m;
  let pending = new Set();
  try { pending = new Set(((await q(SB.from("ai_automation_jobs").select("conversation_id").eq("status", "scheduled").eq("kind", "smart_follow_up").limit(500))) || []).map((j) => j.conversation_id)); } catch { /* not installed yet */ }

  const human = (c) => c.mode !== "ai" || c.lead?.ai_paused;
  const count = { all: rows.length, unread: rows.filter((c) => c.unread_count).length, person: rows.filter((c) => c.lead?.handover_status === "requested").length,
    ai: rows.filter((c) => !human(c)).length, human: rows.filter(human).length };
  const shown = rows.filter((c) => (f === "all" || (f === "unread" && c.unread_count) || (f === "person" && c.lead?.handover_status === "requested") || (f === "ai" && !human(c)) || (f === "human" && human(c)))
    && (!needle || [contactName(c.contact), c.contact?.phone_e164, c.lead?.lead_code, last[c.id]?.body].some((v) => String(v || "").toLowerCase().includes(needle))));
  const cur = rows.find((c) => c.id === sel);

  el.innerHTML = `<div class="page-head"><h1>WhatsApp inbox</h1><p class="sub">${rows.length} open conversation${rows.length === 1 ? "" : "s"}${count.unread ? ` · ${count.unread} unread` : ""}</p></div>
  ${flag("whatsapp_outbound") ? "" : `<div class="card notice"><div><b>WhatsApp sending is off.</b> Messages from buyers still arrive here once WhatsApp is connected (Integrations), but nothing is sent until an owner switches on "WhatsApp sending" in Settings → Feature switches.</div></div>`}
  <div class="ibx inbox${sel ? " has-thread" : ""}">
    <section class="ibx-list card">
      <form class="ibx-search" id="ibxq" role="search"><label class="sr" for="ibxqi">Search conversations</label>${icon("search", { size: 16 })}<input id="ibxqi" name="q" type="search" value="${attr(needle)}" placeholder="Search name, phone, code, message"></form>
      <div class="ibx-f">${Object.entries(FILTERS).map(([k, v]) => `<a class="${f === k ? "on" : ""}" href="#/inbox?${attr(new URLSearchParams({ ...(k !== "all" ? { f: k } : {}), ...(needle ? { q: needle } : {}) }))}">${esc(v)}${count[k] ? ` <b>${count[k]}</b>` : ""}</a>`).join("")}</div>
      <ul class="conv-list">${shown.length ? shown.map((c) => { const [label, kind] = ownership(c, pending.has(c.id)), m = last[c.id];
        return `<li class="${c.id === sel ? "on" : ""}${c.unread_count ? " unread" : ""}"><a href="#/inbox?${attr(new URLSearchParams({ ...(f !== "all" ? { f } : {}), ...(needle ? { q: needle } : {}), c: c.id }))}">
          <span class="av">${esc((contactName(c.contact)[0] || "?").toUpperCase())}</span>
          <span class="cv"><span class="cv-top"><b>${esc(contactName(c.contact))}</b><time>${esc(ago(m?.created_at || c.last_inbound_at || c.created_at))}</time></span>
            <span class="cv-msg">${esc(preview(m).slice(0, 90)) || "&nbsp;"}</span>
            <span class="cv-tags">${badge(label, kind)}${c.lead?.handover_status === "requested" ? badge("Needs a person", "alert") : ""}${stageChip(c.lead?.stage_id)}</span></span>
          ${c.unread_count ? `<span class="cnt">${esc(c.unread_count)}</span>` : ""}</a></li>`; }).join("") : `<li>${empty(rows.length ? "No conversations match." : "No WhatsApp conversations yet.")}</li>`}</ul>
    </section>
    <section class="thread card" id="thread">${sel ? "" : `<div class="ibx-empty">${icon("inbox", { size: 34 })}<p>Choose a conversation.</p></div>`}</section>
    <aside class="ibx-ctx" id="ibxctx">${cur?.lead ? contextHtml(cur) : ""}</aside>
  </div>`;
  const form = $("#ibxq", el);
  form.onsubmit = (e) => { e.preventDefault(); location.hash = "#/inbox?" + new URLSearchParams({ ...(f !== "all" ? { f } : {}), ...(form.q.value.trim() ? { q: form.q.value.trim() } : {}) }); };
  if (sel) await thread($("#thread", el), cur, pending.has(sel), () => keepPlace(el, () => inbox(el, params)));
}

/** The client beside the conversation: what the AI knows and what to do next, with links into the workspace. */
function contextHtml(c) {
  const l = c.lead, s = l.ai_summary || {}, qf = l.qualification || {}, pf = l.profile || {}, na = s.next_action;
  const facts = [
    ["Main property", l.primary_project_id ? projectName(l.primary_project_id) : ""],
    ["Budget", [qf.budget_min, qf.budget_max].filter(Boolean).map((v) => "RM" + Number(v).toLocaleString("en-MY")).join(" – ")],
    ["Purpose", showValue("purpose", qf.purpose)], ["Unit", qf.bedrooms ? qf.bedrooms + " bedrooms" : ""],
    ["Lives in", pf.residential_area || ""], ["Works in", pf.work_area || ""], ["Commute", showValue("commute_mode", pf.commute_mode)],
  ].filter(([, v]) => v);
  const ws = `#/lead/${attr(l.id)}`;
  return `<section class="card"><div class="ctx-h"><span class="av lg">${esc((contactName(c.contact)[0] || "?").toUpperCase())}</span><div><b>${esc(contactName(c.contact))}</b><small>${esc(l.lead_code)} · ${esc(l.owner_email || "Unassigned")}</small></div></div>
      <div class="ws-badges">${stageChip(l.stage_id)} ${tempBadge(l.temperature)}</div>
      ${s.text ? `<p class="ctx-sum">${esc(s.text)}</p>` : `<p class="note">No AI summary yet. Open the workspace and press Refresh.</p>`}
      ${s.last_client_question ? `<p class="note">Last question: “${esc(s.last_client_question)}”</p>` : ""}
      ${facts.length ? `<dl class="kvl ctx-kv">${facts.map(([k, v]) => `<div class="kvr"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
      <div class="row-actions"><a class="btn sm pri" href="${ws}">Open lead workspace</a><a class="btn sm" href="${ws}?tab=sales">${icon("calendar", { size: 16 })}Appointment</a></div></section>
    ${na?.status === "open" ? `<section class="card next-act"><h2>${icon("task", { size: 18 })} Next action</h2><p class="na-action">${esc(na.action)}</p>${na.reason ? `<p class="note">${esc(na.reason)}</p>` : ""}
      <p><a class="link" href="${ws}">Act on it in the workspace</a></p></section>` : ""}`;
}
