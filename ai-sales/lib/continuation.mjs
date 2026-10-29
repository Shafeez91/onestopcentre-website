// Signed continuation tokens for the AI test console. A turn that needs web research is split into steps, each well
// under Netlify's 30-second request limit: (1) the draft, (2) the web research, (3) a second draft with the findings.
// The findings travel back through the browser between steps, so they are signed with a server-side key: the console
// cannot hand the AI "findings" of its own, and a token only works for the same staff member, message and history,
// for a few minutes.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./server.mjs";

const TTL_MS = 10 * 60e3;
const b64 = (s) => Buffer.from(s).toString("base64url");
const keyOf = (secret) => (secret ? createHash("sha256").update("ai-simulate-continuation:" + secret).digest() : null);

/** What a token is bound to: who asked, the message and the conversation so far. */
export function bindingOf(caller, message, history) {
  return createHash("sha256").update(JSON.stringify([caller?.email || "", String(message), (history || []).map((h) => [h.role, h.text])])).digest("base64url").slice(0, 32);
}

export function signContinuation(payload, { secret = env("SUPABASE_SERVICE_ROLE_KEY"), now = Date.now() } = {}) {
  const key = keyOf(secret);
  if (!key) return null;
  const body = b64(JSON.stringify({ ...payload, exp: now + TTL_MS }));
  return body + "." + createHmac("sha256", key).update(body).digest("base64url");
}

/** The payload, or null if the token is forged, expired or bound to something else. */
export function verifyContinuation(token, binding, { secret = env("SUPABASE_SERVICE_ROLE_KEY"), now = Date.now() } = {}) {
  const key = keyOf(secret);
  const [body, sig] = String(token || "").split(".");
  if (!key || !body || !sig) return null;
  const want = createHmac("sha256", key).update(body).digest();
  let got;
  try { got = Buffer.from(sig, "base64url"); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!p || p.exp < now || p.bind !== binding) return null;
  return p;
}
