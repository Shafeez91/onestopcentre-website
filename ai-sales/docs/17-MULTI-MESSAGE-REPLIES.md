# 17 · Several WhatsApp messages in one AI turn

## Root cause (29 Oct 2026)

The persona's Section 6A describes a "message 1 / message 2" style and says to send a second message "when
supported by the existing messaging workflow". Nothing in the pipeline supported it:

- **Model output:** the reply schema had a single `reply` string, so the model could only return one text and folded
  everything into it, with blank lines between the parts.
- **Sender:** the worker sent `result.reply` as one WhatsApp message, keyed by the job id.
- **Console:** rendered `reply` as one bubble.

The prompt was not the cause. All three layers had to change.

## How it works now

| Layer | Behaviour |
|---|---|
| Schema (`prompt.mjs`) | `messages`: 1–3 strings, replacing `reply`. `normalizeReply()` keeps `reply` as the messages joined with a blank line, for the checker, logs and older code. More than 3 are folded into the third, so no text is lost. Nothing is split by us. |
| Instructions | A "WhatsApp messages" section: a paragraph break is not a new message; default to one message; a second or third only when it is distinct (answer → value → one question); hand-overs, opt-outs, complaints and sensitive topics are one message; the AI introduction goes in message 1 and the question in the last. The persona text (Sections 1–18, 6A) is unchanged. |
| Business rules (`checkTurn`) | Every content rule runs on the whole turn. The length limit (`max_reply_chars`) applies to each message. |
| Decision | Only a normal AI reply keeps separate messages. Blocked drafts, hand-overs, opt-outs, outages and the daily cap send one message. |
| Sender (`sendTurn` in `worker.mjs`) | All messages are recorded first (`ai_messages`, status `queued`), then sent in order, each as its own WhatsApp message and row. Before every message after the first: a 1.2 s pause, then a check that the buyer has not written again. `sendOutbound` re-checks who owns the conversation before each AI message. |
| Idempotency | `source_job_id` is unique: message 1 keeps the job id (as before) and messages 2–3 use a fixed UUID derived from it (`segmentKey`). A retried job re-sends only what is still `queued`/`failed`, without calling the AI again. No database change. |
| Take-over / buyer writes again | Remaining messages are marked `skipped` with the reason and are never sent later. Skipped messages are left out of the AI's conversation history and do not count as "our last message", so the buyer's new message gets a fresh reply that only knows what was actually sent. |
| CRM | One AI run, one set of CRM actions, one follow-up restart per turn. Telegram rules are unchanged. |
| Test console | One bubble per message, numbered 1/3, 2/3, 3/3, with "N WhatsApp messages" in the status line. Simulation still sends and writes nothing. |
| Follow-ups | Written as a single message, as before (joined text). |
| Safety net | If the API ever refuses the `messages` schema, the call is retried once with `REPLY_SCHEMA_SINGLE`, the single-`reply` shape that ran in production before. The reply goes out as one message and `output.degraded` in `ai_agent_runs` says why. |
| Client insights | Not part of the reply call. They come from a separate `lead_insights` job after the reply (see 16-CLIENT-WORKSPACE.md). |

## Tests

- `tests/regression/multi-message.test.mjs`: schema, cleaning and cap, instructions, per-message length, which decisions keep several messages, and simulation writing nothing.
- `tests/unit/phase4.test.mjs`: three messages sent in order with one record each and CRM updated once; one-message turns unchanged; human take-over mid-turn; buyer writing during delivery; a failed second message retried alone; hand-overs as one message.
- `tests/e2e/browser.test.mjs`: the console shows three bubbles for a three-message turn and one for a one-message turn.
