// In-memory stand-in for the PostgREST calls the worker makes ({ get, post, patch, rpc }). TEST ONLY.
// Supports eq/neq/gt/gte/lt/lte/is/in/not.<op> filters, order, limit, on_conflict + ignore-duplicates, and to-one embeds
// such as contact:ai_contacts(...) resolved through <alias>_id columns.
import { randomUUID } from "node:crypto";

const FK = { contact: "contact_id", lead: "lead_id" };
const decode = (v) => decodeURIComponent(v);
const asCmp = (a) => (typeof a === "string" && /^\d{4}-\d\d-\d\dT/.test(a) ? new Date(a).getTime() : a);

function splitTop(s) { // split "a,b(c,d),e" on top-level commas
  const out = []; let depth = 0, cur = "";
  for (const ch of s) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && !depth) { out.push(cur); cur = ""; } else cur += ch; }
  if (cur) out.push(cur);
  return out;
}
function embeds(select) {
  return splitTop(select || "*").map((p) => /^(\w+):(\w+)\((.*)\)$/.exec(p.trim())).filter(Boolean).map((m) => ({ alias: m[1], table: m[2], select: m[3] }));
}
function match(row, col, expr) {
  const i = expr.indexOf("."), op = expr.slice(0, i), raw = decode(expr.slice(i + 1)), v = row[col];
  switch (op) {
    case "not": return !match(row, col, raw);
    case "eq": return String(v) === raw;
    case "neq": return String(v) !== raw;
    case "is": return raw === "null" ? v === null || v === undefined : String(v) === raw;
    case "in": return raw.replace(/^\(|\)$/g, "").split(",").includes(String(v));
    case "gt": return v != null && asCmp(v) > asCmp(raw);
    case "gte": return v != null && asCmp(v) >= asCmp(raw);
    case "lt": return v != null && asCmp(v) < asCmp(raw);
    case "lte": return v != null && asCmp(v) <= asCmp(raw);
    default: throw new Error("memdb: unsupported filter " + op);
  }
}

export function memdb(seed = {}, rpcs = {}) {
  const t = structuredClone(seed);
  const log = [];
  let queries = 0;
  const views = {
    ai_consent_current: () => {
      const latest = new Map();
      for (const r of [...(t.ai_consent_records || [])].sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)))) latest.set(`${r.contact_id}|${r.channel}|${r.purpose}`, r);
      return [...latest.values()];
    },
    ai_active_promotions: () => [],
  };
  const rows = (name) => (views[name] ? views[name]() : (t[name] ||= []));
  const query = (path) => {
    const [name, qs = ""] = path.split("?");
    const params = qs ? qs.split("&").map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }) : [];
    return { name, params };
  };
  const filterRows = (name, params) => {
    let out = rows(name);
    for (const [k, v] of params) if (!["select", "order", "limit", "on_conflict"].includes(k)) out = out.filter((r) => match(r, k, v));
    return out;
  };
  const embed = (row, select) => {
    const r = { ...row };
    for (const e of embeds(select)) {
      const fkVal = row[FK[e.alias] || e.alias + "_id"];
      const target = rows(e.table).find((x) => x.id === fkVal);
      r[e.alias] = target ? embed(target, e.select) : null;
    }
    return r;
  };
  return {
    t, log,
    async get(path) {
      const { name, params } = query(path);
      let out = filterRows(name, params);
      const order = params.find(([k]) => k === "order")?.[1];
      if (order) {
        // like Postgres, rows that tie on every ORDER BY key come back in no particular order: alternate it per query
        const keys = decode(order).split(",").map((k) => k.split(".")), flip = ++queries % 2 ? 1 : -1;
        out = out.map((r, i) => [r, i]).sort(([a, i], [b, j]) => { for (const [col, dir] of keys) { const x = asCmp(a[col]), y = asCmp(b[col]); if (x !== y) return (x > y ? 1 : -1) * (dir === "desc" ? -1 : 1); } return (i - j) * flip; }).map(([r]) => r);
      }
      const limit = params.find(([k]) => k === "limit")?.[1];
      if (limit) out = out.slice(0, Number(limit));
      const select = decode(params.find(([k]) => k === "select")?.[1] || "*");
      return structuredClone(out.map((r) => embed(r, select)));
    },
    async post(path, body, { prefer = "" } = {}) {
      const { name, params } = query(path);
      const conflict = params.find(([k]) => k === "on_conflict")?.[1];
      const inserted = [];
      for (const b of Array.isArray(body) ? body : [body]) {
        const row = { id: randomUUID(), created_at: new Date().toISOString(), ...structuredClone(b) };
        if (conflict) {
          const cols = conflict.split(",");
          const dup = rows(name).find((r) => cols.every((c) => r[c] != null && r[c] === row[c]));
          if (dup) { if (/ignore-duplicates/.test(prefer)) continue; throw new Error(`memdb: duplicate ${name}.${conflict}`); }
        }
        rows(name).push(row); inserted.push(row);
      }
      log.push({ op: "post", name, body });
      return /return=representation/.test(prefer) ? structuredClone(inserted) : null;
    },
    async patch(path, body) {
      const { name, params } = query(path);
      for (const r of filterRows(name, params)) Object.assign(r, structuredClone(body), { updated_at: new Date().toISOString() });
      log.push({ op: "patch", name, path, body });
      return null;
    },
    async rpc(name, args) {
      log.push({ op: "rpc", name, args });
      if (rpcs[name]) return rpcs[name](args, t);
      if (name === "ai_search_knowledge") return [];
      if (name === "ai_reserve_ai_call") return { allowed: true, used: 1, cap: 200 };
      if (name === "ai_send_telegram") { (t.telegram ||= []).push(args); return true; }
      if (name === "ai_claim_jobs") { const due = (t.ai_jobs || []).filter((j) => ["queued", "failed"].includes(j.status)); due.forEach((j) => { j.status = "running"; j.attempts = (j.attempts || 0) + 1; }); return structuredClone(due); }
      if (name === "ai_claim_follow_ups") { const due = (t.ai_follow_up_jobs || []).filter((j) => j.status === "scheduled" && new Date(j.run_at) <= new Date(args.now || Date.now())); due.forEach((j) => { j.status = "processing"; j.attempts = (j.attempts || 0) + 1; }); return structuredClone(due); }
      if (name === "ai_claim_automation_jobs") {
        // like the SQL function: due "scheduled" jobs (by t.__now when a test sets a clock), or one job by id; each handed out once
        const now = new Date(t.__now || Date.now());
        const due = (t.ai_automation_jobs || []).filter((j) => j.status === "scheduled" && (args.only_id ? j.id === args.only_id : new Date(j.run_at) <= now) && (j.attempts || 0) < 5)
          .sort((a, b) => String(a.run_at).localeCompare(String(b.run_at))).slice(0, args.max_jobs || 20);
        due.forEach((j) => { j.status = "processing"; j.attempts = (j.attempts || 0) + 1; });
        return structuredClone(due);
      }
      if (name === "ai_follow_up_start") { (t.started ||= []).push(args); return "fu-job"; }
      throw new Error("memdb: unexpected rpc " + name);
    },
  };
}
