# Financing documents (30 Oct 2026)

Staff upload a buyer's **payslip, CCRIS report or bank statement** on the lead page (Sales tab → Financing check →
Financing documents). The AI reads the figures, a staff member checks them, and the loan calculator does the LPPSA /
bank estimate as before. The AI never decides alone, and nothing is sent to the buyer.

## How it works
1. **Upload** (advisor, manager or owner): PDF, JPG, PNG or WEBP, up to 4 MB. Photos are scaled to 1600 px in the
   browser first. The file goes to `/api/sales/financing/documents`, which stores it in the private Supabase Storage
   bucket `ai-financing-docs` and a row in `ai_financing_documents`.
2. **Read**: one AI call (counts towards the daily AI limit) with the file and a strict output schema
   (`ai-sales/lib/documents.mjs`). It returns figures only:
   - payslip: basic pay, fixed allowances, overtime / commission, statutory deductions (PCB, EPF, SOCSO, EIS), loan
     deductions (LPPSA, koperasi, ANGKASA, BPA, car), other deductions, gross / net pay, employer type (government /
     statutory body / private), birth year, appointment date, service status
   - CCRIS: each facility with its monthly instalment, outstanding balance, arrears; credit cards; special attention account
   - bank statement: months covered, average salary credit, regular loan payments, month-end balance, returned payments
3. **Check**: the lead page shows what was read, warnings, and the **suggested calculator figures** with the source of
   each (`sales/shared/finance-docs.mjs` → `suggestInputs`) and what to check, e.g.:
   - CCRIS replaces the payslip's loan deductions for monthly commitments; koperasi / ANGKASA deductions missing from
     CCRIS are flagged
   - cards count as a balance (the engine takes 5% a month), not as an instalment
   - arrears or a special attention account → an advisor must review
   - bank statement net salary more than 15% away from the payslip net pay
   - a bank statement alone never fills basic salary
4. **Use**: "I checked these: use in calculator" fills the calculator and marks the documents confirmed (who and when).
   Route, property price and down payment are always chosen by staff. **Save to lead** stores the result as before.

## Privacy (PDPA)
- The bucket is private, with no storage policies for signed-in users: only the server reaches it. Viewing uses a
  60-second signed link.
- The AI is told never to return names, IC, account, card, employee or reference numbers; whatever it returns is
  masked again in code (IC pattern and any number of 10+ digits).
- **Deleted after 30 days** (`compliance.financing_docs_retention_days`): the worker runs the purge every hour
  (file, row and what was read). Files of deleted leads and stray files with no row are deleted too.
- PDPA erase of a contact wipes what was read at once and the files go within the hour.
- No audit trigger on the table (so nothing read is copied into the audit trail); the server audits upload, read,
  view, confirm and delete without figures.
- Only upload documents the buyer agreed to share for this check. Viewers never see the box.

## Switch
Settings → Feature switches → **Financing documents** (on by default after migration 19).

## Limits
- It reads documents; it does not check CCRIS or CTOS itself, and it is not a loan approval.
- LPPSA results stay marked "rules being confirmed" until the owner verifies the LPPSA rules (Settings → Financing rules).
- One page or one PDF at a time; a 30-second request limit applies (the read has 25 s).

## Files
`ai-sales/supabase/migrations/20261030000019_ai_sales_financing_documents.sql` · `netlify/functions/sales-financing-docs.mjs` ·
`ai-sales/lib/documents.mjs` · `sales/shared/finance-docs.mjs` · `sales/js/financing.js` · tests:
`ai-sales/tests/unit/financing-docs.test.mjs`, DB T66, browser "financing documents".
