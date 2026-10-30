// Smart Salutation (master prompt v2 §4, 30 Oct 2026): how to address a buyer in English, Bahasa Malaysia and
// Manglish without ever using a wrong gender title. Shared by the server (AI context, reply check) and the dashboard.
//
// Order of authority:
//   1. a title the buyer asked for, or an advisor set (contact.salutation, source customer / advisor) — always wins
//   2. a gender the buyer or an advisor confirmed → Mr / Ms (English) or Encik / Puan (Malay)
//   3. name recognition, only when it is clear (a short list of common names, or "bin / binti", "a/l / a/p")
//   4. otherwise neutral: the name without a title, or "Tuan/Puan" in Malay when there is no name
// Never "Miss" or "Mrs" unless the buyer chose it (no marital status is assumed); never a guess from a photo.

export const TITLE_GENDER = {
  mr: "male", encik: "male", tuan: "male", abang: "male", bang: "male", sir: "male",
  ms: "female", mrs: "female", miss: "female", madam: "female", puan: "female", cik: "female", kak: "female", kakak: "female",
  dr: null, dato: null, "dato'": null, datuk: null, datin: "female", prof: null,
};
const TITLES = { en: { male: "Mr", female: "Ms" }, ms: { male: "Encik", female: "Puan" } };
const NAME_ONLY = "none"; // the buyer asked to be called by name only
// "call me tomorrow / later / ASAP": a request for a phone call, not a name
const NOT_A_NAME = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|later|now|asap|back|please|pls|anytime|isnin|selasa|rabu|khamis|jumaat|sabtu|ahad|esok|nanti|petang|pagi|malam|sekarang|segera)$/i;

// common names that are clearly male or female in Malaysia; anything else (Nur, Lee, Alex, most Chinese names) is
// left uncertain on purpose
const MALE = new Set(("muhammad mohammad mohamad mohamed mohammed mohd muhd md ahmad ahmed abdul abd ali hafiz hafizan hafizul faiz amir amirul aiman azman azmi " +
  "hakim haziq irfan ismail ibrahim iskandar khairul nazri rizal shafiq syafiq zulkifli firdaus faris hariz haikal danial adam yusof yusuf razak arif " +
  "afiq hazim luqman idris kamal rashid safwan shukri taufiq umar omar osman usman zainal zaki fadzil fauzi hisham jamal kamarul mazlan rosli saiful " +
  "david daniel john james michael peter paul mark kevin jason eric steven stephen andrew richard robert thomas william joseph charles brian george " +
  "edward anthony christopher matthew ryan jonathan benjamin patrick vincent raymond dennis gary henry jack justin kenneth martin nicholas philip " +
  "samuel simon timothy victor wilson alan frank eugene marcus melvin nelson terence calvin desmond edmund ivan jeffrey jerry keith louis howard " +
  "gordon harry aaron adrian albert alvin andy brandon bryan colin derek douglas ethan felix gavin jacob kelvin lucas nathan sean shawn wesley " +
  "rajesh ramesh suresh ganesh arun vijay prakash ravi siva muthu krishnan").split(/\s+/));
const FEMALE = new Set(("siti nurul aina aisyah aishah aisha fatimah farah nadia nabila syafiqah aqilah alia amira amirah hana intan izzati liyana " +
  "mariam maryam puteri rosnah rohani salmah sofia zarina nadiah najwa noraini norazlina zaitun suraya hidayah " +
  "jessica mary jennifer michelle emily emma sarah anna angela amanda alice catherine christine claire diana elaine elizabeth grace hannah helen " +
  "irene jane janet jasmine joanne joyce julia karen katherine linda lisa maria melissa nancy natalie nicole olivia patricia rachel rebecca sandra " +
  "sharon sophia stephanie susan teresa tiffany vanessa vivian wendy yvonne cheryl cindy crystal doris esther evelyn fiona gloria ivy jacqueline " +
  "kelly lily mandy priscilla sally selina shirley stella tracy valerie winnie carmen celine chloe eunice josephine " +
  "priya lakshmi kavitha devi shanti malar sangeetha").split(/\s+/));
// a first word that is a prefix, not the name people are called by (Muhammad Hafiz → Hafiz)
const SKIP_PREFIX = new Set(["muhammad", "mohammad", "mohamad", "mohamed", "mohammed", "mohd", "muhd", "md", "nur", "noor", "nor"]);
// a surname written first (Tan Wei Ming): addressed by the full name when the gender is unknown
const SURNAME_FIRST = new Set(("tan lim ng wong chan ong goh teh lau low yap chong cheah chua koh khoo foo loh chin chew ho hor kok lai liew loo " +
  "ooi phang quek seow soh tay toh wee yeoh yong lee").split(/\s+/));

const words = (s) => String(s || "").normalize("NFKC").replace(/[^\p{Script=Latin}'’\-/ .]/gu, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

/** The name to address someone by, from the profile's preferred name or the full / WhatsApp name. */
export function callName(fullName, preferredName = null) {
  const pref = words(preferredName);
  if (pref.length) return pref.map(cap).join(" ");
  let w = words(fullName).filter((x) => !/^(bin|binti|bt|bte|binte|a\/l|a\/p|b\.)$/i.test(x));
  const cut = words(fullName).findIndex((x) => /^(bin|binti|bt|bte|binte|a\/l|a\/p)$/i.test(x));
  if (cut > 0) w = words(fullName).slice(0, cut);
  // a title written in the name ("Dr Lim", "Puan Siti") is not part of the name
  while (w.length > 1 && Object.prototype.hasOwnProperty.call(TITLE_GENDER, w[0].toLowerCase().replace(/\.$/, ""))) w = w.slice(1);
  if (!w.length) return null;
  if (w.length > 1 && SKIP_PREFIX.has(w[0].toLowerCase())) return cap(w[1]);
  if (w.length >= 3 && SURNAME_FIRST.has(w[0].toLowerCase())) return w.map(cap).join(" ");
  // a clearly recognised first name is enough ("Eugene Tay Yi Hao" → Eugene); otherwise the whole name, up to three
  // words, so a two-part given name ("Zhi Wei") is not cut in half
  if (w.length > 1 && w.length <= 3 && nameGender(w.join(" ")).confidence !== "high") return w.map(cap).join(" ");
  return cap(w[0]);
}

/** Gender suggested by a name: { gender: "male" | "female" | null, confidence: "high" | "uncertain", reason } */
export function nameGender(fullName) {
  const raw = String(fullName || "").toLowerCase(), w = words(fullName).map((x) => x.toLowerCase().replace(/\.$/, ""));
  if (/\s(bin|b\.)\s/.test(` ${raw} `) || w.includes("a/l")) return { gender: "male", confidence: "high", reason: "bin / a/l in the name" };
  if (/\s(binti|bt|bte|binte)\s/.test(` ${raw} `) || w.includes("a/p")) return { gender: "female", confidence: "high", reason: "binti / a/p in the name" };
  const title = w.find((x) => TITLE_GENDER[x]);
  if (title && w.indexOf(title) === 0) return { gender: TITLE_GENDER[title], confidence: "high", reason: `"${cap(title)}" in the name` };
  for (const x of w.slice(0, 2)) {
    if (MALE.has(x)) return { gender: "male", confidence: "high", reason: `"${cap(x)}" is a common male name` };
    if (FEMALE.has(x)) return { gender: "female", confidence: "high", reason: `"${cap(x)}" is a common female name` };
    if (!SKIP_PREFIX.has(x)) break; // only the first name (after Muhammad / Mohd) counts
  }
  return { gender: null, confidence: "uncertain", reason: "the name does not show it clearly" };
}

/**
 * How to address the buyer. contact: { full_name, salutation, gender, salutation_source, salutation_confidence };
 * preferredName: the client profile's preferred name. Returns
 * { name, en, ms, title_en, title_ms, gender, certainty: "confirmed" | "high" | "uncertain", source, allowed_titles }
 */
export function addressFor(contact = {}, { preferredName = null } = {}) {
  const name = callName(contact.full_name, preferredName);
  const src = contact.salutation_source || (contact.salutation ? "advisor" : null); // a salutation typed before 30 Oct counts as the advisor's
  const confirmedBy = src === "customer" || src === "advisor";
  const pref = String(contact.salutation || "").trim();
  let title_en = null, title_ms = null, gender = null, certainty = "uncertain", source = "not_set";
  if (pref && confirmedBy) {
    certainty = "confirmed"; source = src;
    if (pref.toLowerCase() !== NAME_ONLY) { title_en = title_ms = pref; gender = TITLE_GENDER[pref.toLowerCase().replace(/\.$/, "")] ?? null; }
  } else if (confirmedBy && ["male", "female"].includes(contact.gender)) {
    gender = contact.gender; certainty = "confirmed"; source = src;
  } else if (confirmedBy && ["unknown", "not_provided"].includes(contact.gender)) {
    certainty = "confirmed"; source = src; // a person said: no title
  } else {
    const g = nameGender(contact.full_name);
    if (g.confidence === "high") { gender = g.gender; certainty = "high"; source = "name_recognition"; }
  }
  if (gender && !title_en && !(pref && confirmedBy)) { title_en = TITLES.en[gender]; title_ms = TITLES.ms[gender]; }
  const join = (t) => (name ? (t ? `${t} ${name}` : name) : null);
  const allowed = new Set([title_en, title_ms].filter(Boolean).map((t) => t.toLowerCase().replace(/\.$/, "")));
  if (gender === "male") ["mr", "encik", "tuan"].forEach((t) => allowed.add(t));
  if (gender === "female" && title_en && ["ms", "puan"].includes(title_en.toLowerCase())) ["ms", "puan"].forEach((t) => allowed.add(t));
  return {
    name, gender, certainty, source,
    title_en, title_ms,
    en: join(title_en), ms: name ? join(title_ms) : title_ms || "Tuan/Puan",
    allowed_titles: [...allowed],
  };
}

/**
 * A title the buyer asks for in their own words ("call me Mr Tan", "panggil saya Puan Aina", "just call me David").
 * Returns { salutation, gender, name } or null.
 */
export function parseTitlePreference(text) {
  const t = String(text || "");
  const T = "(Mr|Ms|Mrs|Miss|Madam|Dr|Encik|Puan|Cik|Tuan|Kak|Kakak|Abang|Bang|Dato'?|Datuk|Datin)";
  const m = t.match(new RegExp(`\\b(?:call\\s+me|address\\s+me\\s+as|panggil\\s+(?:saya|je|aje|ja|sahaja)?\\s*(?:je|aje|sahaja)?)\\s*${T}\\.?(?:\\s+(?!(?:je|aje|ja|sahaja|please|pls|ya|yah|ok)\\b)([A-Za-z][\\w'’-]*))?`, "i"))
    || t.match(new RegExp(`\\b(?:[Ii]\\s+am|[Ii]'m|[Ii]m|[Tt]his\\s+is|[Ss]aya)\\s+${T}\\.?\\s+([A-Z][\\w'’-]*)`));
  if (m) {
    const title = m[1].replace(/^(\w)/, (c) => c.toUpperCase()).replace(/^Dato$/i, "Dato'");
    return { salutation: title, gender: TITLE_GENDER[title.toLowerCase().replace(/\.$/, "")] ?? null, name: m[2] || null };
  }
  const n = t.match(/\b(?:just\s+)?call\s+me\s+(?:just\s+)?([A-Z][a-z][\w'’-]*)\b/) || t.match(/\bpanggil\s+(?:saya\s+)?(?:je\s+)?([A-Z][a-z][\w'’-]*)\s*(?:je|aje|sahaja)?\b/);
  if (n && !TITLE_GENDER[n[1].toLowerCase()] && !NOT_A_NAME.test(n[1])) return { salutation: NAME_ONLY, gender: null, name: n[1] };
  return null;
}

/**
 * Replaces a wrong title before the buyer's name ("Miss David", "Encik Jessica", "Mr Lee" when unsure) with the right
 * address for the reply's language. Returns { text, fixed: [...] }.
 */
export function fixSalutation(text, addr, lang = "ms") {
  const first = String(addr?.name || "").split(" ")[0];
  if (!first) return { text, fixed: [] };
  const fixed = [];
  const re = new RegExp(`\\b(Mr|Mister|Ms|Mrs|Miss|Madam|Encik|Puan|Cik|Tuan|Sir)\\.?\\s+(${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\b`, "gi");
  const out = String(text).replace(re, (all, title) => {
    if (addr.allowed_titles.includes(title.toLowerCase())) return all;
    const right = (lang === "en" ? addr.en : addr.ms) || first;
    fixed.push(`${all} → ${right}`);
    return right;
  });
  return { text: out, fixed };
}
