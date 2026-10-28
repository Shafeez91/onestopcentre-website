// Follow-up workflows (migration 15), read for the AI context and the reminder sender.
import { stageOf, nextStage, orderedStages } from "../../sales/shared/workflow.mjs";

const enc = encodeURIComponent;
const inList = (ids) => `in.(${ids.map((x) => `"${x}"`).join(",")})`;

/** Workflows by id with their (non-archived) stages in order: Map id → { ...workflow, stages }. */
export async function loadWorkflows(db, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const [ws, ss] = await Promise.all([
    db.get(`ai_workflows?id=${enc(inList(uniq))}&select=*`),
    db.get(`ai_workflow_stages?workflow_id=${enc(inList(uniq))}&archived_at=is.null&select=*&order=position.asc`),
  ]);
  return new Map((ws || []).map((w) => [w.id, { ...w, stages: orderedStages((ss || []).filter((s) => s.workflow_id === w.id)) }]));
}

/**
 * What the AI needs to know about the buyer's workflows: the lead's own (stage, step, keyword, next stage, last move)
 * and the active workflows the buyer could join once they confirm (offers).
 */
export async function workflowContext(db, leadId) {
  const rows = (await db.get(`ai_workflow_leads?lead_id=eq.${enc(leadId)}&select=*`).catch(() => [])) || [];
  const wfs = await loadWorkflows(db, rows.map((r) => r.workflow_id));
  const mine = rows.map((r) => {
    const w = wfs.get(r.workflow_id);
    if (!w || w.status !== "active") return null;
    const st = stageOf(w.stages, r.stage), nx = nextStage(w.stages, r.stage), label = (k) => stageOf(w.stages, k)?.name || k;
    const lastMove = [...(r.history || [])].reverse().find((h) => h.from);
    return {
      workflow: w.key, name: w.name, project_id: w.project_id || null, stage: r.stage, stage_label: st?.name || r.stage, automation: r.status, since: r.stage_changed_at,
      current_step: st && !st.is_final ? { en: st.step_en || st.name, ms: st.step_ms || st.step_en || st.name, reply_keyword_when_done: st.keywords?.[0] || null } : null,
      steps_in_order: w.stages.filter((s) => s.active !== false).map((s) => ({ stage: s.key, label: s.name, keyword: s.keywords?.[0] || null, final: !!s.is_final })),
      next_stage: nx?.name || null,
      last_change: lastMove ? { from: label(lastMove.from), to: label(lastMove.to), at: lastMove.at, via: lastMove.via } : null,
      ...(w.ai_instructions ? { guidance: w.ai_instructions } : {}),
    };
  }).filter(Boolean);
  const joined = new Set(rows.map((r) => r.workflow_id));
  const offers = ((await db.get(`ai_workflows?status=eq.active&select=id,key,name,project_id,entry,ai_instructions`).catch(() => [])) || [])
    .filter((w) => !joined.has(w.id) && w.entry?.ai_confirm !== false)
    .map((w) => ({ workflow: w.key, name: w.name, project_id: w.project_id || null, ...(w.ai_instructions ? { guidance: w.ai_instructions } : {}) }));
  return { workflows: mine, offers };
}
