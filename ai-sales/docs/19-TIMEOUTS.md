# Request time limits (incident 29 Oct 2026: "Server error 504" in the AI test console)

## What happened
Netlify logs for `/api/sales/ai/simulate` on 29 Oct, 10:50–11:01 UTC: four requests ended with **504 at 30.4–31.3 s**
(the function limit for this site). The AI run log shows the same turns took **33–48 s** in all. They were hand-over
drafts (e.g. "Does it has shuttle service?") that started **web research** (up to 20 s) and then a **second draft**
with the findings, all inside the one request. The function kept running after the gateway gave up, so the runs were
still logged. The browser showed only the toast, because the console redrew the chat and erased its own error card.

The WhatsApp webhook had a related problem. Each incoming message claimed up to **5** reply jobs and worked through
them one by one inside its own 30-second limit. A job claimed but not finished stayed locked until it went stale
(5 minutes); one buyer waited 7.6 minutes on 29 Oct.

## What changed
| Where | Change |
|---|---|
| `llm.mjs` `callClaude` | `deadline`: the request is aborted at the deadline (`LlmError` kind `timeout`), and a retry is made only if it can finish. |
| `orchestrator.mjs` `respond` | `budgetMs`: every AI call gets the deadline. A style rewrite, a financing recalculation or a map lookup runs only when it fits (otherwise the draft goes out with its style notes; a draft breaking a business rule is still blocked). Web research that does not fit is returned as `pending_research`. `timings` (data, maps, each AI call, web, total) are recorded. |
| `sales-ai.mjs` (console) | Budget 23 s. A reply needing web research continues in two more requests, each under the limit: the research (26 s, 2 searches and 1 page read; 21 s with 3 + 2 timed out on 29 Oct), then the second draft with the findings. They are chained by a signed token (`continuation.mjs`, HMAC, bound to the staff member, message and history, 10 minutes) so findings cannot be supplied from the browser. Each step logs one JSON line (`evt: ai_simulate`, request id, step, decision, timings) with no message text. The daily AI limit is charged once per buyer message. |
| `worker.mjs` `runWorker` | `budgetMs`: jobs are claimed **one at a time** and only while one can finish (≥ 18 s left). The reply gets the remaining time. Webhook and scheduled worker 26 s each. A live reply that still times out is retried once on the next run before the buyer gets the safe reply. Follow-up AI messages are only composed with time for them. |
| Run log | `output.research` and `output.timings` are now stored (the research trace was not saved before). |
| Console | The draft is shown at once; "Checking outside sources…" while research runs; the final reply replaces the draft. A 504 explains the 30-second limit, keeps the typed message and the chat, and the error card stays. Managers see a **Timing** row and the request id. |

Live WhatsApp replies still do not run web research (no time for it inside 30 s). They hand over as before.

## Distances the listing contradicts
Also from the same session: the console reply said "around 2.4km" for LRT Sri Rampai while M MIRA's listing gives
650 m in the Location & accessibility text and 2.4 km in the station list. A new business rule (`disputed_distance`)
stops either figure being stated for that station until a Google Maps lookup measures it. Other stations keep their
figures.
