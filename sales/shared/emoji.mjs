// Emoji policy (master prompt v2 rule 7): emojis are used naturally and sparingly, never in serious moments.
// Measured on 30 Oct 2026: 49% of AI messages had at least one emoji. The prompt asks for restraint; this module
// enforces it on the final text: at most one emoji per reply turn, and none in serious replies (hand-overs,
// complaints, legal, negotiation, objections, financing figures, opt-outs).

const EMOJI = /\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic}️?)*/gu;
export const SERIOUS_INTENTS = new Set(["complaint", "legal_or_contract", "negotiation", "opt_out", "human_request", "objection", "instalment"]);

export const countEmojis = (text) => (String(text || "").match(EMOJI) || []).length;

const tidy = (s) => s.replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?;:])/g, "$1").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").trim();

/**
 * Keeps at most `max` emojis across the messages of one turn (the first ones), removing the rest.
 * Returns { messages, removed }.
 */
export function limitEmojis(messages, { max = 1 } = {}) {
  let kept = 0, removed = 0;
  const out = (messages || []).map((m) => tidy(String(m ?? "").replace(EMOJI, (e) => (kept < max ? (kept++, e) : (removed++, "")))));
  return { messages: out, removed };
}

// Settings → AI persona → Emoji level: "none" (never), "light" (warm moments only; the default), "friendly" (one
// fitting emoji on most replies). Every level keeps serious replies emoji-free and allows at most one per reply.
export const EMOJI_LEVELS = ["none", "light", "friendly"];
export const emojiLevel = (persona = {}) => (EMOJI_LEVELS.includes(persona?.emoji_level) ? persona.emoji_level : "light");

/** How many emojis a reply may have: 0 when emojis are off or the reply is serious, otherwise 1. */
export function emojiAllowance({ decision = "reply", intent = null, objectionKey = null, financing = false, level = "light" } = {}) {
  if (level === "none" || decision !== "reply" || objectionKey || financing || SERIOUS_INTENTS.has(intent)) return 0;
  return 1;
}
