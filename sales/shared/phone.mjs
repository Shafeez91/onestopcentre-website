// Malaysian-aware phone normalisation. Must match public.ai_normalize_phone() in the database.
// Returns digits-only E.164 without "+" (e.g. "012-345 6789" → "60123456789"), or null if unusable.
export function normalizePhone(input) {
  let d = String(input ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "6" + d;
  else if (/^1\d{8,9}$/.test(d)) d = "60" + d;
  if (d.length < 8 || d.length > 15) return null;
  return d;
}

// "60123456789" → "+60 12-345 6789" for display
export function formatPhone(e164) {
  const d = String(e164 ?? "");
  const m = d.match(/^60(1\d)(\d{3,4})(\d{4})$/);
  if (m) return `+60 ${m[1]}-${m[2]} ${m[3]}`;
  return d ? "+" + d : "";
}
