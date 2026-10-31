// Discovery steps 1–2 (30 Oct 2026): a WhatsApp profile name is only a guess, the AI asks the name by its second reply
// and area familiarity once a project is discussed, and the buyer's answer is saved straight away.
// Fake database and scripted AI replies only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nameStatus, addressFor } from "../../../sales/shared/salutation.mjs";
import { nextDiscovery, readDiscoveryAnswer, familiarityFrom } from "../../lib/discovery.mjs";
import { respond, applyActions } from "../../lib/orchestrator.mjs";
import { buildSystemPrompt } from "../../lib/prompt.mjs";

const k = (o) => Object.fromEntries(Object.entries(o).map(([key, value]) => [key, { value, status: "confirmed" }]));
const read = (message, lastAiText, buyerName = null, known = {}) => readDiscoveryAnswer({ message, lastAiText, buyerName, known });
const val = (changes, field) => changes.find((c) => c.field === field)?.value ?? null;

test("WhatsApp names: emojis, stylised letters and business names are not used; a clean name is checked once", () => {
  for (const n of ["😁", "ΛMΣ", "ABC Realty Sdn Bhd", "", null]) {
    assert.equal(nameStatus(n).status, "unknown", String(n));
    assert.equal(addressFor({ full_name: n }).ms, "Tuan/Puan", "never addressed by an unusable name");
  }
  assert.deepEqual(nameStatus("Mira Azlan"), { status: "to_confirm", name: "Mira Azlan" });
  assert.deepEqual(nameStatus("nurul88"), { status: "to_confirm", name: "Nurul" });
  assert.equal(nameStatus("Ravi Kumar (RK KLANG)").name, "Ravi", "text in brackets is dropped");
  assert.equal(nameStatus("Faizal Hakim (FH)").name, "Faizal Hakim");
  assert.equal(nameStatus("AMIRA").name, "Amira", "capitals written normally");
  for (const n of ["QX", "aa", "～QX", "Sewa"]) assert.equal(nameStatus(n).status, "unknown", `${n}: initials or a business word`);
  assert.deepEqual(nameStatus("😁", "Ali"), { status: "confirmed", name: "Ali" });
  assert.deepEqual(nameStatus("Mira", "not_disclosed"), { status: "declined", name: null });
  assert.equal(addressFor({ full_name: "Mira" }, { preferredName: "not_disclosed" }).ms, "Tuan/Puan", "not 'Not_disclosed'");
});

test("discovery: a WhatsApp name still needs confirming; the name is asked by the second reply, the area once a project is discussed", () => {
  let r = nextDiscovery({ buyerName: "Mira Azlan", aiReplies: 0 });
  assert.equal(r.next.key, "name");
  assert.match(r.next.ask, /Blh sy panggil Mira Azlan ya\?/);
  assert.equal(r.next.ask_now, undefined, "the first reply may wait (it carries the AI introduction)");
  r = nextDiscovery({ buyerName: "😁", aiReplies: 1 });
  assert.equal(r.next.key, "name");
  assert.match(r.next.ask, /not a usable name/);
  assert.equal(r.next.ask_now, true, "second reply: ask now");
  assert.equal(nextDiscovery({ buyerName: "😁", known: k({ preferred_name: "not_disclosed" }) }).next.key, "area_familiarity", "declined: never asked again");
  r = nextDiscovery({ known: k({ preferred_name: "Ali" }), projectInFocus: true });
  assert.deepEqual([r.next.key, r.next.ask_now], ["area_familiarity", true]);
  assert.equal(nextDiscovery({ known: k({ preferred_name: "Ali" }) }).next.ask_now, undefined, "no project yet: no rush");
  // a showroom question still comes first
  assert.equal(nextDiscovery({ buyerName: "😁", aiReplies: 3, message: "Showroom buka pukul berapa?" }).next.key, "showroom");
});

test("the buyer's answer to the name question is read: a name, a confirmation, a different name, or no thanks", () => {
  assert.equal(val(read("Ali", "Btw, blh sy tahu nama?"), "preferred_name"), "Ali");
  assert.equal(val(read("Saya Ahmad", "May I know your name?", "😁"), "preferred_name"), "Ahmad");
  assert.equal(val(read("nama saya Siti Aminah", ""), "preferred_name"), "Siti Aminah", "a clear 'nama saya' counts any time");
  assert.equal(val(read("panggil saya Encik Ali", ""), "preferred_name"), "Ali", "the title is the salutation, not the name");
  assert.equal(val(read("ya boleh", "Blh sy panggil Mira ya?", "Mira Azlan"), "preferred_name"), "Mira Azlan");
  assert.equal(val(read("boleh, tapi panggil Mila je", "Blh sy panggil Mira ya?", "Mira Azlan"), "preferred_name"), "Mila");
  assert.equal(val(read("tak nak bagi la", "Boleh sy tahu nama?"), "preferred_name"), "not_disclosed");
  // not names
  for (const [m, last] of [["ok", "Boleh sy tahu nama?"], ["saya nak tanya harga", "Boleh tahu nama?"], ["I am interested in M Aria", "May I know your name?"],
    ["How much is it?", "May I know your name?"], ["Saya Ahmad", "Harga dari RM400k. Nak tahu lagi?"], ["nanti panggil saya balik", ""]]) {
    assert.equal(val(read(m, last, "😁"), "preferred_name"), null, m);
  }
  assert.deepEqual(read("Ali", "Boleh sy tahu nama?", "😁", k({ preferred_name: "Abu" })), [], "already known: not changed here");
});

test("the buyer's answer to the area question is read in Malay, English and Manglish", () => {
  const q = "Dah biasa dgn area Setapak, atau nk sy share sikit pasal kawasan sekeliling?";
  assert.equal(val(read("sy kerja kat situ", q), "area_familiarity"), "very_familiar");
  assert.equal(val(read("ya selalu lalu", q), "area_familiarity"), "familiar");
  assert.equal(val(read("tak biasa sangat", q), "area_familiarity"), "somewhat");
  assert.equal(val(read("sikit2 je", q), "area_familiarity"), "somewhat");
  assert.equal(val(read("tak tahu kawasan tu", q), "area_familiarity"), "not_familiar");
  assert.equal(val(read("no, first time", "Are you familiar with the area?"), "area_familiarity"), "not_familiar");
  assert.equal(val(read("harga brp?", q), "area_familiarity"), null, "not an answer");
  assert.equal(val(read("ya", "Harga dari RM400k. Nak brochure?"), "area_familiarity"), null, "the AI did not ask about the area");
  assert.equal(familiarityFrom("I live nearby"), "very_familiar");
});

/* ---------- the reply pipeline ---------- */
const NOW = new Date("2026-10-30T09:00:00Z");
function db(contact, profile = {}) {
  const t = {
    ai_settings: [{ id: 1, persona: { name: "Hafiz_Ai", reply_style: "adaptive" }, ai: { confidence_threshold: 0.7 }, business: {}, scoring: {}, compliance: {} }],
    projects: [{ id: "mm", slug: "m-mira", data: { n: "M MIRA", l: "Wangsa Maju", types: [{ name: "Type A", price: "RM476,000" }] } }],
    ai_leads: [{ id: "L1", lead_code: "OSC-1", contact: { id: "c1", preferred_language: "ms", ...contact }, qualification: {}, profile, profile_meta: {}, ai_summary: {} }],
    ai_pipeline_stages: [], ai_appointments: [],
  };
  return { get: async (p) => structuredClone(t[p.split("?")[0]] || []), rpc: async () => [], post: async () => [{}], patch: async () => null };
}
const draft = (messages, o = {}) => ({ messages, language: "ms", intent: "project_info", agent: "knowledge", confidence: 0.9, facts_used: [], qualification_updates: {}, appointment_request: { wanted: false }, handover: { needed: false }, objection_key: "", workflow: {}, ...o });
const llmOf = (data) => { const calls = []; const f = async (p) => { calls.push(p); return { data, model: "m", usage: {} }; }; f.calls = calls; return f; };
const ctxOf = (call) => JSON.parse(call.messages.at(-1).content.match(/<verified_context>\s*([\s\S]*?)\s*<\/verified_context>/)[1]);
const intro = { role: "assistant", text: "Hi, saya Hafiz_Ai, pembantu AI Hafizan Hanis. Btw, blh sy tahu nama? Senang sy nk address dgn betul." };

test("respond(): an emoji WhatsApp name is not used and the AI is told to ask the name now", async () => {
  const llm = llmOf(draft(["M MIRA dari RM476,000. Btw, blh sy tahu nama?"]));
  await respond({ db: db({ full_name: "😁" }), llm, leadId: "L1", message: "Harga M Mira?", history: [{ role: "user", text: "hi" }, { role: "assistant", text: "Hi, saya Hafiz_Ai, pembantu AI Hafizan Hanis." }], now: NOW, mode: "simulate" });
  const c = ctxOf(llm.calls[0]);
  assert.equal(c.buyer.name_status, "unknown");
  assert.equal(c.buyer.address.use_in_malay, "Tuan/Puan");
  assert.deepEqual([c.discovery.next.key, c.discovery.next.ask_now], ["name", true]);
});

test("respond(): the name the buyer just gave is used in this reply, saved at once, and not asked again", async () => {
  const llm = llmOf(draft(["Terima kasih Ahmad! M MIRA terletak di Wangsa Maju."]));
  const r = await respond({ db: db({ full_name: "😁" }), llm, leadId: "L1", message: "Ahmad", history: [{ role: "user", text: "hi" }, intro], now: NOW, mode: "simulate" });
  const c = ctxOf(llm.calls[0]);
  assert.equal(c.buyer.name_status, "confirmed");
  assert.equal(c.buyer.address.use_in_malay, "Encik Ahmad");
  assert.notEqual(c.discovery.next.key, "name");
  const act = r.actions.find((a) => a.type === "set_profile");
  assert.deepEqual(act.changes, [{ field: "preferred_name", value: "Ahmad", status: "confirmed" }]);
  // saved through the profile function (an advisor's entry is never overwritten there; the AI's goes in the history)
  const calls = [];
  await applyActions({ rpc: async (fn, args) => { calls.push([fn, args]); return {}; }, patch: async () => null, post: async () => [], get: async () => [] }, { leadId: "L1", contactId: "c1", messageId: "m9", result: { actions: [act] } });
  assert.deepEqual(calls[0], ["ai_lead_profile_set", { p_lead: "L1", p_changes: act.changes, p_source: "ai", p_message: "m9" }]);
  // a failing save never stops the rest
  const done = await applyActions({ rpc: async () => { throw new Error("db down"); }, patch: async () => null, post: async () => [], get: async () => [] }, { leadId: "L1", contactId: "c1", result: { actions: [act, { type: "set_language", language: "ms" }] } });
  assert.deepEqual([...done], ["set_language"]);
});

test("respond(): the buyer says how well they know the area: saved, and the AI moves on to purpose", async () => {
  const llm = llmOf(draft(["Faham, sy share sikit pasal kawasan Wangsa Maju."]));
  const r = await respond({ db: db({ full_name: "Ali" }, { preferred_name: "Ali" }), llm, leadId: "L1", message: "tak biasa sgt, first time dengar",
    history: [{ role: "user", text: "M Mira kat mana?" }, { role: "assistant", text: "M MIRA di Wangsa Maju. Ali dah biasa dgn area tu, atau nk sy share sikit pasal kawasan sekeliling?" }], now: NOW, mode: "simulate" });
  assert.deepEqual(r.actions.find((a) => a.type === "set_profile").changes, [{ field: "area_familiarity", value: "not_familiar", status: "confirmed" }]);
  assert.equal(ctxOf(llm.calls[0]).discovery.next.key, "purpose");
});

test("prompt: the name statuses and ask_now are explained to the AI", () => {
  const sys = buildSystemPrompt({ persona: { name: "Hafiz_Ai" } });
  assert.match(sys, /buyer\.name_status/);
  assert.match(sys, /Blh sy panggil Aina ya\?/);
  assert.match(sys, /never address them by the WhatsApp name/);
  assert.match(sys, /discovery\.next\.ask_now/);
});

test("\"tak ada nama\" after the name question is a polite decline: never asked again", () => {
  for (const m of ["Saya tak ada nama", "takde nama", "no name pls"]) assert.equal(val(read(m, "Btw, blh sy tahu nama?", "😁"), "preferred_name"), "not_disclosed", m);
});

test("emojis: a greeting that only names the topics (\"harga, lokasi dan pembiayaan\") keeps its smiley; real financing figures get none", async () => {
  const { financingReply } = await import("../../lib/orchestrator.mjs");
  assert.equal(financingReply("greeting", ["Sy blh bantu dgn harga, lokasi dan pembiayaan."]), false);
  assert.equal(financingReply("project_info", ["Harga dari RM476,000."]), false);
  assert.equal(financingReply("project_info", ["Anggaran ansuran RM2,100 sebulan."]), true);
  assert.equal(financingReply("financing", ["Boleh, sy kira."]), true);
  const llm = llmOf(draft(["Waalaikumussalam. Saya Hafiz_Ai, pembantu AI Hafizan Hanis 😊\n\nSy blh bantu dgn harga, lokasi dan pembiayaan."], { intent: "greeting" }));
  const r = await respond({ db: db({ full_name: "😁" }), llm, leadId: "L1", message: "Assalamualaikum..", now: NOW, mode: "simulate" });
  assert.match(r.messages[0], /😊/);
  assert.match(buildSystemPrompt({ persona: { name: "Hafiz_Ai" } }), /In warm moments .* add one that fits/);
});

test("respond(): \"Hi saya Mr Zan\" saves the title and the name, and the name is not asked again", async () => {
  const llm = llmOf(draft(["Hi Mr Zan! Saya Hafiz_Ai, pembantu AI Hafizan Hanis."], { intent: "greeting" }));
  const r = await respond({ db: db({ full_name: "😁" }), llm, leadId: "L1", message: "Hi saya Mr Zan", now: NOW, mode: "simulate" });
  const c = ctxOf(llm.calls[0]);
  assert.equal(c.buyer.address.use_in_malay, "Mr Zan");
  assert.equal(c.buyer.name_status, "confirmed");
  assert.notEqual(c.discovery.next?.key, "name");
  assert.deepEqual(r.actions.find((a) => a.type === "set_salutation"), { type: "set_salutation", salutation: "Mr", gender: "male" });
  assert.deepEqual(r.actions.find((a) => a.type === "set_profile").changes, [{ field: "preferred_name", value: "Zan", status: "confirmed" }]);
});

test("short forms mirror the buyer: full words until the buyer writes short forms", async () => {
  const { SHORT_FORMS } = await import("../../lib/orchestrator.mjs");
  for (const t of ["Hi saya Mr Zan", "Kalau sewa bilik, mana lagi untung?", "Saya nak tanya harga", "Box ada tak?"]) assert.equal(SHORT_FORMS.test(t), false, t);
  for (const t of ["Mana margin lg untung?", "blh share layout?", "tq", "btw ada promo?", "sy nk tgk unit", "x pe"]) assert.equal(SHORT_FORMS.test(t), true, t);
  const llm = llmOf(draft(["Hi Mr Zan! Saya Hafiz_Ai, pembantu AI Hafizan Hanis."], { intent: "greeting" }));
  await respond({ db: db({ full_name: "Ali" }), llm, leadId: "L1", message: "Hi saya Mr Zan", now: NOW, mode: "simulate" });
  assert.deepEqual(ctxOf(llm.calls[0]).buyer_writing, { uses_short_forms: false });
  const llm2 = llmOf(draft(["Blh, sy share layout."]));
  await respond({ db: db({ full_name: "Ali" }), llm: llm2, leadId: "L1", message: "blh share layout?", history: [{ role: "user", text: "hi" }, { role: "assistant", text: "Hi, saya Hafiz_Ai, pembantu AI Hafizan Hanis." }], now: NOW, mode: "simulate" });
  assert.deepEqual(ctxOf(llm2.calls[0]).buyer_writing, { uses_short_forms: true });
  assert.match(buildSystemPrompt({ persona: { name: "Hafiz_Ai" } }), /while uses_short_forms is false, including your first reply, write full words/);
});

test("31 Oct: \"Saya hantar e-pamphlet M AZURA sekarang\" with no file chosen gets the project's brochure attached, also on a hand-over", async () => {
  const { promisesFile } = await import("../../lib/orchestrator.mjs");
  assert.equal(promisesFile(["Saya hantar e-pamphlet M AZURA sekarang."]), true);
  assert.equal(promisesFile(["I'm sending you the M Mira brochure now."]), true);
  assert.equal(promisesFile(["Kalau nak, sy blh hantar brochure?"]), false);
  assert.equal(promisesFile(["Nak saya hantar e-pamphlet?"]), false);
  assert.equal(promisesFile(["M AZURA ada 3 layout."]), false);
  const t = {
    ai_settings: [{ id: 1, persona: { name: "Hafiz_Ai" }, ai: { confidence_threshold: 0.7 }, business: {}, scoring: {}, compliance: {} }],
    projects: [{ id: "az", slug: "azura", data: { n: "M AZURA", l: "Setapak", types: [{ name: "Type A", price: "RM380,000" }] } }],
    ai_documents: [{ id: "d1", title: "M_AZURA_ePamphlet.pdf", kind: "brochure", project_id: "az", mime_type: "application/pdf", size_bytes: 1000 }],
    ai_leads: [{ id: "L1", lead_code: "OSC-1", contact: { id: "c1", full_name: "Shafiq", preferred_language: "ms" }, qualification: {}, profile: { preferred_name: "Shafiq" }, profile_meta: {}, ai_summary: {} }],
    ai_pipeline_stages: [], ai_appointments: [],
  };
  const fdb = { get: async (p) => structuredClone(t[p.split("?")[0]] || []), rpc: async () => [], post: async () => [{}], patch: async () => null };
  const handover = draft(["Untuk M AZURA, ketersediaan unit akan disahkan oleh penasihat kami. Saya hantar e-pamphlet M AZURA sekarang."], { intent: "availability", handover: { needed: true, reason: "other", summary: "s", next_action: "n" } });
  const r = await respond({ db: fdb, llm: llmOf(handover), leadId: "L1", message: "Nak tahu pasal azura, masih ada unit ke?", history: [{ role: "user", text: "Salam" }, { role: "assistant", text: "Waalaikumussalam. Saya Hafiz_Ai, pembantu AI Hafizan Hanis." }], now: NOW, mode: "simulate" });
  assert.equal(r.decision, "handover");
  assert.deepEqual(r.actions.filter((a) => a.type === "send_file").map((a) => a.document_id), ["d1"]);
});
