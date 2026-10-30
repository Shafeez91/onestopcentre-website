// Settings → AI persona → Emoji level (30 Oct 2026): none / light (default) / friendly. Every level: at most one emoji
// per reply and none in serious replies. Fake database and scripted AI replies only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emojiAllowance, emojiLevel } from "../../../sales/shared/emoji.mjs";
import { respond } from "../../lib/orchestrator.mjs";
import { buildSystemPrompt } from "../../lib/prompt.mjs";

test("the level: light by default (and for anything unknown); none removes every emoji; serious replies never get one", () => {
  assert.equal(emojiLevel({}), "light");
  assert.equal(emojiLevel({ emoji_level: "loud" }), "light");
  assert.equal(emojiLevel({ emoji_level: "friendly" }), "friendly");
  assert.equal(emojiAllowance({ intent: "price", level: "friendly" }), 1);
  assert.equal(emojiAllowance({ intent: "price", level: "none" }), 0);
  for (const level of ["light", "friendly"]) {
    assert.equal(emojiAllowance({ intent: "complaint", level }), 0);
    assert.equal(emojiAllowance({ intent: "price", financing: true, level }), 0);
    assert.equal(emojiAllowance({ decision: "handover", level }), 0);
    assert.equal(emojiAllowance({ objectionKey: "too_expensive", level }), 0);
  }
});

test("the prompt tells the AI the chosen level", () => {
  const sys = (emoji_level) => buildSystemPrompt({ persona: { name: "Hafiz_Ai", emoji_level } });
  assert.match(sys("friendly"), /Friendly emoji style: end most replies with one emoji that fits/);
  assert.match(sys(undefined), /In warm moments .* add one that fits/);
  assert.match(sys("none"), /Do not use emojis at all\./);
  for (const l of ["none", "light", "friendly"]) assert.match(sys(l), /No emojis in serious moments/);
});

const NOW = new Date("2026-10-30T09:00:00Z");
const db = (emoji_level) => {
  const t = {
    ai_settings: [{ id: 1, persona: { name: "Hafiz_Ai", reply_style: "adaptive", emoji_level }, ai: { confidence_threshold: 0.7 }, business: {}, scoring: {}, compliance: {} }],
    projects: [{ id: "mm", slug: "m-mira", data: { n: "M MIRA", l: "Wangsa Maju", types: [{ name: "Type A", price: "RM476,000" }] } }],
    ai_leads: [{ id: "L1", lead_code: "OSC-1", contact: { id: "c1", full_name: "Ali", preferred_language: "ms" }, qualification: {}, profile: { preferred_name: "Ali" }, profile_meta: {}, ai_summary: {} }],
    ai_pipeline_stages: [], ai_appointments: [],
  };
  return { get: async (p) => structuredClone(t[p.split("?")[0]] || []), rpc: async () => [], post: async () => [{}], patch: async () => null };
};
const llmOf = (messages, intent = "price") => async () => ({ data: { messages, language: "ms", intent, agent: "knowledge", confidence: 0.9, facts_used: [], qualification_updates: {}, appointment_request: { wanted: false }, handover: { needed: false }, objection_key: "", workflow: {} }, model: "m", usage: {} });
const history = [{ role: "user", text: "hi" }, { role: "assistant", text: "Hi, saya Hafiz_Ai, pembantu AI Hafizan Hanis." }];

test("respond(): friendly keeps one emoji on a plain price answer; none removes it; extra ones are always trimmed", async () => {
  const reply = ["M MIRA Type A dari RM476,000 🏡😊"];
  const f = await respond({ db: db("friendly"), llm: llmOf(reply), leadId: "L1", message: "Harga M Mira?", history, now: NOW, mode: "simulate" });
  assert.equal(f.messages[0], "M MIRA Type A dari RM476,000 🏡");
  const n = await respond({ db: db("none"), llm: llmOf(reply), leadId: "L1", message: "Harga M Mira?", history, now: NOW, mode: "simulate" });
  assert.equal(n.messages[0], "M MIRA Type A dari RM476,000");
  const c = await respond({ db: db("friendly"), llm: llmOf(["Maaf atas kesulitan 😔 advisor akan hubungi."], "complaint"), leadId: "L1", message: "Sy tak puas hati", history, now: NOW, mode: "simulate" });
  assert.doesNotMatch(c.messages.join(" "), /😔/, "a complaint gets none, even on friendly");
});

test("a maintenance fee or a rent a month is not a financing figure; a removed emoji that ended a sentence leaves a full stop", async () => {
  const { financingReply } = await import("../../lib/orchestrator.mjs");
  const { limitEmojis } = await import("../../../sales/shared/emoji.mjs");
  assert.equal(financingReply("qualification", ["Holding cost: maintenance anggaran RM0.33 psf, contohnya Type A sekitar RM183 sebulan."]), false);
  assert.equal(financingReply("comparison", ["Type E: RM3,500 sebulan sewa bilik, gross yield 7.2%"]), false);
  assert.equal(financingReply("project_info", ["Anggaran ansuran RM2,100 sebulan."]), true);
  assert.deepEqual(limitEmojis(["Faham, utk investment 👍 Sbg info, M AURORA freehold."], { max: 0 }).messages, ["Faham, utk investment. Sbg info, M AURORA freehold."]);
  assert.deepEqual(limitEmojis(["Terima kasih 🙏"], { max: 0 }).messages, ["Terima kasih"]);
});
