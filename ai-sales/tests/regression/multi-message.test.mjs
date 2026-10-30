// One AI turn can be 1–3 separate WhatsApp messages (29 Oct 2026). Before this, the reply schema had a single
// `reply` string, so the model folded the persona's "message 1 / message 2" into one long text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REPLY_SCHEMA, REPLY_SCHEMA_CORE, normalizeReply, replyMessages, buildSystemPrompt, MAX_MESSAGES } from "../../lib/prompt.mjs";
import { respond, checkTurn } from "../../lib/orchestrator.mjs";

const NOW = new Date("2026-10-29T03:00:00Z");
function fakeDb() {
  const t = { ai_settings: [{ id: 1, persona: { name: "OSC Property Assistant", tone: "6A. ELITE WHATSAPP REPLY STYLE — MESSAGE 1 … MESSAGE 2 …" }, ai: { confidence_threshold: 0.7, max_reply_chars: 120 }, business: {}, scoring: {}, compliance: {} }],
    projects: [{ id: "mm", slug: "m-mira", data: { n: "M MIRA", l: "Wangsa Maju", types: [{ name: "Type A", price: "RM476,000" }] } }],
    ai_leads: [], ai_lead_interests: [], ai_appointments: [], ai_project_facts: [], ai_project_prices: [], ai_project_units: [], ai_active_promotions: [] };
  const writes = [];
  return { writes, get: async (p) => structuredClone(t[p.split("?")[0]] || []), rpc: async () => [], post: async (p, b) => { writes.push(b); return [{ id: "r" }]; }, patch: async (p, b) => { writes.push(b); } };
}
const base = { language: "ms", intent: "project_info", agent: "knowledge", confidence: 0.9, facts_used: [],
  qualification_updates: { purpose: "", first_home: "", bedrooms: "", size_sqft: "", budget_min: 0, budget_max: 0, employment: "", financing: "", timeline_months: 0, readiness: "", concerns: "", preferred_project_id: "", asked_price: false, requested_brochure: false },
  appointment_request: { wanted: false, kind: "", preferred_text: "", project_id: "", slot_id: "" }, handover: { needed: false, reason: "", summary: "", next_action: "" }, objection_key: "" };
const llmOf = (...d) => { const calls = []; const fn = async (p) => { calls.push(p); return { data: d[Math.min(calls.length - 1, d.length - 1)], model: "m", usage: {} }; }; fn.calls = calls; return fn; };
const AI = "Hai, saya OSC Property Assistant, pembantu AI.";

test("schema: a list of messages replaces the single reply (also in the core schema used for follow-ups)", () => {
  for (const s of [REPLY_SCHEMA, REPLY_SCHEMA_CORE]) {
    assert.equal(s.properties.messages.type, "array");
    assert.equal(s.properties.messages.items.type, "string");
    assert.ok(s.required.includes("messages") && !("reply" in s.properties));
  }
});

test("messages are cleaned, never split by us, and capped at three without losing text", () => {
  assert.deepEqual(replyMessages({ messages: [" A ", "", "B"] }), ["A", "B"]);
  assert.deepEqual(replyMessages({ reply: "Para 1\n\nPara 2" }), ["Para 1\n\nPara 2"], "older single replies: one message, paragraphs untouched");
  assert.deepEqual(replyMessages({ messages: ["1", "2", "3", "4"] }), ["1", "2", "3\n\n4"]);
  assert.equal(MAX_MESSAGES, 3);
  const n = normalizeReply({ messages: ["A", "B"] });
  assert.deepEqual([n.messages, n.reply], [["A", "B"], "A\n\nB"]);
});

test("the instructions explain separate messages vs paragraphs, keep the persona, and default to one", () => {
  const sys = buildSystemPrompt({ persona: { name: "X", tone: "6A. ELITE WHATSAPP REPLY STYLE" } }, []);
  assert.match(sys, /6A\. ELITE WHATSAPP REPLY STYLE/, "the owner's persona text is kept as is");
  assert.match(sys, /WhatsApp messages \(the "messages" list\)/);
  assert.match(sys, /A blank line inside a message is a paragraph, not a new message/);
  assert.match(sys, /A simple question gets one message/);
  assert.match(sys, /message 1 = the direct answer and its essential explanation; message 2 = the additional useful detail/);
  assert.match(sys, /at most 3 short paragraphs, and prefer 1–2/);
  assert.match(sys, /A third message is rare/);
  assert.match(sys, /Hand-overs, opt-outs, complaints.*one message/);
  assert.match(sys, /at most one question per turn/);
});

test("business rules: content rules run on the whole turn; the length limit is per message", () => {
  const w = (n) => "kata ".repeat(n).trim(); // n words, 5n-1 characters
  const ok = checkTurn(normalizeReply({ messages: [w(20), w(20)] }), { maxChars: 120 });
  assert.equal(ok.ok, true, "two messages of 99 characters are fine with a 120 limit");
  const long = checkTurn(normalizeReply({ messages: [w(20), w(26)] }), { maxChars: 120 });
  assert.deepEqual(long.violations.map((v) => v.code), ["too_long"]);
  assert.match(long.violations[0].detail, /Message 2 is 129 characters/);
});

test("respond(): a normal reply keeps the model's separate messages; a simple question stays one", async () => {
  let r = await respond({ db: fakeDb(), llm: llmOf({ ...base, messages: [AI + " Stesen paling dekat: LRT Sri Rampai.", "Tuan/puan kerja di mana?"] }), message: "MRT paling dekat kat mana?", now: NOW, mode: "simulate" });
  assert.equal(r.decision, "reply");
  assert.deepEqual(r.messages, [AI + " Stesen paling dekat: LRT Sri Rampai.", "Tuan/puan kerja di mana?"]);
  assert.equal(r.reply, r.messages.join("\n\n"));
  r = await respond({ db: fakeDb(), llm: llmOf({ ...base, messages: [AI + " Harga dari RM476,000."] }), message: "Hi, how much is this property?", now: NOW });
  assert.equal(r.messages.length, 1);
});

test("respond(): blocked drafts, hand-overs, opt-outs and outages are always one message", async () => {
  const two = { ...base, messages: [AI + " Unit ada lagi!", "Harga RM399,000 sahaja!"] }; // an unverified price → blocked after retry
  let r = await respond({ db: fakeDb(), llm: llmOf(two, two), message: "unit ada?", now: NOW });
  assert.equal(r.decision, "blocked"); assert.equal(r.messages.length, 1);
  r = await respond({ db: fakeDb(), llm: llmOf({ ...base, messages: [AI + " Baik.", "Penasihat akan hubungi."], handover: { needed: true, reason: "negotiation", summary: "s", next_action: "n" } }), message: "boleh diskaun?", now: NOW });
  assert.equal(r.decision, "handover"); assert.deepEqual(r.messages, [AI + " Baik.\n\nPenasihat akan hubungi."]);
  r = await respond({ db: fakeDb(), llm: llmOf(base), message: "STOP", now: NOW });
  assert.equal(r.messages.length, 1);
  r = await respond({ db: fakeDb(), llm: async () => { throw Object.assign(new Error("down"), { kind: "unavailable" }); }, message: "harga?", now: NOW });
  assert.equal(r.decision, "error"); assert.equal(r.messages.length, 1);
});

test("simulation writes nothing, whatever the number of messages", async () => {
  const db = fakeDb();
  await respond({ db, llm: llmOf({ ...base, messages: [AI + " A.", "B?"] }), message: "MRT paling dekat?", now: NOW, mode: "simulate" });
  assert.deepEqual(db.writes, []);
});

/* ---------- 29 Oct 2026, from the AI log: a stray "x" message and Type B's price given for Type C ---------- */
import { layoutPriceMixups, layoutKey } from "../../../sales/shared/validator.mjs";
const AZ = [{ project: "M AZURA", layouts: [{ key: "a", prices: [380000] }, { key: "b", prices: [480000] }, { key: "c", prices: [570000] }] },
  { project: "M NOVA", layouts: [{ key: "a", prices: [350000] }, { key: "b", prices: [430000] }, { key: "c", prices: [480000] }] }];

test("fragments: a stray 'x' message (or an empty-looking reply) is rejected and rewritten", () => {
  const bad = checkTurn(normalizeReply({ messages: ["M AZURA Type C: 1,000 sqft, 4 bilik, 2 bilik air.", "x"] }), {});
  assert.deepEqual(bad.violations.map((v) => v.code), ["fragment"]);
  assert.match(bad.violations[0].detail, /Message 2 \("x"\)/);
  assert.equal(checkTurn(normalizeReply({ messages: ["…"] }), {}).violations[0].code, "fragment");
  assert.equal(checkTurn(normalizeReply({ messages: ["Baik 😊"] }), {}).ok, true, "a short one-message reply is fine");
  assert.equal(checkTurn(normalizeReply({ messages: ["Type C ada 4 bilik dan 2 bilik air.", "Tuan/puan nak lihat pelan lantai?"] }), {}).ok, true);
});

test("layout prices: Type B's price given for Type C is caught; correct lists, mixed sentences and other projects are not", () => {
  assert.deepEqual(layoutPriceMixups("M AZURA Type C: 1,000 sqft, 4 bilik, 2 bilik air, 2 car park, harga dari RM480,000...", AZ), ["RM480,000 is the price of another layout, not of Type C"]);
  assert.deepEqual(layoutPriceMixups("• Type A – 700 sqft, from RM380,000\n• Type B – 850 sqft, from RM480,000\n• Type C – 1000 sqft, from RM570,000", AZ), []);
  assert.deepEqual(layoutPriceMixups("Untuk M AZURA Type C (dari RM570,000), ansuran sekitar RM2,406 sebulan.", AZ), [], "monthly figures are not layout prices");
  assert.deepEqual(layoutPriceMixups("M NOVA Type C from RM480,000.", AZ), [], "the right price for that project's Type C");
  assert.deepEqual(layoutPriceMixups("Type B and Type C from RM480,000 and RM570,000.", AZ), [], "a sentence naming both layouts");
  assert.deepEqual(layoutPriceMixups("Type D from RM480,000", AZ), [], "a layout with no price on record: left to the other rules");
  assert.deepEqual([layoutKey("Type C"), layoutKey("Jenis A1"), layoutKey("C")], ["c", "a1", "c"]);
});

test("respond(): the layout-price rule sees the real context (focus project's layouts) and blocks the mix-up", async () => {
  const db = { get: async (p) => (p.startsWith("projects") ? [{ id: "az", slug: "m-azura", data: { n: "M AZURA", l: "Setapak", types: [{ name: "Type A", price: "RM380,000" }, { name: "Type B", price: "RM480,000" }, { name: "Type C", price: "RM570,000" }] } }]
    : p.startsWith("ai_settings") ? [{ id: 1, persona: {}, ai: { confidence_threshold: 0.7 }, business: {}, scoring: {}, compliance: {} }] : []), rpc: async () => [], post: async () => [{}], patch: async () => null };
  const wrong = { ...base, messages: [AI + " M AZURA Type C: 1,000 sqft, 4 bilik, harga dari RM480,000 (anggaran)."] };
  const right = { ...base, messages: [AI + " M AZURA Type C: 1,000 sqft, 4 bilik, harga dari RM570,000 (anggaran)."] };
  const llm = llmOf(wrong, right);
  const r = await respond({ db, llm, message: "Saya berminat dgn M Azura type C", now: NOW, mode: "simulate" });
  assert.equal(r.attempts[0].violations[0].code, "wrong_layout_price");
  assert.match(llm.calls[1].messages.at(-1).content, /wrong_layout_price/, "the AI is told what to fix");
  assert.equal(r.decision, "reply");
  assert.match(r.reply, /RM570,000/);
});

/* ---------- readability (29 Oct 2026): at most 3 short paragraphs, short lists, about 20–60 words per message ---------- */
import { messageStyle, STYLE } from "../../lib/orchestrator.mjs";
// the two messages sent to a real buyer at 14:31 (Malaysia time)
const JUN_1 = "Ni perbandingan 2 bilik (ilustrasi 100% pembiayaan bank, 3.65%, 35 tahun):\n\n• M AURORA Type B (737 sqft, freehold): dari RM430,000, ansuran ~RM1,815 + maintenance ~RM243 = ~RM2,058 sebulan.\n• M AZURA Type A (700 sqft, leasehold 99 thn): dari RM380,000, ansuran ~RM1,604 + maintenance ~RM231 = ~RM1,835 sebulan.\n\nHarga anggaran dari website, final disahkan masa booking. Ini ilustrasi, bukan tawaran loan.";
const JUN_2 = "Pakej yang sama untuk kedua-dua projek: booking RM500, legal fee SPA & LA free oleh Mah Sing, dan kalau dapat 100% loan dari harga website, tak perlu fikir deposit. Cuma MOT stamp duty ditanggung pembeli, boleh settle kemudian. Bumiputera biasanya dapat 5% diskaun untuk projek di KL.\n\nM AURORA partially furnished (aircond, kabinet dapur, hob & hood, water heater). Status furnishing M AZURA sedang disahkan semula oleh advisor.\n\nNak saya buat semakan kelayakan loan ringkas untuk tuan/puan?";
// the owner's example of the wanted style
const WANT_1 = "Based on the illustrative figures, M Azura Type A has a lower estimated monthly commitment than M Aurora Type B.\n\n• M Azura: approximately RM1,835/month, including estimated maintenance.\n• M Aurora: approximately RM2,058/month, including estimated maintenance.\n\nThese estimates depend on the actual financing terms and verified project costs.";
const WANT_2 = "M Aurora is freehold, while M Azura is leasehold. We should also compare the layout, location and total ownership costs before deciding.\n\nAre you buying for own stay or investment?";

test("readability: the owner's example passes; the long real message is flagged; limits are 3 paragraphs / 40 words / 5 bullets / 65 words", () => {
  assert.deepEqual(STYLE, { maxParagraphs: 3, maxParagraphWords: 40, maxBullets: 5, maxMessageWords: 65, maxTurnWords: 80 });
  assert.deepEqual(messageStyle(WANT_1), []);
  assert.deepEqual(messageStyle(WANT_2), []);
  assert.deepEqual(messageStyle(JUN_1), [], "a compact comparison with two bullets is fine");
  assert.deepEqual(messageStyle(JUN_2, 2).map((v) => v.code), ["long_paragraph", "long_message"]);
  assert.match(messageStyle(JUN_2, 2)[0].detail, /Message 2, paragraph 1 is 46 words/);
  assert.deepEqual(messageStyle("A.\n\nB.\n\nC.\n\nD.").map((v) => v.code), ["too_many_paragraphs"]);
  assert.deepEqual(messageStyle("Pilihan:\n• 1\n• 2\n• 3\n• 4\n• 5\n• 6").map((v) => v.code), ["long_list"]);
  assert.deepEqual(messageStyle("Harga dari RM570,000."), [], "a short answer");
});

test("readability problems are rewritten once and never block a reply; business-rule problems still do", async () => {
  // too long first, a shorter rewrite second
  const long = { ...base, messages: [AI + " " + "Ini maklumat projek yang panjang. ".repeat(14).trim()] };
  const short = { ...base, messages: [AI + " M MIRA di Wangsa Maju, dekat LRT Sri Rampai."] };
  let llm = llmOf(long, short);
  let r = await respond({ db: fakeDb(), llm, message: "info M Mira?", now: NOW });
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].messages.at(-1).content, /long_message|long_paragraph/, "the AI is told what to shorten");
  assert.equal(r.decision, "reply"); assert.deepEqual(r.messages, short.messages); assert.deepEqual(r.style_notes, []);
  // still too long after the rewrite: sent anyway (not the safe fallback), with the note recorded
  llm = llmOf(long, long);
  r = await respond({ db: fakeDb(), llm, message: "info M Mira?", now: NOW });
  assert.equal(r.decision, "reply");
  assert.deepEqual(r.messages, long.messages);
  assert.ok(r.style_notes.some((v) => v.code === "long_message"));
  // a business-rule problem that persists still blocks
  const bad = { ...base, messages: [AI + " Loan confirm lulus!"] };
  r = await respond({ db: fakeDb(), llm: llmOf(bad, bad), message: "loan lulus?", now: NOW });
  assert.equal(r.decision, "blocked");
});

test("guarantee rule: 'penjamin' (guarantor / co-applicant) is not a promise; 'dijamin lulus' still is (3 live replies were blocked by this)", async () => {
  const { validateReply } = await import("../../../sales/shared/validator.mjs");
  // the real drafts of 29 Oct 2026 (joint loan question) that were blocked
  for (const t of ["Boleh, permohonan bersama memang antara cara untuk naikkan kelayakan. Cuma gaji minimum yang perlu ditambah bergantung pada polisi bank, umur dan pendapatan penjamin, jadi saya tak nak teka angka.",
    "Joint loan memang boleh bantu, sebab pendapatan penjamin tanpa komitmen akan menambah kelayakan.", "A guarantor (penjamin) may be needed."]) {
    assert.deepEqual(validateReply(t, {}).violations.filter((v) => v.code === "guarantee_language"), [], t);
  }
  for (const t of ["Loan confirm dijamin lulus!", "Saya jamin tuan dapat.", "This is guaranteed approval.", "Kami menjamin keuntungan.", "Ada jaminan untung 10%."]) {
    assert.ok(validateReply(t, {}).violations.some((v) => v.code === "guarantee_language"), t);
  }
});

/* ---------- shorter turns (29 Oct 2026): about 80 words per turn; no monthly instalment the buyer did not ask for ---------- */
import { MONTHLY_Q } from "../../lib/orchestrator.mjs";
const codes = (msgs, rules = {}) => checkTurn({ messages: msgs, reply: msgs.join("\n\n") }, rules).styleNotes.map((v) => v.code);
// live replies of 29 Oct 2026, after the 3-paragraph update
const MIRA_PRICE = ["Hi! I'm Hafiz_Ai, an AI assistant for One Stop Centre 😊\n\nM MIRA (Wangsa Maju) starts from around RM476,000. Indicative prices by layout:\n• Type A – 800 sqft, 3R2B: from RM476,000\n• Type B – 900 sqft, 4R2B: from RM533,000\n• Type C – 1050 sqft, 5R3B: from RM629,000\n\nFinal price is confirmed at booking.",
  "As an illustration, Type A works out to roughly RM2,009/month (100% financing, 3.65%, 35 years), plus about RM304 maintenance. Not a loan offer, just a rough guide.\n\nIs this for your own stay or investment? 😊"];
const PRICE_GOOD = ["Hi! I'm Hafiz_Ai, an AI assistant for One Stop Centre 😊\n\nOur Mah Sing projects in KL start from around RM339,000 (M AURORA, Old Klang Road) up to RM629,000, depending on project and layout. Final price is confirmed at booking.",
  "Which area or project are you interested in? I can share the exact layouts and prices 😊"];
const MONTHLY_ANSWER = ["Untuk M AZURA Type C (dari RM570,000), anggaran ansuran sekitar RM2,406 sebulan (100% pembiayaan bank, 3.65% setahun, 35 tahun). Campur maintenance ~RM330, jumlahnya sekitar RM2,736 sebulan.\n\nIni ilustrasi sahaja, bukan tawaran loan."];

test("turn length: the whole turn is about 80 words at most; bullet marks are not words", () => {
  assert.deepEqual(codes(PRICE_GOOD), [], "a short price answer and one question");
  assert.ok(codes(MIRA_PRICE).includes("long_turn"), "price list + monthly example + question is too long for 'how much'");
  assert.match(checkTurn({ messages: MIRA_PRICE }, {}).styleNotes.find((v) => v.code === "long_turn").detail, /across 2 messages/);
  assert.deepEqual(messageStyle("• Type A – from RM476,000"), []);
  const w40 = "kata ".repeat(40).trim();
  assert.ok(!codes(["• – " + w40, "• – " + w40]).includes("long_turn"), "80 words plus bullet marks is within the limit");
  assert.ok(codes([w40, w40 + " lagi"]).includes("long_turn"), "81 words is not");
});

test("monthly instalment only when the buyer asked about monthly payments, loans or financing", () => {
  assert.ok(codes(MIRA_PRICE, { buyerAskedMonthly: false }).includes("unasked_instalment"), "'how much' answered with RM2,009/month");
  assert.ok(!codes(MIRA_PRICE, { buyerAskedMonthly: true }).includes("unasked_instalment"));
  assert.ok(!codes(MONTHLY_ANSWER, {}).includes("unasked_instalment"), "not checked where the buyer's words are unknown (follow-ups)");
  assert.deepEqual(codes(MONTHLY_ANSWER, { buyerAskedMonthly: true }), []);
  assert.deepEqual(codes(PRICE_GOOD, { buyerAskedMonthly: false }), [], "prices alone are fine");
  assert.deepEqual(codes(["M AZURA dari RM380,000. Maintenance RM0.33 psf."], { buyerAskedMonthly: false }), [], "a price per sqft is not an instalment");
  for (const q of ["Monthly berapa?", "can share Type B monthly?", "ansuran type C?", "Kalau joint loan dengan family", "gaji saya 5k layak tak", "Bank loan", "LPPSA boleh?"]) assert.ok(MONTHLY_Q.test(q), q);
  for (const q of ["How much is M Mira", "Boleh tahu harga M Mira?", "sy kerja kat Bangsar", "Hi bang"]) assert.ok(!MONTHLY_Q.test(q), q);
});

test("respond(): a 'how much' reply with an unasked monthly figure is rewritten once without it; asking 'monthly?' keeps it", async () => {
  const long = { ...base, messages: [AI + " M MIRA dari RM476,000 (anggaran).", "Type A ansuran ~RM2,009 sebulan (100%, 3.65%, 35 tahun). Ini ilustrasi, bukan tawaran loan.\n\nUntuk duduk sendiri atau pelaburan?"] };
  const short = { ...base, messages: [AI + " M MIRA dari RM476,000 (anggaran), harga akhir disahkan masa booking.", "Untuk duduk sendiri atau pelaburan?"] };
  let llm = llmOf(long, short);
  let r = await respond({ db: fakeDb(), llm, message: "Boleh tahu harga M Mira?", now: NOW });
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].messages.at(-1).content, /unasked_instalment/);
  assert.deepEqual(r.messages, short.messages);
  llm = llmOf(long, short);
  const noNote = (r) => !r.attempts[0].violations.some((v) => v.code === "unasked_instalment");
  r = await respond({ db: fakeDb(), llm, message: "M Mira monthly berapa?", now: NOW });
  assert.ok(noNote(r), "the buyer asked: the monthly figure is wanted");
  // asked a few messages ago, still in the same topic
  llm = llmOf(long, short);
  r = await respond({ db: fakeDb(), llm, message: "Type A pula?", history: [{ role: "user", text: "M Mira monthly berapa?" }, { role: "assistant", text: "..." }], now: NOW });
  assert.ok(noNote(r));
});

test("prompt: whole-turn limit, price answers without unasked monthly figures, at most 2–3 recommended projects", () => {
  const sys = buildSystemPrompt({}, []);
  assert.match(sys, /whole turn \(all messages together\): at most about 80 words/);
  assert.match(sys, /Price questions: give the price only/);
  assert.match(sys, /No monthly instalment, maintenance or package details unless the buyer asked/);
  assert.match(sys, /Recommendations: at most 2–3 projects/);
});

/* ---------- "Short chat" reply style (owner, 30 Oct 2026): up to 3 one-line messages of about 7–10 words ---------- */
import { STYLE_SHORT, styleFor } from "../../lib/orchestrator.mjs";
const shortCodes = (msgs) => checkTurn({ messages: msgs, reply: msgs.join("\n\n") }, { style: STYLE_SHORT }).styleNotes.map((v) => v.code);

test("short chat: the owner's example passes; a standard-length message is sent back to be shortened", () => {
  assert.equal(styleFor({ reply_style: "short" }), STYLE_SHORT);
  assert.notEqual(styleFor({}), STYLE_SHORT, "standard stays the default");
  assert.deepEqual(shortCodes(["M MIRA bermula dari RM476,000 😊", "Type A, 800 sqft, 3 bilik.", "Nak saya kira anggaran bulanan?"]), []);
  // the AI introduction and a required price note may add words to their message
  assert.deepEqual(shortCodes(["Hi! Saya Hafiz_Ai, pembantu AI One Stop Centre 😊 M MIRA bermula dari RM476,000.", "Harga anggaran, final disahkan masa booking.", "Untuk duduk sendiri atau pelaburan?"]), []);
  // a message of the standard style is too long for short chat
  const long = "M MIRA (Wangsa Maju) starts from around RM476,000 for Type A, 800 sqft with 3 rooms, and Type B is 900 sqft from RM533,000.";
  const notes = checkTurn({ messages: [long] }, { style: STYLE_SHORT }).styleNotes;
  assert.ok(notes.some((v) => v.code === "long_message"));
  assert.match(notes.find((v) => v.code === "long_message").detail, /about 7–10 words .*Move the rest to the next message \(3 at most\)/);
  assert.deepEqual(shortCodes(["Satu dua tiga empat lima enam tujuh lapan sembilan sepuluh sebelas dua belas tiga belas empat belas lima belas enam belas."]), ["long_message"], "16 words: over the 15-word cap");
  // standard style is unchanged: the same long message is fine there
  assert.deepEqual(checkTurn({ messages: [long] }, {}).styleNotes, []);
});

test("short chat: the prompt switches to the short-chat section only when chosen; respond() rewrites a long draft into short lines", async () => {
  const short = buildSystemPrompt({ persona: { reply_style: "short", tone: "6A. ELITE WHATSAPP REPLY STYLE" } }, []);
  assert.match(short, /Message 1: the direct answer to the buyer's question, short and confident/);
  assert.match(short, /aim for 7–10 words, never more than 15/);
  assert.match(short, /6A\. ELITE WHATSAPP REPLY STYLE/, "the owner's persona text is kept");
  assert.doesNotMatch(short, /About 20–60 words per message/);
  const std = buildSystemPrompt({}, []);
  assert.match(std, /About 20–60 words per message/);
  assert.doesNotMatch(std, /7–10 words/);

  const t = { ai_settings: [{ id: 1, persona: { name: "OSC Property Assistant", reply_style: "short" }, ai: { confidence_threshold: 0.7 }, business: {}, scoring: {}, compliance: {} }],
    projects: [{ id: "mm", slug: "m-mira", data: { n: "M MIRA", l: "Wangsa Maju", types: [{ name: "Type A", price: "RM476,000" }] } }] };
  const db = { get: async (p) => structuredClone(t[p.split("?")[0]] || []), rpc: async () => [], post: async () => [{}], patch: async () => null };
  const long = { ...base, messages: [AI + " M MIRA di Wangsa Maju bermula dari anggaran RM476,000 untuk Type A seluas 800 sqft dengan tiga bilik tidur dan dua bilik air."] };
  const ok = { ...base, messages: [AI + " M MIRA bermula RM476,000 😊", "Type A, 800 sqft, 3 bilik.", "Untuk duduk sendiri atau pelaburan?"] };
  const llm = llmOf(long, ok);
  const r = await respond({ db, llm, message: "Berapa harga M Mira?", now: NOW });
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[0].system, /short chat style/);
  assert.match(llm.calls[1].messages.at(-1).content, /long_message.*about 7–10 words/s);
  assert.deepEqual(r.messages, ok.messages);
  assert.equal(r.decision, "reply");
});
