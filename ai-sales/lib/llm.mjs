// Claude API adapter (raw HTTP via fetch).
// The site deploys as a plain static publish with zero-dependency Netlify Functions and no package.json,
// so the official @anthropic-ai/sdk cannot be bundled; this follows the documented Messages API shapes.
import { env } from "./server.mjs";

export const DEFAULT_MODEL = "claude-opus-5-5";
const API = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2026-10-21";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class LlmError extends Error {
  constructor(message, { kind = "error", status = 0, retryable = false } = {}) { super(message); this.kind = kind; this.status = status; this.retryable = retryable; }
}

/**
 * One structured call: returns the parsed JSON object matching `schema`.
 * @param {object} p { system, messages, schema, model, effort, maxTokens, apiKey, fetchImpl, retries, deadline }
 *   deadline: epoch ms by which the call must be over (Netlify ends a request at 30 s). The request is aborted at the
 *   deadline (LlmError kind "timeout") and a retry is only made while there is still time for it.
 */
export async function callClaude(p) {
  const apiKey = p.apiKey || env("ANTHROPIC_API_KEY");
  if (!apiKey) throw new LlmError("ANTHROPIC_API_KEY is not set in Netlify environment variables (Functions scope).", { kind: "config" });
  const fetchImpl = p.fetchImpl || fetch;
  const body = {
    model: p.model || DEFAULT_MODEL,
    max_tokens: p.maxTokens || 16000,
    // stable prefix with its own cache breakpoint; the per-message context goes in `messages`, after it
    system: [{ type: "text", text: p.system, cache_control: { type: "ephemeral" } }],
    messages: p.messages,
    output_config: { effort: p.effort || "low", format: { type: "json_schema", schema: p.schema } },
    fallbacks: "default",                               // server-side refusal fallback, routed by refusal category
  };
  const retries = p.retries ?? 2;
  const left = () => (p.deadline ? p.deadline - Date.now() : Infinity);
  const timedOut = () => new LlmError("The AI service did not answer within this request's time limit.", { kind: "timeout" });
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) {
      const wait = Math.min(8000, 800 * 2 ** (attempt - 1)) * (p.backoffScale ?? 1);
      if (left() < wait + 5000) break; // no time for another try: report the last error now, not a gateway timeout later
      await new Promise((r) => setTimeout(r, wait));
    }
    if (left() < 1500) throw timedOut();
    let res;
    try {
      res = await fetchImpl(API, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": API_VERSION, "anthropic-beta": FALLBACK_BETA },
        body: JSON.stringify(body),
        ...(p.deadline ? { signal: AbortSignal.timeout(Math.max(1000, left())) } : {}),
      });
    } catch (e) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw timedOut();
      lastErr = new LlmError("Network error calling the AI service: " + (e?.message || e), { kind: "network", retryable: true });
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new LlmError(`AI service busy or unavailable (HTTP ${res.status}).`, { kind: "unavailable", status: res.status, retryable: true });
      continue;
    }
    let json;
    try { json = await res.json(); } catch (e) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw timedOut();
      throw new LlmError(`Unreadable response from the AI service (HTTP ${res.status}).`, { kind: "bad_response", status: res.status });
    }
    if (!res.ok) {
      const msg = json?.error?.message || "unknown error";
      // "schema" = the request's output schema was refused (e.g. its compiled grammar is too large): our bug, not an outage
      const kind = res.status === 401 || res.status === 403 ? "auth" : res.status === 400 && /grammar|schema/i.test(msg) ? "schema" : "rejected";
      throw new LlmError(`AI request rejected (HTTP ${res.status}): ${msg}`, { kind, status: res.status });
    }
    if (json.stop_reason === "refusal") throw new LlmError("The AI declined to answer this message.", { kind: "refusal" });
    if (json.stop_reason === "max_tokens") throw new LlmError("The AI reply was cut off (max_tokens).", { kind: "truncated" });
    const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    let data;
    try { data = JSON.parse(text); } catch { throw new LlmError("The AI reply was not valid JSON.", { kind: "bad_response" }); }
    return { data, model: json.model, usage: json.usage || {}, stopReason: json.stop_reason };
  }
  throw lastErr || timedOut();
}

/**
 * A research call with Claude's server-side web tools (web_search / web_fetch). These cannot be combined with the
 * structured-output format (citations are incompatible with it), so this returns plain text: { text, sources,
 * searches, usage, model }. Capped by max_uses and a time limit; a paused turn ("pause_turn") is resumed once.
 * @param {object} p { system, prompt, model, maxSearches, maxFetches, timeoutMs, apiKey, fetchImpl }
 */
export async function researchClaude(p) {
  const apiKey = p.apiKey || env("ANTHROPIC_API_KEY");
  if (!apiKey) throw new LlmError("ANTHROPIC_API_KEY is not set in Netlify environment variables (Functions scope).", { kind: "config" });
  const fetchImpl = p.fetchImpl || fetch;
  const messages = [{ role: "user", content: p.prompt }];
  const tools = [
    { type: "web_search_20260209", name: "web_search", max_uses: p.maxSearches ?? 3, user_location: { type: "approximate", country: "MY", city: "Kuala Lumpur", timezone: "Asia/Kuala_Lumpur" } },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: p.maxFetches ?? 2 },
  ];
  const deadline = Date.now() + (p.timeoutMs ?? 25000);
  const out = { text: "", sources: [], searches: 0, usage: { input_tokens: 0, output_tokens: 0 }, model: null };
  for (let turn = 0; turn < 2; turn++) {
    let res;
    try {
      res = await fetchImpl(API, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": API_VERSION },
        body: JSON.stringify({ model: p.model || DEFAULT_MODEL, max_tokens: 4000, system: p.system, messages, tools, output_config: { effort: "low" } }),
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });
    } catch (e) { throw new LlmError("Web research timed out or could not reach the AI service: " + (e?.message || e), { kind: "network" }); }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.error?.message || `HTTP ${res.status}`;
      throw new LlmError(`Web research rejected (HTTP ${res.status}): ${msg}`, { kind: res.status === 401 || res.status === 403 ? "auth" : res.status === 429 || res.status >= 500 ? "unavailable" : "rejected", status: res.status });
    }
    out.model = json.model; out.usage.input_tokens += json.usage?.input_tokens || 0; out.usage.output_tokens += json.usage?.output_tokens || 0;
    for (const b of json.content || []) {
      if (b.type === "server_tool_use" && b.name === "web_search") out.searches++;
      if (b.type === "text") {
        out.text += b.text;
        for (const c of b.citations || []) if (c.url && !out.sources.some((s) => s.url === c.url)) out.sources.push({ url: c.url, title: c.title || "" });
      }
    }
    if (json.stop_reason !== "pause_turn" || Date.now() > deadline - 3000) break;
    messages.push({ role: "assistant", content: json.content }); // resume the paused server-side loop
  }
  out.text = out.text.trim();
  return out;
}
