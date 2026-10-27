// AI Sales dashboard — AI test console: chat as a buyer and see exactly what the AI would do.
// Simulation only: nothing is sent to anyone and no lead is changed.
import { SB, S, can, $, $$, esc, attr, q, api, toast, badge, opt, empty, projectName, errText } from "./core.js";

const KEY = (lead) => "sales:aitest:" + (lead || "new");
const load = (lead) => { try { return JSON.parse(sessionStorage.getItem(KEY(lead)) || "[]"); } catch { return []; } };
const save = (lead, turns) => { try { sessionStorage.setItem(KEY(lead), JSON.stringify(turns.slice(-40))); } catch { /* convenience only */ } };

const SAMPLES = ["Hi, how much is this property?", "Monthly berapa?", "Saya cikgu, boleh check layak LPPSA?", "Cashback betul ke?", "Saya nak datang showroom Sabtu", "Saya takut tak boleh dapat loan", "Boleh bagi discount lagi?", "Bro got unit left or not?", "STOP"];
const DECISION = {
  reply: ["Would send", "ok"], handover: ["Would send + alert a human", "warn"], blocked: ["Draft blocked — safe reply + human alert", "alert"],
  opt_out: ["Opt-out honoured", "warn"], capped: ["Daily AI limit reached — safe reply + human alert", "alert"], paused: ["AI paused — no reply", ""], error: ["AI unavailable — safe reply + human alert", "alert"], ignored: ["Ignored", ""],
};
const REASON = { customer_request: "buyer asked for a person", ready_to_buy: "ready to buy", negotiation: "price negotiation", legal: "legal / contract question", complaint: "complaint", financing: "financing assessment", conflicting_info: "facts missing or conflicting", low_confidence: "AI not confident", sensitive: "sensitive situation", other: "other" };
function actionText(a) {
  switch (a.type) {
    case "record_consent": return `Record ${a.purpose} consent as ${a.status} (${a.channel})`;
    case "pause_ai": return "Pause the AI for this lead";
    case "cancel_follow_ups": return `Cancel scheduled follow-ups (${a.reason})`;
    case "handover": return `Alert a human — ${REASON[a.reason] || a.reason}${a.next_action ? `. Next: ${a.next_action}` : ""}`;
    case "update_qualification": return `Update qualification${a.changed?.length ? ` (${a.changed.join(", ")})` : ""} → score ${a.score} (${a.temperature})`;
    case "add_interest": return `Add interest: ${projectName(a.project_id)}`;
    case "save_financing": return `Save financing figures (${(a.changed || []).join(", ")}) → ${String(a.result?.outcome || "").replace(/_/g, " ")}${a.new_assessment ? " — new assessment recorded" : ""}`;
    case "request_appointment": return `Create appointment request: ${String(a.kind).replace(/_/g, " ")}${a.preferred_text ? `, "${a.preferred_text}"` : ""}${a.project_id ? ` · ${projectName(a.project_id)}` : ""} — pending confirmation`;
    default: return a.type;
  }
}

export async function aitest(el, params) {
  const leads = (await q(SB.from("ai_leads").select("id,lead_code,contact:ai_contacts(full_name)").is("closed_at", null).order("updated_at", { ascending: false }).limit(100))) || [];
  let lead = params.get("lead") || "";
  let turns = load(lead);
  el.innerHTML = `<div class="page-head"><div><h1>AI test console</h1><p class="sub">Chat as a buyer to see what the AI would reply and do.</p></div></div>
  <div class="card notice"><div><b>Simulation.</b> Nothing is sent to anyone and no lead is changed. Each message calls the AI model, which has a small cost.</div></div>
  <section class="card">
    <form class="filters" id="pick"><label class="sr" for="lead">Buyer</label><select id="lead" name="lead">${opt("", "New buyer (no CRM record)", lead)}${leads.map((l) => opt(l.id, `${l.contact?.full_name || "(no name)"} · ${l.lead_code}`, lead)).join("")}</select>
      <button type="button" class="btn" id="reset">Start over</button></form>
    <div class="chat" id="chat" aria-live="polite"></div>
    <div class="samples">${SAMPLES.map((s) => `<button type="button" class="chip" data-s="${attr(s)}">${esc(s)}</button>`).join("")}</div>
    <form id="say" class="say"><label class="sr" for="msg">Buyer message</label><textarea id="msg" rows="2" maxlength="2000" placeholder="Type what a buyer would send on WhatsApp…" required></textarea><button class="btn pri" data-busy="AI is thinking…">Send</button></form>
  </section>`;
  const chat = $("#chat", el), box = $("#msg", el), form = $("#say", el);
  const render = () => {
    chat.innerHTML = turns.length ? turns.map((t) => t.role === "user"
      ? `<div class="msg buyer"><div class="bubble">${esc(t.text)}</div></div>`
      : `<div class="msg ai"><div class="bubble">${esc(t.text || "(no reply)")}</div>${t.r ? detail(t.r) : ""}</div>`).join("")
      : empty("Send a buyer message to start. Pick an existing lead to test with their history, budget and projects of interest.");
    chat.scrollTop = chat.scrollHeight;
  };
  const detail = (r) => {
    const [label, kind] = DECISION[r.decision] || [r.decision, ""];
    return `<div class="why">${badge(label, kind)} <small>${[r.intent, r.agent, r.language, isFinite(r.confidence) ? Math.round(r.confidence * 100) + "% sure" : "", r.model, r.latency_ms ? (r.latency_ms / 1000).toFixed(1) + " s" : ""].filter(Boolean).map(esc).join(" · ")}</small>
      <details><summary>What the AI would do</summary>
        ${r.actions?.length ? `<ul class="list">${r.actions.map((a) => `<li>${esc(actionText(a))}</li>`).join("")}</ul>` : "<p class='note'>No CRM changes.</p>"}
        ${(r.attempts || []).some((a) => a.violations.length) ? `<h4>Business-rule checker</h4>${r.attempts.map((a) => `<p class="note"><b>Draft ${a.attempt}:</b> ${a.violations.length ? a.violations.map((v) => `${esc(v.code)} — ${esc(v.detail)}`).join("<br>") : "passed"}</p>${a.violations.length ? `<pre class="content">${esc(a.reply)}</pre>` : ""}`).join("")}` : "<p class='note'>Business-rule checker: passed.</p>"}
        ${r.facts_used?.length ? `<p class="note">Facts used: ${r.facts_used.map(esc).join(", ")}</p>` : ""}
        ${r.error ? `<p class="note">Error: ${esc(r.error)}</p>` : ""}
      </details></div>`;
  };
  render();
  $("#lead", el).onchange = (e) => { location.hash = "#/ai-test" + (e.target.value ? "?lead=" + e.target.value : ""); };
  $("#reset", el).onclick = () => { turns = []; save(lead, turns); render(); };
  $$("[data-s]", el).forEach((b) => b.onclick = () => { box.value = b.dataset.s; box.focus(); });
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const message = box.value.trim(), btn = form.querySelector("button");
    if (!message || btn.disabled) return;
    const history = turns.map((t) => ({ role: t.role, text: t.text })).filter((t) => t.text);
    turns.push({ role: "user", text: message }); box.value = ""; render();
    btn.disabled = true; const label = btn.innerHTML; btn.innerHTML = '<span class="spin" aria-hidden="true"></span> AI is thinking…';
    try {
      // the loan figures the buyer gave earlier in this simulated chat (nothing is stored for a simulation)
      const financing_inputs = [...turns].reverse().find((t) => t.r?.financing)?.r.financing.inputs || null;
      const r = await api("/api/sales/ai/simulate", { method: "POST", body: JSON.stringify({ lead_id: lead || null, history, message, financing_inputs }) });
      turns.push({ role: "assistant", text: r.reply, r });
    } catch (x) {
      turns.pop(); box.value = message;
      const m = errText(x);
      chat.insertAdjacentHTML("beforeend", `<div class="card error">${/ANTHROPIC_API_KEY|switched off|AI_SALES_ENABLED/.test(m)
        ? `<b>The AI isn't connected yet.</b> In Netlify, set <code>ANTHROPIC_API_KEY</code> and <code>AI_SALES_ENABLED=true</code> (Functions scope), then redeploy. ${esc(m)}`
        : esc(m)}</div>`);
      toast(m, "err");
    } finally { btn.disabled = false; btn.innerHTML = label; save(lead, turns); if (turns.at(-1)?.role === "assistant") render(); }
  };
}
