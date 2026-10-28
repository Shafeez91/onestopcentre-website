// RMK (Residensi Metropolitan Kepong) pipeline: stages, the buyer's confirmation keyword for each, and labels.
// The database (migration 14) holds the same order and keywords; this is for the dashboard, the AI and the sender.

export const RMK_STAGES = ["new", "to_book", "to_portal", "to_submit_loan", "to_sign", "all_signed"];

export const RMK_STAGE = {
  new:            { label: "New RMK enquiry",          keyword: "RMK",              step_en: "Confirm interest in RMK",             step_ms: "Sahkan minat terhadap RMK" },
  to_book:        { label: "To book unit",             keyword: "DONE BOOKED",      step_en: "Book a unit",                         step_ms: "Buat tempahan unit" },
  to_portal:      { label: "To apply portal (RUMAWIP)", keyword: "DONE PORTAL",     step_en: "Register on the RUMAWIP portal",      step_ms: "Daftar di portal RUMAWIP" },
  to_submit_loan: { label: "To submit loan documents", keyword: "DONE SUBMIT LOAN", step_en: "Submit the loan application documents", step_ms: "Hantar dokumen permohonan pinjaman" },
  to_sign:        { label: "To sign LO, SPA & LA",     keyword: "DONE SIGNED",      step_en: "Sign the LO, SPA & LA",               step_ms: "Tandatangan LO, SPA & LA" },
  all_signed:     { label: "All signed",               keyword: null,               step_en: "Completed",                           step_ms: "Selesai" },
};

export const RMK_STATUS = { active: "Active", paused: "Paused", completed: "Completed", human: "Needs a person" };
export const RMK_SOURCES = { facebook: "Facebook", instagram: "Instagram", website: "Website", whatsapp: "WhatsApp", other: "Other" };

export const rmkNext = (stage) => RMK_STAGES[RMK_STAGES.indexOf(stage) + 1] || null;

/** Defaults matching migration 14; settings saved in ai_settings.rmk override them. */
export const RMK_DEFAULTS = { enabled: false, project_id: null, pause_if_active_hours: 6, stages: {} };
export function rmkSettings(raw = {}) {
  const r = { ...RMK_DEFAULTS, ...(raw || {}) };
  r.stages = Object.fromEntries(RMK_STAGES.slice(0, -1).map((s) => [s, { follow_up_hours: 0, max_follow_ups: 0, template: "", message_ms: "", message_en: "", ...((raw || {}).stages?.[s] || {}) }]));
  return r;
}

/** Ad text that names RMK (click-to-WhatsApp referral headline/body): reliable, unlike a bare "RMK" typed by anyone. */
export const isRmkAd = (ref) => !!ref && /metropolitan\s*kepong|\bRMK\b/i.test([ref.headline, ref.body, ref.source_url].filter(Boolean).join(" "));
