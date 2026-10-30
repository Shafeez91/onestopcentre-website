# Financing tools: LPPSA and bank loan calculators (30 Oct 2026)

Internal advisor tools in the left sidebar → **Financing tools**:
- `#/calc-lppsa` LPPSA calculator
- `#/calc-bank` Bank loan calculator
- `#/calc-compare` LPPSA vs bank (linked from both pages)

They are open to signed-in staff; **Save to client** needs advisor or above (the existing RLS on
`ai_financing_assessments`). Nothing is sent to buyers.

## Architecture
| File | What |
|---|---|
| `sales/shared/calc/decimal.mjs` | Exact fixed-point decimals (BigInt × 10^24); half-up rounding to the sen |
| `sales/shared/calc/amortize.mjs` | Repayment maths only: A = P·r·(1+r)^n / ((1+r)^n − 1); zero rate A = P/n; inverse; totals |
| `sales/shared/calc/rules.mjs` | Versioned rulesets with a source and status for every rule (`SOURCES`); LPPSA figures editable in Settings → Financing rules are overlaid |
| `sales/shared/calc/lppsa.mjs` | LPPSA eligibility (separate from the maths) |
| `sales/shared/calc/bank.mjs` | Bank indicative scenario (separate module; no LPPSA rules) |
| `sales/shared/calc/summary.mjs` | WhatsApp text and the comparison |
| `sales/js/calculators.js` | The three pages |

Every result carries an `audit` block: time, calculator, engine version, ruleset version, sources, inputs, rate,
tenure, status and warnings. **Save to client** stores it in `ai_financing_assessments` (shown in the lead's
financing history) with an activity note. No database migration.

## LPPSA formulas
- gross = basic + eligible fixed allowances (only the 11 listed in the LPPSA FAQ: ITP, ITKA, ITK, ITKT, ITJU, EPW, acting allowance, COLA, BIW, BISM, BISS)
- net = gross − mandatory deductions (PCB, KWSP, PERKESO, EIS)
- Each test is computed on its own, as the maximum instalment it allows:
  1. 60% × gross (50% for a second financing)
  2. 80% × net − financing deductions (existing LPPSA instalment + other financing)
  3. gross − mandatory − financing − other deductions − 20% × gross
- Maximum eligible instalment = the lowest of the three (floored to the sen).
- Profit: one weighted-average rate on the whole amount, {(A1 × 4.00%) + (A2 × 4.50%)} / A with A1 ≤ RM750,000.
  Eligibility is the largest amount whose instalment fits (solved to the sen), capped at RM1,000,000.
- Tenure: normal 35 years, SPPM 40 years (aged 30 and below); pension scheme to age 90, KWSP to the retirement age;
  a shorter tenure if requested.
- Financing = property part (≤ 100% of the lower of price and valuation, or the amount requested) + MRTT premium +
  other financed costs + the financing legal fee. The legal fee is the SRO scale on the whole amount + 8% SST, solved
  because it depends on itself; or a quoted fee; or paid in cash.
- Approvable estimate = the lowest of the request, the eligibility and the maximum. When capped, the costs are taken
  on the capped total and the property part gets the rest.
- Remaining income = gross − mandatory − financing − other deductions − instalment.

## Bank formulas (indicative)
- recognised income = basic + fixed + variable × 50% + business × 60% (both % editable)
- net = recognised income − statutory deductions
- Commitments are itemised; each is ticked "counted" or not for the selected bank. A card balance can be used instead,
  counted at 5% a month.
- max instalment = DSR × net − counted commitments; indicative maximum = principal for that instalment.
- financing = price × margin + MRTA/MLTA + capitalised fees.
  - Margin capped at 70% from the 3rd housing loan (Bank Negara Malaysia).
  - Above 90% is flagged as product- and applicant-specific.
- Tenure ≤ 35 years and repaid by age 70 (an assumption).
- Rate and DSR are the advisor's choice (60 / 70 / 80%).

## Status labels
- Within indicative eligibility
- Potentially exceeds eligibility
- More information required
- Cannot assess with supplied information

None is green, and every page and summary says it is not an approval.

## Verification status (30 Oct 2026)
- **LPPSA:** `lppsa.gov.my`, `myfinancing.lppsa.gov.my` and `selfservice.lppsa.gov.my` cannot be opened from the
  development environment. Smart Kira also needs an IC number, which we do not submit. So:
  - The tests and the allowance list come from search results quoting the official FAQ.
  - The rate structure, the RM1M maximum and the tenure come from secondary sources.
  - **No result has been compared with Smart Kira.** Compare a few real cases there; send any difference to be fixed.
  - The LPPSA ruleset stays "not yet verified" until the owner ticks Verified in Settings → Financing rules.
- **Banks:**
  - Only Maybank and Hong Leong Bank official calculator pages were found.
  - No bank publishes DSR limits or income-recognition rules, so the bank calculator is an indicative scenario.
  - No bank rates are stored.
- The existing lead-page engine (`finance.mjs`) now uses the same weighted-average LPPSA rate (RM1M: RM4,503.04 a
  month instead of RM4,504 with separate bands).

## Tests (run 30 Oct 2026)
- `ai-sales/tests/unit/calculators.test.mjs`, 20 tests:
  - maths against Python `decimal` reference values
  - LPPSA scenarios 1–14
  - bank scenarios 1–12
  - audit trail
  - LPPSA calculator vs lead-page engine
  - summaries
- Browser test "financing tools": sidebar, live results, validation, copy, save to client, comparison, reset.
- Layout tests (no horizontal scroll at phone, tablet and desktop sizes) cover the 3 new routes.

## Auto-fill from documents (30 Oct 2026, evening)
Both calculators have an **Auto-fill from documents** panel (advisors and above; Settings switch "Financing documents").
- **Upload:** a payslip, CCRIS report or bank statement goes to `/api/sales/financing/documents` with `action: "extract"`.
- **Read-only:** the AI reads it (the same reader as the lead page) and the figures come back; **the file and the figures
  are not stored** on the server. The daily AI limit applies, and an audit entry records the action without figures.
- **Read once, use in both:** what was read stays in the browser tab, so the other calculator can use it ("Fill this
  calculator from N documents"). "Forget documents" clears it.
- **Mapping** (`sales/shared/calc/autofill.mjs`):

| Calculator | Fields filled |
|---|---|
| LPPSA | basic salary; each eligible allowance by its code (COLA = Bantuan Sara Hidup); PCB / KWSP / PERKESO / EIS / other statutory; financing deductions; an LPPSA deduction → second financing + existing instalment; other deductions; age (birth year); service status; KWSP scheme when KWSP is deducted |
| Bank | basic salary, fixed allowances, average variable pay, statutory total; commitments by type from CCRIS (car, personal, property, PTPTN, other; cards as a balance), else from the payslip or statement; age; employer type |

- **Highlighting:** filled fields are highlighted, with the source as a tooltip. A field the advisor edits is no longer
  highlighted.
- **Checks** are listed, e.g. allowances LPPSA does not count, a CCRIS facility with no instalment, koperasi missing
  from CCRIS, arrears, low confidence, a private employer on the LPPSA page.
- The property price, rate and DSR are never filled.
