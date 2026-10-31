// Emoji policy (master prompt v2 rule 7): emojis are used naturally and sparingly, never in serious moments.
// Measured on 30 Oct 2026: 49% of AI messages had at least one emoji. The prompt asks for restraint; this module
// enforces it on the final text: at most one emoji per reply turn, and none in serious replies (hand-overs,
// complaints, legal, negotiation, objections, financing figures, opt-outs).

const EMOJI = /\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic}️?)*/gu;
export const SERIOUS_INTENTS = new Set(["complaint", "legal_or_contract", "negotiation", "opt_out", "human_request", "objection", "instalment"]);

const ALWAYS_SERIOUS = new Set(["complaint", "legal_or_contract", "opt_out", "human_request"]);

export const countEmojis = (text) => (String(text || "").match(EMOJI) || []).length;

const tidy = (s) => s.replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?;:])/g, "$1").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").trim();

/**
 * Keeps at most `max` emojis across the messages of one turn (the first ones), removing the rest.
 * Returns { messages, removed }.
 */
export function limitEmojis(messages, { max = 1 } = {}) {
  let kept = 0, removed = 0;
  // an emoji that ended a sentence ("Faham, utk investment 👍 Sbg info …") leaves a full stop behind
  const out = (messages || []).map((m) => tidy(String(m ?? "").replace(EMOJI, (e, off, all) => {
    if (kept < max) { kept++; return e; }
    removed++;
    return /^\s+\p{Lu}/u.test(all.slice(off + e.length)) && /[\p{L}\p{N})]\s*$/u.test(all.slice(0, off)) ? "." : "";
  })));
  return { messages: out, removed };
}

// Settings → AI persona → Emoji level: "none" (never), "light" (warm moments only; the default), "friendly" (one
// fitting emoji on most replies). Every level keeps serious replies emoji-free and allows at most one per reply.
export const EMOJI_LEVELS = ["none", "light", "friendly"];
export const emojiLevel = (persona = {}) => (EMOJI_LEVELS.includes(persona?.emoji_level) ? persona.emoji_level : "light");

// a hand-over only because information is missing ("an advisor will check the KLCC-facing units") is not a serious
// moment; complaints, legal questions, negotiation, a request for a person and anything sensitive are
const ROUTINE_HANDOVER = new Set(["conflicting_info", "low_confidence", "other"]);
// the buyer is laughing or joking: a matching 😄 / 😂 is fine even next to loan figures (31 Oct: "Layan la sy!!!! Hahahaha")
export const PLAYFUL = /((?<![a-z])(ha|he|hi|wk|kah)\s?(ha|he|hi|wk|kah)[a-z]*|(?<![a-z])(lol|lmao|lolz)(?![a-z])|😂|🤣|😆|😄|😅)/iu;

/** How many emojis a reply may have: 0 when emojis are off or the reply is serious, otherwise 1. */
export function emojiAllowance({ decision = "reply", intent = null, objectionKey = null, financing = false, level = "light", handoverReason = null, playful = false } = {}) {
  if (level === "none") return 0;
  // a laughing objection ("Mahal la 😂 hahaha") may keep a matching smiley; complaints, legal questions, opt-outs and
  // requests for a person never get one
  if (playful ? ALWAYS_SERIOUS.has(intent) : objectionKey || SERIOUS_INTENTS.has(intent)) return 0;
  if (decision !== "reply" && !(decision === "handover" && ROUTINE_HANDOVER.has(handoverReason))) return 0;
  if (financing && !playful) return 0;
  return 1;
}
