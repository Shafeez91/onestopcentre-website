// AI Sales dashboard — AI test console: chat as a buyer and see exactly what the AI would do.
// Simulation only: nothing is sent to anyone and no lead is changed.
import { SB, S, can, $, $$, esc, attr, q, api, toast, badge, opt, empty, projectName, errText } from "./core.js";

const KEY = (lead) => "sales:aitest:" + (lead || "new");
const load = (lead) => { try { return JSON.parse(sessionStorage.getItem(KEY(lead)) || "[]"); } catch { return []; } };
const save = (lead, turns) => { try { sessionStorage.setItem(KEY(lead), JSON.stringify(turns.slice(-40))); } catch { /* convenience only */ } };

const SAMPLES = ["Hi, how much is this property?", "Monthly berapa?", "Saya cikgu, boleh check layak LPPSA?", "Cashback betul ke?", "Saya nak datang showroom Sabtu", "Saya takut tak boleh dapat loan", "Boleh bagi discount lagi?", "Bro got unit left or not?", "STOP"];
const DECISION = {
  reply: ["AI reply — would send", "ok"], handover: ["AI reply + alert a human", "warn"], blocked: ["Draft blocked by business rules — safe reply + human alert", "alert"],
  opt_out: ["Opt-out honoured", "warn"], capped: ["Daily AI limit reached — safe reply + human alert", "alert"], paused: ["AI paused — no reply", ""], ignored: ["Ignored", ""],
};
// decision "error": the model gave no answer, so the reply is the fixed safe reply. Say which kind of failure it was.
const FAILURE = {
  unavailable: "AI service busy or down", network: "AI service unreachable", auth: "AI key rejected — check ANTHROPIC_API_KEY",
  schema: "AI request refused (system setup)", rejected: "AI request refused (system setup)", truncated: "AI reply cut off", bad_response: "AI reply unreadable",
  refusal: "AI declined this message", timeout: "AI took too long — stopped before the 30-second limit",
};
// a failed request: say what happened in plain words (the dashboard's own wording for a gateway timeout is just "Server error 504")
function requestError(x) {
  const m = errText(x);
  if (/\b(504|502)\b/.test(m) && /Server error/.test(m)) return "The AI took longer than the 30-second limit and the request was stopped. Your message is kept below — press Send to try again.";
  return m;
}
const STEP = { research: "Checking outside sources…", redraft: "Rewriting with what was found…" };
const LANG = { en: "English", ms: "Bahasa Malaysia", mixed: "Mixed / Manglish" };
const pretty = (s) => String(s || "").replace(/_/g, " ");
function outcome(r) {
  if (r.decision === "error") return [`${FAILURE[r.errorKind] || "AI could not answer"} — fixed safe reply + human alert`, "alert"];
  const h = (r.actions || []).find((a) => a.type === "handover");
  if (r.decision === "handover" && h?.reason === "conflicting_info") return ["AI reply — information not on record, advisor alerted", "warn"];
  return DECISION[r.decision] || [r.decision, ""];
}
const REASON = { customer_request: "buyer asked for a person", ready_to_buy: "ready to buy", negotiation: "price negotiation", legal: "legal / contract question", complaint: "complaint", financing: "financing assessment", conflicting_info: "facts missing or conflicting", low_confidence: "AI not confident", sensitive: "sensitive situation", other: "other" };
function actionText(a) {
  switch (a.type) {
    case "record_consent": return `Record ${a.purpose} consent as ${a.status} (${a.channel})`;
    case "pause_ai": return "Pause the AI for this lead";
    case "cancel_follow_ups": return `Cancel scheduled follow-ups (${a.reason})`;
    case "handover": return `Alert a human — ${REASON[a.reason] || a.reason}${a.next_action ? `. Next: ${a.next_action}` : ""}`;
    case "update_qualification": return `Update qualification${a.changed?.length ? ` (${a.changed.join(", ")})` : ""} → score ${a.score} (${a.temperature})`;
    case "add_interest": return `Add interest: ${projectName(a.project_id)}`;
    case "set_language": return `Remember the buyer's language: ${LANG[a.language] || a.language}`;
    case "insights": return "Update the client profile / summary from this message";
    case "send_file": return `Send file after the reply: ${a.title}${a.project_id ? ` (${projectName(a.project_id)})` : ""}`;
    case "workflow_enroll": return `Join follow-up workflow ${a.workflow}`;
    case "workflow_advance": return `Move workflow ${a.workflow} past stage ${a.from}`;
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
      : `<div class="msg ai">${bubbles(t)}${t.r ? detail(t.r) : ""}</div>`).join("")
      : empty("Send a buyer message to start. Pick an existing lead to test with their history, budget and projects of interest.");
    chat.scrollTop = chat.scrollHeight;
  };
  // one bubble per WhatsApp message the AI would send in this turn (older saved turns have one text)
  const bubbles = (t) => {
    const list = t.r?.messages?.length ? t.r.messages : [t.text || "(no reply)"];
    if (list.length === 1) return `<div class="bubble">${esc(list[0])}</div>`;
    return `<div class="turn" role="group" aria-label="${list.length} WhatsApp messages from one AI turn">${list.map((m, i) => `<div class="bubble"><span class="part">${i + 1}/${list.length}</span>${esc(m)}</div>`).join("")}</div>`;
  };
  const detail = (r) => {
    const [label, kind] = outcome(r);
    // the model's own 0–1 rating is a self-assessment, not a measured probability; none at all when the model gave no answer
    const rating = r.model && Number.isFinite(r.confidence) ? `AI self-rating ${Math.round(r.confidence * 100)}%` : "Self-rating: not available";
    const h = (r.actions || []).find((a) => a.type === "handover"), rt = r.retrieval;
    const row = (k, v) => (v ? `<div class="kvr"><dt>${esc(k)}</dt><dd>${v}</dd></div>` : "");
    const n = r.messages?.length || (r.reply ? 1 : 0);
    const t = r.timings || {}, sec = (ms) => (ms / 1000).toFixed(1) + " s";
    return `<div class="why">${badge(label, kind)} <small>${[n ? `${n} WhatsApp message${n === 1 ? "" : "s"}` : "", r.intent && pretty(r.intent), LANG[r.language] || r.language, rating, r.model, r.latency_ms ? (r.latency_ms / 1000).toFixed(1) + " s" : "", r.continuation ? "⏳ " + (STEP[r.continuation.step] || "") : ""].filter(Boolean).map(esc).join(" · ")}</small>
      <details><summary>Why the AI did this</summary>
        <dl class="kvl">
          ${row("AI service", r.decision === "error" ? `<span class="late">No answer — ${esc(FAILURE[r.errorKind] || "error")}</span>` : r.model ? `Answered (${esc(r.model)})` : "Not called — fixed rule")}
          ${row("Understood as", esc(pretty(r.intent) || "—") + (r.agent ? ` · ${esc(pretty(r.agent))} step` : ""))}
          ${row("Language", esc(LANG[r.language] || r.language || "—"))}
          ${row("Project", rt ? (rt.focus?.length ? esc(rt.focus.join(", ")) + ` <small>(${esc(rt.focus_source || "")})</small>` : rt.ambiguous ? "Not named yet" : "None") : "")}
          ${row("Not on record", rt && Object.keys(rt.not_on_record || {}).length ? Object.entries(rt.not_on_record).map(([n, f]) => `${esc(n)}: ${f.map((x) => esc(pretty(x))).join(", ")}`).join("<br>") : "")}
          ${row("Conflicting data", rt && Object.keys(rt.conflicts || {}).length ? Object.entries(rt.conflicts).map(([n, f]) => `${esc(n)}: ${f.map((x) => esc(pretty(x))).join(", ")}`).join("<br>") : "")}
          ${row("Sources used", r.facts_used?.length ? r.facts_used.map(esc).join(", ") : r.decision === "error" ? "" : "None cited")}
          ${row("Human alert", h ? esc(REASON[h.reason] || h.reason) + (h.summary ? `<br><small>${esc(String(h.summary).slice(0, 400))}</small>` : "") : "No")}
          ${row("Answer based on", [r.facts_used?.length || r.retrieval?.focus?.length ? "our project data" : "", r.research?.maps?.lookups?.some((l) => l.routes?.length) ? "Google Maps" : "", r.research?.web?.found ? "web research (public information)" : ""].filter(Boolean).join(" + ") || "")}
          ${row("Distance lookups", r.research?.maps ? [
            ...(r.research.maps.lookups || []).map((l) => `<b>${esc(l.project)} → ${esc(l.to || "?")}</b><br>${(l.routes || []).map((x) => `${esc(x.mode)}: ${esc(x.distance || "?")}${x.time ? ` · ${esc(x.time)}` : ""}${x.note ? ` <small>(${esc(x.note)})</small>` : ""}`).join("<br>")}${l.straight_line ? `<br><small>straight line ${esc(l.straight_line)}</small>` : ""}<br><small>Location: ${esc(l.project_location || "not found")} · ${esc(l.source)}${l.checked_at ? `, checked ${esc(l.checked_at)}` : ""}</small>${l.maps_link ? `<br><a href="${attr(l.maps_link)}" target="_blank" rel="noopener">Open in Google Maps ↗</a>` : ""}${(l.not_verified || []).length ? `<br><small class="late">Not verified: ${l.not_verified.map(esc).join("; ")}</small>` : ""}`),
            r.research.maps.ask_for ? `<small>Asks the buyer for: ${esc(r.research.maps.ask_for)}</small>` : "",
            r.research.maps.error ? `<small class="late">${esc(r.research.maps.error)}</small>` : ""].filter(Boolean).join("<br><br>") : "")}
          ${row("Web research", r.research?.web ? `${r.research.web.found ? "Found" : "Nothing verifiable found"}${r.research.web.searches ? ` · ${esc(r.research.web.searches)} search${r.research.web.searches === 1 ? "" : "es"}` : ""}${(r.research.web.sources || []).length ? "<br>" + r.research.web.sources.map((x) => { const u = String(x.url || x); return /^https?:\/\//i.test(u) ? `<a href="${attr(u)}" target="_blank" rel="noopener noreferrer">${esc(x.title || u)}</a>` : esc(u); }).join("<br>") : ""}${r.research.web.error ? `<br><small class="late">${esc(r.research.web.error)}</small>` : ""}` : "")}
          ${row("Status", r.continuation ? `<span class="spin" aria-hidden="true"></span> ${esc(STEP[r.continuation.step] || "Working…")} <small>The reply above is the draft so far.</small>` : r.step_error ? `<span class="late">${esc(r.step_error)}</span> <small>The reply above stands.</small>` : "")}
          ${row("Timing", can("manager") && t.total_ms ? [t.context_ms != null && `data ${sec(t.context_ms)}`, t.maps_ms != null && `maps ${sec(t.maps_ms)}`, (t.ai_ms || []).length && `AI ${t.ai_ms.map(sec).join(" + ")}`, t.web_ms != null && `web ${sec(t.web_ms)}`, `total ${sec(t.total_ms)}`].filter(Boolean).map(esc).join(" · ") + (r.rewrite_skipped ? `<br><small>${esc(r.rewrite_skipped)}</small>` : "") + (r.request_id ? `<br><small>Request ${esc(r.request_id)}</small>` : "") : "")}
          ${row("Readability", r.style_notes?.length ? r.style_notes.map((v) => esc(v.detail)).join("<br>") + "<br><small>Rewritten once; sent as it is (style notes never block a reply).</small>" : "")}
          ${row("Note", r.degraded ? esc(r.degraded) : "")}
          ${row("Error", r.error ? (can("manager") ? esc(r.error) : "Details are visible to managers and owners.") : "")}
        </dl>
        <h4>CRM changes it would make</h4>
        ${r.actions?.length ? `<ul class="list">${r.actions.map((a) => `<li>${esc(actionText(a))}</li>`).join("")}</ul>` : "<p class='note'>None.</p>"}
        ${(r.attempts || []).some((a) => a.violations.length) ? `<h4>Business-rule checker</h4>${r.attempts.map((a) => `<p class="note"><b>Draft ${a.attempt}:</b> ${a.violations.length ? a.violations.map((v) => `${esc(v.code)} — ${esc(v.detail)}`).join("<br>") : "passed"}</p>${a.violations.length ? `<pre class="content">${esc(a.reply)}</pre>` : ""}`).join("")}` : r.attempts?.length ? "<p class='note'>Business-rule checker: passed.</p>" : ""}
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
    // the loan figures the buyer gave earlier in this simulated chat (nothing is stored for a simulation)
    const financing_inputs = [...turns].reverse().find((t) => t.r?.financing)?.r.financing.inputs || null;
    let failed = false;
    const call = (extra = {}) => api("/api/sales/ai/simulate", { method: "POST", body: JSON.stringify({ lead_id: lead || null, history, message, financing_inputs, ...extra }) });
    try {
      let r = await call();
      const turn = { role: "assistant", text: r.reply, r };
      turns.push(turn); render();
      // a reply that needs outside research continues in separate requests (each under the 30-second limit); the
      // draft stays on screen meanwhile, and a failed step keeps it
      while (r.continuation) {
        btn.innerHTML = `<span class="spin" aria-hidden="true"></span> ${esc(STEP[r.continuation.step] || "Working…")}`;
        let n;
        try { n = await call({ continue: r.continuation.token }); }
        catch (x) { r = { ...r, continuation: null, step_error: "Outside research could not finish: " + requestError(x) }; break; }
        if (n.step === "research") {
          r = { ...r, research: { ...(r.research || {}), ...n.research }, timings: { ...(r.timings || {}), web_ms: n.timings?.web_ms }, continuation: n.continuation || null };
        } else {
          r = { ...n, research: { ...(r.research || {}), ...(n.research || {}) }, timings: { ...(n.timings || {}), web_ms: r.timings?.web_ms } };
        }
        Object.assign(turn, { text: r.reply, r }); render();
      }
      Object.assign(turn, { text: r.reply, r });
    } catch (x) {
      // the message goes back in the box (not left as a sent bubble); the chat is redrawn first so the error card stays
      turns.pop(); box.value = message; render();
      const m = requestError(x);
      chat.insertAdjacentHTML("beforeend", `<div class="card error">${/ANTHROPIC_API_KEY|switched off|AI_SALES_ENABLED/.test(m)
        ? `<b>The AI isn't connected yet.</b> In Netlify, set <code>ANTHROPIC_API_KEY</code> and <code>AI_SALES_ENABLED=true</code> (Functions scope), then redeploy. ${esc(m)}`
        : esc(m)}</div>`);
      toast(m, "err");
      failed = true;
    } finally { btn.disabled = false; btn.innerHTML = label; save(lead, turns); if (!failed) render(); }
  };
}
