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
 * @param {object} p { system, messages, schema, model, effort, maxTokens, apiKey, fetchImpl, retries }
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
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(8000, 800 * 2 ** (attempt - 1)) * (p.backoffScale ?? 1)));
    let res;
    try {
      res = await fetchImpl(API, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": API_VERSION, "anthropic-beta": FALLBACK_BETA },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = new LlmError("Network error calling the AI service: " + (e?.message || e), { kind: "network", retryable: true });
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new LlmError(`AI service busy or unavailable (HTTP ${res.status}).`, { kind: "unavailable", status: res.status, retryable: true });
      continue;
    }
    let json;
    try { json = await res.json(); } catch { throw new LlmError(`Unreadable response from the AI service (HTTP ${res.status}).`, { kind: "bad_response", status: res.status }); }
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
  throw lastErr;
}
