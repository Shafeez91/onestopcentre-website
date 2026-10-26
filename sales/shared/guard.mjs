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
const EN_WORDS = /\b(i|my|the|is|are|how|much|price|what|when|where|can|please|thanks|thank you|house|unit|room|bedroom|monthly|rent|buy|want|interested|available|loan)\b/gi;

export const isOptOut = (text) => OPT_OUT.some((r) => r.test(String(text || "")));
export const wantsHuman = (text) => HUMAN.some((r) => r.test(String(text || "")));

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
  safe_fallback: {
    ms: "Terima kasih atas soalan tuan/puan. Saya perlu sahkan maklumat ini dengan penasihat kami dahulu supaya jawapannya tepat. Penasihat kami akan menghubungi tuan/puan tidak lama lagi.",
    en: "Thanks for your question. I need to confirm this with our advisor first so the answer is accurate. One of our advisors will get back to you shortly.",
  },
};
export const fixedReply = (key, lang) => FIXED_REPLIES[key][lang === "en" ? "en" : "ms"];
