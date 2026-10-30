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

## Readability rules (29 Oct 2026, later)

The owner wants short, simple WhatsApp replies. The instructions ask for at most 3 short paragraphs per message
(prefer 1–2), one idea per paragraph, about 20–60 words, and a second message only when it is genuinely useful. The
code checks this as well (`messageStyle` in `orchestrator.mjs`, limits in `STYLE`):

| Rule | Limit | Code |
|---|---|---|
| Paragraphs per message | 3 | `too_many_paragraphs` |
| Words per paragraph (bullet lines not counted) | 40 | `long_paragraph` |
| Bullet points per list | 5 | `long_list` |
| Words per message | 65 | `long_message` |
| Words in the whole turn (all messages) | 80 | `long_turn` |
| Monthly instalment the buyer did not ask about | none | `unasked_instalment` |
| Characters per message (`max_reply_chars`) | setting | `too_long` |

These are **style rules**. A draft that breaks them is rewritten once with the feedback (one extra AI call). If the
rewrite still breaks them slightly, it is sent anyway and `style_notes` records why; it never falls back to the safe
message. Business rules (prices, guarantees, availability…) still block.

The limits were calibrated on the real messages of 29 Oct: the owner's example and a compact comparison pass, and the
77-word message whose first paragraph packed four topics into 47 words is flagged. (Bullet marks and dashes are not
counted as words.)

**Shorter turns (29 Oct, second pass).** After the 3-paragraph update each message stayed under 65 words, but two
messages together still reached 80–100 words, mostly because a plain "how much?" also got a monthly-instalment example.
Now the whole turn is checked (about 80 words), and a monthly figure (ansuran, RM…/month, sebulan) is flagged unless the
buyer asked about monthly payments, loans or financing in this message or their last 4 (`MONTHLY_Q`). The prompt says
the same: a price question gets the price only (at most 3 layout lines), the monthly figure is offered as a short
question, and recommendations name at most 2–3 projects. Follow-up messages (no buyer message) skip the monthly check.

## Two quick buyer messages

On 29 Oct a buyer sent two messages 4 seconds apart while the AI was still writing the reply to the first. Both
replies went out (3 overlapping messages). The sender now also checks for a newer buyer message **before the first
message** of an AI reply. If there is one, the older reply is dropped whole (status `skipped`, with the reason, and
no staff task), and the reply to the newer message, which reads every message since the last delivered one, answers
both. Fixed replies (STOP, "talk to a person") always go out.

## Reply style: Standard or Short chat (30 Oct)
Settings → AI persona → **Reply style** (`persona.reply_style`, default `standard`).

- **Standard:** the rules above.
- **Short chat (`short`):** up to 3 one-line messages of about **7–10 words**.
  - Message 1 answers the question, short and confident.
  - Message 2 explains.
  - Message 3 adds one detail or asks the one question.
  - A simple message (thanks, ok) gets one reply.

The prompt gets a separate "short chat" section instead of the standard one; the owner's tone guidance is kept. The checker (`STYLE_SHORT`) flags a message over **15 words**, with **+8** for the AI introduction and **+6** for a required price or loan note. Paragraph length is not checked, only the whole message. As always, a draft that is too long is rewritten once and never blocked; business rules are unchanged.
