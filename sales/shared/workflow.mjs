// Follow-up workflows (migration 15): shared by the dashboard (builder, previews), the AI context and the sender.
// The database is the source of truth; these helpers only read what it stores, so nothing about a project's stages,
// keywords, messages or transitions is written here.

export const WF_STATUS = { active: "Active", paused: "Paused", completed: "Completed", human: "Needs a person" };
export const WF_STATUS_KIND = { active: "ok", paused: "warn", completed: "", human: "alert" };
export const WF_SOURCES = { facebook: "Facebook", instagram: "Instagram", website: "Website", whatsapp: "WhatsApp", staff: "Staff", other: "Other" };

/** Placeholders a stage message can use. {name} (single braces) from earlier messages works too. */
export const WF_VARIABLES = [
  ["name", "Buyer's name"],
  ["project_name", "Project name"],
  ["current_stage", "Current stage"],
  ["next_stage", "Next stage"],
  ["keyword", "Keyword to reply"],
];

/** Fills {{name}}, {{project_name}}, {{current_stage}}, {{next_stage}}, {{keyword}} (and the older {name}). */
export function fillMessage(text, vars = {}) {
  return String(text || "")
    .replace(/\{\{\s*([a-z_]+)\s*\}\}|\{([a-z_]+)\}/g, (m, a, b) => {
      const k = a || b;
      return Object.prototype.hasOwnProperty.call(vars, k) && vars[k] != null ? String(vars[k]) : m;
    })
    .trim();
}
/** Placeholders left unfilled (unknown names): shown as a warning in the builder. */
export const unknownVariables = (text) => [...String(text || "").matchAll(/\{\{\s*([a-z_]+)\s*\}\}|\{([a-z_]+)\}/g)]
  .map((m) => m[1] || m[2]).filter((k) => !WF_VARIABLES.some(([v]) => v === k));

/** Same comparison as ai_wf_norm: letters and digits only, upper case. */
export const normKeyword = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

const usable = (s) => s && !s.archived_at && s.active !== false;
const ordered = (stages) => [...(stages || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.key).localeCompare(String(b.key)));

/** Same rule as ai_wf_next: the stage's next stage if usable, else the next active stage in order; none after a final stage. */
export function nextStage(stages, key) {
  const list = ordered(stages), cur = list.find((s) => s.key === key);
  if (!cur || cur.is_final) return null;
  const set = cur.next_stage_key && list.find((s) => s.key === cur.next_stage_key && s.key !== cur.key);
  if (usable(set)) return set;
  return list.slice(list.indexOf(cur) + 1).find(usable) || null;
}
export const firstStage = (stages) => ordered(stages).find(usable) || null;
export const stageOf = (stages, key) => (stages || []).find((s) => s.key === key) || null;
export { ordered as orderedStages };

/** Message variables for one buyer at one stage. */
export function messageVars({ name, lang, projectName, stages, stageKey }) {
  const st = stageOf(stages, stageKey), nx = nextStage(stages, stageKey);
  return {
    name: name || (lang === "en" ? "there" : "tuan/puan"),
    project_name: projectName || "",
    current_stage: st?.name || stageKey || "",
    next_stage: nx?.name || "",
    keyword: st?.keywords?.[0] || "",
  };
}

/**
 * The same checks ai_wf_save makes, so the builder can show them before saving. Returns a list of problems
 * (empty = fine). Stages are in their saved order; archived ones are ignored.
 */
export function validateWorkflow(w) {
  const errs = [], live = (w.stages || []).filter((s) => !s.archived);
  if (!String(w.name || "").trim()) errs.push("Give the workflow a name.");
  if (!w.id && !/^[a-z0-9_]{2,40}$/.test(w.key || "")) errs.push("Short name: 2–40 lowercase letters, digits or _.");
  if (!(Number(w.pause_if_active_hours) >= 0 && Number(w.pause_if_active_hours) <= 72)) errs.push("Active-conversation pause: 0 to 72 hours.");
  if (live.length < 2) errs.push("A workflow needs at least two stages.");
  if (!live.some((s) => s.is_final)) errs.push("Mark the last stage (e.g. “Completed”) as final.");
  if (!live.some((s) => !s.is_final && s.active !== false)) errs.push("At least one active stage before the final one is needed.");
  const keys = new Set();
  for (const s of w.stages || []) {
    if (!/^[a-z0-9_]{1,40}$/.test(s.key || "")) errs.push(`Stage “${s.name || s.key}”: short name must be lowercase letters, digits or _.`);
    if (keys.has(s.key)) errs.push(`Two stages are called “${s.key}”.`);
    keys.add(s.key);
  }
  const seen = new Map();
  for (const s of live) for (const k of s.keywords || []) {
    const n = normKeyword(k);
    if (!n) continue;
    if (seen.has(n)) errs.push(`Keyword “${k}” is used by “${seen.get(n)}” and “${s.name}”.`);
    else seen.set(n, s.name);
  }
  for (const s of live) {
    const h = Number(s.follow_up_hours) || 0, m = Number(s.max_follow_ups) || 0;
    if (h < 0 || h > 720 || m < 0 || m > 10) errs.push(`“${s.name}”: hours 0–720 and at most 10 reminders.`);
    if (!s.is_final && s.active !== false && h > 0 && m > 0 && !String(s.message_ms || "").trim() && !String(s.message_en || "").trim()) errs.push(`“${s.name}”: write a reminder message or set no reminders.`);
    if (s.next_stage_key && (s.next_stage_key === s.key || !live.some((x) => x.key === s.next_stage_key))) errs.push(`“${s.name}”: its next stage is missing or archived.`);
    for (const t of [s.message_ms, s.message_en]) for (const v of unknownVariables(t)) errs.push(`“${s.name}”: unknown placeholder {{${v}}}.`);
  }
  return [...new Set(errs)];
}
