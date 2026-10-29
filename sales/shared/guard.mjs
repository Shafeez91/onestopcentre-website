// Deterministic checks that run BEFORE the AI sees a message. They never depend on the model:
// an opt-out or a request for a human is always honoured, whatever the AI would have said.

const OPT_OUT = [
  /^\s*(stop|unsubscribe|berhenti|henti|stop all|stopall|cancel)\s*[.!]*\s*$/i,
  /\b(jangan|tak payah|tidak perlu|x payah|xpayah)\s+(hantar|whatsapp|wasap|mesej|message|contact|hubungi|call|telefon)\b/i,
  /\b(don'?t|do not|stop)\s+(message|messaging|text|texting|contact|contacting|whatsapp|call|calling|send)(ing)?\s+(me|anymore)?/i,
  /\b(remove|padam)\s+(me|my number|nombor saya)\b/i,
  /\bopt[\s-]?out\b/i,
];

const HUMAN = [
  /\b(nak|mahu|hendak|want to|wanna|can i|boleh)\s+(cakap|bercakap|bual|talk|speak|chat)\s+(dengan|with|to)\s+(a\s+|an\s+|the\s+|your\s+)?(orang|manusia|agent|ejen|staff|staf|human|person|someone|sales|advisor|penasihat|real)/i,
  /\b(real|actual)\s+(person|human|agent)\b/i,
  /\b(orang|manusia)\s+(betul|sebenar)\b/i,
  /\b(call|telefon|hubungi)\s+(me|saya)\b/i,
  /\b(human|agent|ejen)\s+(please|pls|tolong)\b/i,
  /^\s*(agent|human|ejen|manusia)\s*[?.!]*\s*$/i,
];

const MS_WORDS = /\b(saya|nak|boleh|berapa|harga|rumah|bilik|tak|tidak|ada|untuk|dengan|ini|itu|bila|mana|kat|dekat|bulan|tuan|puan|encik|terima kasih|tq|projek|lokasi|bulanan|sewa|beli|ke|lah|kah|dah|sudah|belum)\b/gi;
const EN_WORDS = /\b(i|my|the|is|are|how|much|price|what|when|where|can|please|thanks|thank you|house|unit|room|bedroom|monthly|rent|buy|want|interested|available|loan|hi|hello|this|that|you|your|have|got|will|for|and|with|about|abt|any|there|morning|afternoon|evening|tomorrow|today|weekend|saturday|sunday|good|sure|yes|okay|sir|see|visit|need|still)\b/gi;

// An explicit request for a reply language ("Saya nk speak in English", "english pls", "boleh cakap melayu?").
// Not a guess from the words used: only a buyer asking for a language counts.
const LANG_REQ = (lang) => new RegExp(
  `\\b(speak|cakap|reply|balas|talk|chat|write|tulis|answer|jawab|guna|use|pakai|in|dalam)\\s+(in\\s+|dalam\\s+)?(${lang})\\b`
  + `|\\b(${lang})\\s+(please|pls|plz|boleh|can|ok|okay|je|jer|sahaja|saja|only)\\b|^\\s*(${lang})\\s*[?.!]*\\s*$`, "i");
const ASK_EN = LANG_REQ("english|eng|bahasa inggeris|b\\.?\\s?inggeris");
const ASK_MS = LANG_REQ("malay|melayu|bahasa melayu|bahasa malaysia|bm");

/** "en" / "ms" when the text asks for a reply language, else null. */
export function requestedLanguage(text) {
  const t = String(text || "");
  const en = ASK_EN.test(t), ms = ASK_MS.test(t);
  return en && !ms ? "en" : ms && !en ? "ms" : null;
}

/** The buyer's latest explicit language request: this message first, then their earlier messages, newest first. */
export function languagePreference(message, history = []) {
  const own = [message, ...[...(history || [])].reverse().filter((h) => h?.role !== "assistant").map((h) => h.text)];
  for (const t of own) { const l = requestedLanguage(t); if (l) return l; }
  return null;
}

export const isOptOut = (text) => OPT_OUT.some((r) => r.test(String(text || "")));
export const wantsHuman = (text) => HUMAN.some((r) => r.test(String(text || "")));

/**
 * The language to write to a buyer in: their saved choice when it is "en" or "ms"; otherwise what their own
 * messages are mostly written in (English when English words outnumber Malay ones), else `fallback`.
 */
export function replyLanguage(preferred, texts = [], fallback = "ms") {
  if (preferred === "en" || preferred === "ms") return preferred;
  const t = (Array.isArray(texts) ? texts : [texts]).join("\n");
  const ms = (t.match(MS_WORDS) || []).length, en = (t.match(EN_WORDS) || []).length;
  if (!ms && !en) return fallback;
  return en > ms ? "en" : "ms";
}

/** Rough language of a message: "ms", "en" or "mixed" (Manglish). Used for fixed replies and as a hint to the AI. */
export function detectLanguage(text, fallback = "ms") {
  const t = String(text || "");
  const ms = (t.match(MS_WORDS) || []).length, en = (t.match(EN_WORDS) || []).length;
  if (!ms && !en) return fallback;
  if (ms && en && Math.min(ms, en) / Math.max(ms, en) >= 0.34) return "mixed";
  return ms >= en ? "ms" : "en";
}

/** Fixed, pre-approved replies used when the AI is bypassed. */
export const FIXED_REPLIES = {
  opt_out: {
    ms: "Baik, kami tidak akan menghantar mesej lagi. Jika tuan/puan perlukan bantuan pada masa akan datang, hantar sahaja mesej kepada kami. Terima kasih.",
    en: "Understood — we won't send you any more messages. If you need help in future, just message us. Thank you.",
  },
  human: {
    ms: "Baik, saya akan minta penasihat hartanah kami menghubungi tuan/puan secepat mungkin. Terima kasih atas kesabaran tuan/puan.",
    en: "Sure — I'll ask one of our property advisors to get in touch with you as soon as possible. Thank you for your patience.",
  },
  // a photo, document or voice note with no words: say what happened and ask for the question in words
  media: {
    ms: "Terima kasih 🙏 Saya pembantu AI dan belum boleh buka gambar atau dokumen di sini. Boleh taip soalan tuan/puan? Advisor kami juga akan semak mesej tadi.",
    en: "Thank you 🙏 I'm an AI assistant and can't open photos or documents here yet. Could you type your question? Our advisor will also check what you sent.",
  },
  audio: {
    ms: "Terima kasih 🙏 Saya pembantu AI dan belum boleh dengar voice note. Boleh taip soalan tuan/puan? Advisor kami juga akan dengar mesej tadi.",
    en: "Thank you 🙏 I'm an AI assistant and can't listen to voice notes yet. Could you type your question? Our advisor will also listen to it.",
  },
  safe_fallback: {
    ms: "Terima kasih atas soalan tuan/puan. Saya perlu sahkan maklumat ini dengan penasihat kami dahulu supaya jawapannya tepat. Penasihat kami akan menghubungi tuan/puan tidak lama lagi.",
    en: "Thanks for your question. I need to confirm this with our advisor first so the answer is accurate. One of our advisors will get back to you shortly.",
  },
};
export const fixedReply = (key, lang) => FIXED_REPLIES[key][lang === "en" ? "en" : "ms"];
