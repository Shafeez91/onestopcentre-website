# Brochures on WhatsApp and "Read with AI" (30 Oct 2026)

## 1. The AI sends brochures
Knowledge → Documents → a file marked **AI may send this file to buyers** ("Shareable").
- The reply AI is given the shareable **PDF, JPG and PNG** files (PDF up to 100 MB, photos up to 5 MB, WhatsApp's
  limits) of the project(s) being discussed, plus general ones; all of them while no project is in focus yet.
  Videos and other types are never offered.
- When the buyer asks for a brochure, e-pamphlet, price list or floor plan, the AI names the file as `file:<id>` in
  `facts_used` (no new schema field: the reply schema is at its compiled-grammar size limit) and says it is sending it.
  At most 2 files per reply, and only on a normal reply (never with a hand-over or a blocked draft).
- The worker sends the files **after** the whole reply went out: a PDF as a WhatsApp document with its file name, a
  photo as an image, by a 1-hour signed link to the private `ai-docs` bucket (Meta downloads it once).
- Checked again just before sending: the file must still be shareable, and the AI must still own the chat (a person
  who took over stops it). Not twice to one chat within 10 minutes; a retried job never sends a file twice.
- Recorded in the chat as "[document] file name" with the document id, so the inbox and the AI's history show it.
- Only inside WhatsApp's 24-hour window (it is a reply to the buyer). No brochure in the files list → the AI shares
  the website brochure link, or says an advisor will send it.
- The AI test console shows "Send file after the reply: …" in the actions; nothing is sent from the console.

## 2. Read with AI (brochures without selectable text)
Knowledge → Documents → **Read with AI** (managers and owners) on PDFs and photos.
- The browser renders each page to a 1600-px JPEG and sends 3 pages per request to `/api/sales/knowledge/read`
  (each request fits the 30-second limit; up to 40 pages per file).
- The AI writes one entry per topic (overview, each layout, facilities, location and distances, fees, promotions),
  copying figures exactly as printed, with "Source: file, page N". IC numbers are masked.
- Entries are saved as **drafts**: the AI uses nothing until a manager approves them in Knowledge entries. Approved
  figures then count as verified for the business-rule checker.
- Each request counts towards the daily AI limit. "Read again with AI" adds new drafts next to the old ones.

## Files
`ai-sales/lib/context.mjs` (files), `prompt.mjs` (rule, `send_files` from `facts_used`), `orchestrator.mjs`
(`send_file` action), `worker.mjs` (`sendFiles`), `outbound.mjs` and `whatsapp.mjs` (document / image messages),
`live.mjs` (`knowledgeFiles`), `netlify/functions/sales-knowledge-read.mjs`, `sales/js/knowledge.js`, `sales/js/aitest.js`.
Tests: `ai-sales/tests/unit/brochures.test.mjs`, browser "knowledge: Read with AI". No database migration.
