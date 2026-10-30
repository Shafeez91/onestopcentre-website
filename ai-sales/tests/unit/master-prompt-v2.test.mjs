// Master prompt v2, stages 1–2 (30 Oct 2026): Smart Salutation, language, emojis, adaptive reply style, identity.
// Fake database and scripted AI replies only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressFor, nameGender, parseTitlePreference, fixSalutation, callName } from "../../../sales/shared/salutation.mjs";
import { limitEmojis, countEmojis, emojiAllowance } from "../../../sales/shared/emoji.mjs";
import { respond, applyActions, finalTouches, styleFor, checkTurn, STYLE_ADAPTIVE } from "../../lib/orchestrator.mjs";
import { buildSystemPrompt } from "../../lib/prompt.mjs";

const A = (full_name, extra = {}) => addressFor({ full_name, ...extra });

/* ---------- the master prompt's 13 salutation cases (§4.7) ---------- */
test("1 + 2 · David is never Miss David; Jessica is never Mr Jessica — even when the AI writes it", () => {
  const david = A("David"), jessica = A("Jessica");
  assert.equal(david.en, "Mr David"); assert.equal(david.ms, "Encik David");
  assert.equal(jessica.en, "Ms Jessica"); assert.equal(jessica.ms, "Puan Jessica");
  assert.equal(fixSalutation("Hi Miss David, thanks!", david, "en").text, "Hi Mr David, thanks!");
  assert.equal(fixSalutation("Hi Mrs David", david, "en").text, "Hi Mr David");
  assert.equal(fixSalutation("Hi Mr Jessica, regarding M Mira", jessica, "en").text, "Hi Ms Jessica, regarding M Mira");
  assert.equal(fixSalutation("Salam Encik Jessica", jessica, "ms").text, "Salam Puan Jessica");
  assert.equal(fixSalutation("Hi Miss Jessica", jessica, "en").text, "Hi Ms Jessica", "never Miss automatically");
});

test("3 + 4 · Ahmad → Encik Ahmad, Siti → Puan Siti in Malay (bin / binti also count)", () => {
  assert.equal(A("Ahmad").ms, "Encik Ahmad");
  assert.equal(A("Ahmad bin Ismail").ms, "Encik Ahmad");
  assert.equal(A("Siti").ms, "Puan Siti");
  assert.equal(A("Siti Aminah binti Yusof").ms, "Puan Siti");
  assert.equal(A("Muhammad Hafiz").ms, "Encik Hafiz", "addressed by the name after Muhammad");
  assert.equal(A("Kumar a/l Rajan").en, "Mr Kumar");
});

test("5 + 6 + 7 · Nur, Lee and Alex get a neutral greeting; a wrong title the AI adds is removed", () => {
  for (const n of ["Nur", "Lee", "Alex"]) {
    const a = A(n);
    assert.equal(a.certainty, "uncertain", n);
    assert.equal(a.en, n); assert.equal(a.ms, n);
    assert.deepEqual(a.allowed_titles, []);
  }
  assert.equal(fixSalutation("Hai Encik Lee, terima kasih", A("Lee"), "ms").text, "Hai Lee, terima kasih");
  assert.equal(fixSalutation("Hi Ms Alex", A("Alex"), "en").text, "Hi Alex");
  assert.equal(fixSalutation("Salam Puan Nur", A("Nur"), "ms").text, "Salam Nur");
  // no name at all: Tuan/Puan in Malay
  assert.equal(A(null).ms, "Tuan/Puan");
  assert.equal(A(null).en, null);
  // whole names when unsure, so a given name is not cut in half
  assert.equal(A("Zhi Wei").en, "Zhi Wei");
  assert.equal(A("Lee Mei Ling").en, "Lee Mei Ling");
  assert.equal(A("Fiza💄").en, "Fiza", "emojis in WhatsApp names are ignored");
});

test("8 + 9 · a title the customer chose is kept, whatever the name suggests", () => {
  const mr = A("Alex", { salutation: "Mr", gender: "male", salutation_source: "customer" });
  assert.equal(mr.en, "Mr Alex"); assert.equal(mr.certainty, "confirmed");
  const ms = A("David", { salutation: "Ms", gender: "female", salutation_source: "customer" });
  assert.equal(ms.en, "Ms David", "the customer's choice overrides the name");
  assert.equal(fixSalutation("Hi Mr David", ms, "en").text, "Hi Ms David");
  // from the buyer's own words
  assert.deepEqual(parseTitlePreference("Hi, call me Mr Tan please"), { salutation: "Mr", gender: "male", name: "Tan" });
  assert.deepEqual(parseTitlePreference("boleh panggil saya Puan Aina"), { salutation: "Puan", gender: "female", name: "Aina" });
  assert.deepEqual(parseTitlePreference("just call me David"), { salutation: "none", gender: null, name: "David" });
  assert.equal(A("David", { salutation: "none", salutation_source: "customer" }).en, "David", "name only");
  assert.equal(parseTitlePreference("call me later ya"), null);
  assert.equal(parseTitlePreference("Saya tuan rumah"), null);
  assert.equal(parseTitlePreference("call me tomorrow"), null, "a call request, not a name");
});

test("10 · an advisor's change applies at once and overrides name recognition (a title typed before today counts too)", () => {
  assert.equal(A("David", { gender: "unknown", salutation_source: "advisor" }).en, "David");
  assert.equal(A("Jessica", { salutation: "Dr", salutation_source: "advisor" }).en, "Dr Jessica");
  assert.equal(A("Sam", { gender: "female", salutation_source: "advisor" }).ms, "Puan Sam");
  assert.equal(A("Jessica", { salutation: "Cik" }).ms, "Cik Jessica", "legacy typed salutation = advisor's");
  // name recognition never sets a confirmed source
  assert.equal(A("David").source, "name_recognition");
  assert.equal(nameGender("Eugene Tay Yi Hao").gender, "male");
  assert.equal(nameGender("Tan Wei Ming").confidence, "uncertain");
});

test("11 + 12 + 13 · the address follows the reply language; one form per conversation in the prompt", () => {
  const david = A("David");
  assert.equal(fixSalutation("Salam Mr David", david, "ms").text, "Salam Mr David", "Mr is allowed for a male in Manglish");
  assert.equal(fixSalutation("Hi Encik David", david, "en").text, "Hi Encik David", "Encik is allowed too: no wrong gender");
  const sys = buildSystemPrompt({ persona: { name: "Hafiz_Ai" } });
  assert.match(sys, /use_in_english \/ use_in_malay are the exact words to use/);
  assert.match(sys, /keep to one form in a conversation \(never Mr in one message and Encik in the next\)/);
  assert.match(sys, /Never use "Miss" or "Mrs" unless it is the confirmed choice/);
  assert.match(sys, /Do not ask about gender/);
  assert.equal(callName("Ahmad Faizal Abdullah"), "Ahmad");
});

/* ---------- the reply pipeline ---------- */
const NOW = new Date("2026-10-30T09:00:00Z");
function db(contact = { full_name: "David Lim" }) {
  const t = {
    ai_settings: [{ id: 1, persona: { name: "Hafiz_Ai", reply_style: "adaptive" }, ai: { confidence_threshold: 0.7 }, business: {}, scoring: {}, compliance: {} }],
    projects: [{ id: "mm", slug: "m-mira", data: { n: "M MIRA", l: "Wangsa Maju", types: [{ name: "Type A", price: "RM476,000" }] } }],
    ai_leads: [{ id: "L1", lead_code: "OSC-1", contact: { id: "c1", preferred_language: "en", ...contact }, qualification: {}, profile: {}, profile_meta: {}, ai_summary: {} }],
    ai_pipeline_stages: [], ai_appointments: [],
  };
  return { get: async (p) => structuredClone(t[p.split("?")[0]] || []), rpc: async () => [], post: async () => [{}], patch: async () => null };
}
const draft = (messages, o = {}) => ({ messages, language: "en", intent: "project_info", agent: "knowledge", confidence: 0.9, facts_used: [], qualification_updates: {}, appointment_request: { wanted: false }, handover: { needed: false }, objection_key: "", workflow: {}, ...o });
const llmOf = (data) => { const calls = []; const f = async (p) => { calls.push(p); return { data, model: "m", usage: {} }; }; f.calls = calls; return f; };
const ctxOf = (call) => JSON.parse(call.messages.at(-1).content.match(/<verified_context>\s*([\s\S]*?)\s*<\/verified_context>/)[1]);

test("respond(): the AI gets the address; a wrong title in its draft is corrected before sending", async () => {
  const llm = llmOf(draft(["Hi Miss David, M MIRA starts from RM476,000 (indicative)."]));
  const r = await respond({ db: db(), llm, leadId: "L1", message: "How much is M Mira?", history: [{ role: "assistant", text: "Hi, I'm Hafiz_Ai, an AI assistant." }], now: NOW, mode: "simulate" });
  assert.deepEqual(ctxOf(llm.calls[0]).buyer.address, { use_in_english: "Mr David", use_in_malay: "Encik David", certainty: "high" });
  assert.equal(r.messages[0], "Hi Mr David, M MIRA starts from RM476,000 (indicative).");
  assert.ok(r.adjustments.some((a) => /Miss David → Mr David/.test(a)));
});

test("respond(): a buyer who says how to be called is addressed that way in the same reply and it is saved as theirs", async () => {
  const llm = llmOf(draft(["Noted, Mr David! M MIRA is in Wangsa Maju."]));
  const r = await respond({ db: db({ full_name: "David Lim" }), llm, leadId: "L1", message: "Please call me Ms David", history: [{ role: "assistant", text: "Hi, I'm Hafiz_Ai, an AI assistant." }], now: NOW, mode: "simulate" });
  assert.equal(ctxOf(llm.calls[0]).buyer.address.certainty, "confirmed");
  assert.equal(ctxOf(llm.calls[0]).buyer.address.use_in_english, "Ms David");
  assert.equal(r.messages[0], "Noted, Ms David! M MIRA is in Wangsa Maju.");
  const act = r.actions.find((a) => a.type === "set_salutation");
  assert.deepEqual(act, { type: "set_salutation", salutation: "Ms", gender: "female" });
  // saved as the customer's choice; before migration 20 only the title is saved
  const patches = [];
  await applyActions({ patch: async (p, b) => patches.push(b), post: async () => [], get: async () => [] }, { leadId: "L1", contactId: "c1", result: { actions: [act] } });
  assert.deepEqual(patches[0], { salutation: "Ms", gender: "female", salutation_source: "customer", salutation_confidence: "confirmed" });
  const old = [];
  await applyActions({ patch: async (p, b) => { old.push(b); if (old.length === 1) throw new Error("column gender does not exist"); }, post: async () => [], get: async () => [] }, { leadId: "L1", contactId: "c1", result: { actions: [act] } });
  assert.deepEqual(old[1], { salutation: "Ms" });
});

/* ---------- emojis ---------- */
test("emojis: at most one per reply, none in serious replies; counted across the messages of a turn", () => {
  assert.deepEqual(limitEmojis(["Hai! 😊 M Mira dari RM476,000 👍", "Nak saya kira? 😇🙏"]).messages, ["Hai! 😊 M Mira dari RM476,000", "Nak saya kira?"]);
  assert.equal(countEmojis("👨‍👩‍👧 ok ❤️ 👍🏽"), 3, "joined and skin-tone emojis count once each");
  assert.equal(emojiAllowance({ intent: "price" }), 1);
  for (const intent of ["complaint", "legal_or_contract", "negotiation", "opt_out", "human_request", "instalment"]) assert.equal(emojiAllowance({ intent }), 0, intent);
  assert.equal(emojiAllowance({ decision: "handover" }), 0);
  assert.equal(emojiAllowance({ objectionKey: "price_too_high" }), 0);
  assert.equal(emojiAllowance({ financing: true }), 0);
  const f = finalTouches(["Faham 😔, saya bantu semak 🙏"], { data: { intent: "complaint" }, ctx: {} });
  assert.deepEqual(f.messages, ["Faham, saya bantu semak"]);
  assert.match(f.adjustments[0], /2 removed \(at most 0/);
  // a message that was only emojis is dropped, never sent empty
  assert.deepEqual(finalTouches(["Boleh 😊", "👍👍"], { data: { intent: "greeting" }, ctx: {} }).messages, ["Boleh 😊"]);
});

test("emojis in a live reply: a greeting keeps one, a hand-over keeps none", async () => {
  const r = await respond({ db: db(), llm: llmOf(draft(["Hi Mr David 😊😊 I'm Hafiz_Ai, Hafizan Hanis's AI assistant 🙌"], { intent: "greeting" })), leadId: "L1", message: "hi", now: NOW, mode: "simulate" });
  assert.equal(countEmojis(r.messages.join(" ")), 1);
  const h = await respond({ db: db(), llm: llmOf(draft(["Saya faham 🙏 advisor akan hubungi 😊"], { intent: "complaint", handover: { needed: true, reason: "complaint", summary: "s", next_action: "n" } })), leadId: "L1", message: "Saya tak puas hati", now: NOW, mode: "simulate" });
  assert.equal(countEmojis(h.messages.join(" ")), 0);
});

/* ---------- adaptive style and identity ---------- */
test("adaptive reply style: 20–60 words guide, up to ~100 per turn; selectable; the prompt uses the ANSWER → EXPLAIN → PERSONALISE → ENGAGE section", () => {
  assert.equal(styleFor({ reply_style: "adaptive" }), STYLE_ADAPTIVE);
  assert.notEqual(styleFor({ reply_style: "short" }), STYLE_ADAPTIVE);
  const long = Array(70).fill("kata").join(" ");
  assert.ok(checkTurn({ reply: long, messages: [long] }, { style: STYLE_ADAPTIVE }).violations.some((v) => v.code === "long_message"));
  const ok = Array(45).fill("kata").join(" ");
  assert.ok(!checkTurn({ reply: ok, messages: [ok] }, { style: STYLE_ADAPTIVE }).violations.some((v) => ["long_message", "long_turn"].includes(v.code)));
  const sys = buildSystemPrompt({ persona: { name: "Hafiz_Ai", reply_style: "adaptive" } });
  assert.match(sys, /ANSWER → EXPLAIN → PERSONALISE → ENGAGE/);
  assert.match(sys, /usually 20–60 words in all/);
  assert.doesNotMatch(sys, /aim for 7–10 words/);
});

test("identity: Hafizan Hanis's AI assistant with his credentials (12 years, 500+); never claims to be him; emoji and sales guidance present", () => {
  const sys = buildSystemPrompt({ persona: { name: "Hafiz_Ai", tone: "OWNER PERSONA TEXT" } });
  assert.match(sys, /You are Hafiz_Ai, the AI assistant of Hafizan Hanis/);
  assert.match(sys, /12 years of experience/);
  assert.match(sys, /more than 500 purchasers/);
  assert.match(sys, /never claim to be human or to be Hafizan Hanis himself/);
  assert.match(sys, /These are Hafizan Hanis's credentials, not yours/);
  assert.match(sys, /at most one in a whole reply, often none/);
  assert.match(sys, /Urgency only when it is verified/);
  assert.match(sys, /Avoid stock phrases such as "Are you interested\?"/);
  assert.match(sys, /OWNER PERSONA TEXT/, "the owner's persona text is still included");
  // the owner can change the advisor and credentials in Settings
  const other = buildSystemPrompt({ persona: { name: "X", advisor_name: "Aina Rahman", advisor_credentials: "8 years in KL" } });
  assert.match(other, /AI assistant of Aina Rahman/); assert.match(other, /8 years in KL/);
});

test("guard: \"call me Mr Tan\" / \"just call me David\" is a naming preference, not a request for a phone call; real call requests still go to a person", async () => {
  const { wantsHuman } = await import("../../../sales/shared/guard.mjs");
  for (const t of ["call me Mr Tan", "Please call me Ms David", "just call me David", "panggil saya Puan Aina"]) assert.equal(wantsHuman(t), false, t);
  for (const t of ["call me", "Can you call me?", "call me tomorrow", "call me later pls", "boleh hubungi saya", "telefon saya esok", "nak cakap dengan agent"]) assert.equal(wantsHuman(t), true, t);
});
