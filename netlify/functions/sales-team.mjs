// AI Sales — invite a staff member (owner only).
// Sends a Supabase Auth invitation email and records the role in ai_team_members.
import { json, getCaller, hasRole, moduleEnabled, disabled, asService, asUser, audit, isEmail, ConfigError } from "../../ai-sales/lib/server.mjs";

const ROLES = ["owner", "manager", "advisor", "viewer"];

export default async (req) => {
  if (!moduleEnabled()) return disabled();
  const caller = await getCaller(req);
  if (!caller) return json({ error: "Sign in required" }, 401);
  if (!hasRole(caller.role, "owner")) return json({ error: "Only owners can invite team members" }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const email = String(body?.email || "").trim().toLowerCase();
  const role = String(body?.role || "");
  const displayName = String(body?.display_name || "").trim().slice(0, 80) || null;
  if (!isEmail(email)) return json({ error: "A valid email is required" }, 400);
  if (!ROLES.includes(role)) return json({ error: "Role must be one of " + ROLES.join(", ") }, 400);

  // 1) record the role first, as the owner (RLS enforces owner-only); idempotent
  const up = await asUser(caller, "ai_team_members?on_conflict=email", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ email, role, display_name: displayName, active: true }),
  });
  if (!up.ok) return json({ error: "Could not save team member (" + up.status + ")" }, 502);

  // 2) send the Supabase invitation (needs the service-role key, server-side only)
  let invited = false, note = null;
  try {
    const origin = new URL(req.url).origin;
    const r = await asService("/auth/v1/invite", {
      method: "POST",
      body: JSON.stringify({ email, data: { invited_by: caller.email }, redirect_to: origin + "/sales/" }),
    });
    if (r.ok) invited = true;
    else {
      const t = await r.text();
      // an existing account cannot be re-invited; that's fine — they can sign in with their password
      note = /already|registered|exists/i.test(t) ? "Account already exists — they can sign in at /sales/ now." : "Invitation email failed (" + r.status + ").";
    }
  } catch (e) {
    if (e instanceof ConfigError) note = e.message + " Role saved; create the user in Supabase → Authentication → Users → Invite instead.";
    else note = "Invitation email failed.";
  }
  await audit(caller, "team_invite", { table: "ai_team_members", id: email, role, invited });
  return json({ ok: true, email, role, invited, note });
};

export const config = { path: "/api/sales/team/invite", method: ["POST"] };
