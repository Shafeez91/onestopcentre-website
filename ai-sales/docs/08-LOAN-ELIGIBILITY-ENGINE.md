# Loan eligibility & affordability engine (2026-10-27)

The AI can now run a **preliminary** LPPSA or bank-loan affordability check on WhatsApp, and advisors can run it from the lead page. The calculations are ordinary deterministic code, not AI. The AI only collects the buyer's figures and explains the result. Every number it quotes must come from the engine, and the reply checker blocks any other number.

Every result says it is a preliminary estimate, not an approval, and that LPPSA or the bank makes the final decision.

## 1. Files
| File | What |
|---|---|
| `sales/shared/finance.mjs` (new) | The engine. It is shared by the dashboard and the server, so both always compute the same figures. |
| `ai-sales/lib/financing.mjs` (new) | Connects the conversation to the engine: merges the figures the buyer gave, adds the engine figures to the reply checker's allow-list, and builds the compact context for the AI. |
| `ai-sales/lib/prompt.mjs` | New `financing_updates` field in the reply schema (no union types). New "Loan eligibility" instructions apply only when the engine is on. |
| `ai-sales/lib/orchestrator.mjs` | When a buyer gives new figures, the engine recalculates and the AI rewrites its reply from the new result (at most one extra AI call). Then it saves the figures, records the assessment, hands over to an advisor when needed, and keeps figures out of the AI run log. |
| `sales/shared/validator.mjs` | With the engine on, the old "estimate with assumptions" allowance for amounts under RM20,000 is switched off. An invented instalment is reported as `uncalculated_amount` and blocked. |
| `netlify/functions/sales-ai.mjs`, `sales/js/aitest.js` | The test console carries the loan figures from one simulated message to the next. |
| `sales/js/financing.js` (new) | Lead page **Financing check** card (calculator, live preview, save, history) and **Settings → Financing rules**. |
| `sales/js/crm.js`, `sales/js/admin.js` | Small hooks: the card on the lead page, the settings tab, the new feature switch, and the retention text. |
| `ai-sales/supabase/migrations/20261027000008_ai_sales_financing.sql` (new) | Database changes (section 6). |

## 2. Formulas
- **Instalment** (reducing balance, monthly): `M = P·r·(1+r)^n / ((1+r)^n − 1)`, where `r` = annual rate ÷ 12 ÷ 100 and `n` = months. At a zero rate, `M = P / n`. Invalid input (negative amount, non-whole months) is rejected.
- **Loan a payment can carry** (inverse): `P = M·((1+r)^n − 1) / (r·(1+r)^n)`. At a zero rate, `P = M·n`.
- **Tiered LPPSA profit**: each band (e.g. up to RM750k at 4%, the rest at 4.5%) is treated as its own reducing balance over the same tenure. *Assumption:* LPPSA's exact method for the upper band is not confirmed.
- **Tenure** = min(maximum years, maximum age − age), in whole years.
- **Financing limits** are rounded down to the nearest RM1,000, and instalments to the nearest RM1.

## 3. LPPSA preliminary check
The inputs are: basic salary, fixed allowances, statutory deductions (tax / EPF / SOCSO), existing monthly commitments, age, whether the buyer is confirmed in service, whether this is a second financing, and the property price.

The maximum instalment is the **lowest** of three tests:
1. Instalment ≤ **60%** of (basic + fixed allowances), or **50%** for a second financing.
2. All deductions including the new instalment ≤ **80%** of net income (basic + fixed allowances − statutory deductions).
3. Pay left after all deductions ≥ **20%** of (basic + fixed allowances).

Maximum financing = min(what the income carries, RM1,000,000 cap, 100% of price/valuation). Tenure runs up to 35 years or until age 90.

The check is flagged for an advisor when the buyer:
- is not confirmed in service,
- has under 1 year of service,
- is taking a second financing, or
- gets a challenging result.

**Verification status: NOT verified against the official source.** The official LPPSA site (`myfinancing.lppsa.gov.my`, FAQ page found by search) could not be reached from my environment. The rules come from secondary sources that agree on the 60/80/20 tests:
- loanstreet.com.my
- fareezlaw.com
- rumahhq.com
- ecentral.my
- freemalaysiatoday.com

The rate above RM750k (4.5%) and the RM1M limit (announced in Budget 2026) are the least certain.

Because of this:
- All rules are owner-editable in Settings → Financing rules, with a version, source, "Verified" tick and date.
- Until the box is ticked, every result says the rules are not yet verified, and the AI tells buyers an advisor will confirm them.

## 4. Bank DSR check (illustrative)
These are not any bank's policy and are labelled so everywhere.

Recognised income:
- 100% of fixed pay
- 50% of variable income
- 60% of self-employed income
- plus a joint applicant's fixed income

Net income = recognised income − statutory deductions. Commitments = existing instalments + 5% of the credit card balance.

For each DSR scenario (default 60 / 70 / 80% of net income):
- max instalment = DSR × net − commitments
- max loan = the loan that instalment carries at 4.2%, over up to 35 years or until age 70 (whichever applicant is older)
- capped by the margin of finance: 90%, or 70% from the 3rd housing loan

Self-employed and joint applications always go to an advisor.

## 5. Results
**Outcome labels** (English / Bahasa Malaysia):
- **Potentially affordable / Berpotensi mampu milik**: the amount needed is within the limit (LPPSA), or within the strictest bank scenario.
- **May be affordable with adjustments / Mungkin mampu milik dengan pelarasan**: the amount needed is up to 20% above the limit (adjustable), passes only a looser bank scenario, or works only with a bigger down payment because of the cap or margin.
- **Potentially challenging / Berpotensi mencabar**: anything beyond that, no net income or tenure left, or not confirmed in service. These are sent to an advisor.
- **Insufficient information / Maklumat belum mencukupi**: required figures are missing. The engine returns the next one or two questions to ask.

**Upfront cost estimate**:
- down payment
- MOT stamp duty: 1% / 2% / 3% / 4% tiers
- loan stamp duty: 0.5%
- legal fees for the SPA and the loan agreement: SRO 2023 scale (1.25% of the first RM500k, then 1%, minimum RM500) + 8% SST

Possible first-home exemptions are mentioned but not deducted.

**Project suggestions**: projects at or slightly above the price the figures support. Verified prices are used before website prices, and every suggestion shows its price label.

## 6. Database (migration 8, additive only)
- `ai_settings.financing` (jsonb, default `{}`): the owner's overrides. Empty means the built-in defaults.
- `ai_financing_profiles`: one row per lead with the figures collected so far and the latest result.
- `ai_financing_assessments`: append-only history of completed calculations: inputs, result, rules version, engine version, whether the AI or an advisor ran it, and when.
- **Access**: only advisors and above can read or write these tables. Viewers see only the outcome label stored on the lead. A recorded assessment cannot be edited. Managers and above can delete.
- **Audit**: both tables are audited.
- **PDPA erasure**: `ai_erase_contact` now deletes both tables' rows for the contact and scrubs them from the audit log.
- **Retention**: `ai_purge_expired` now deletes financing rows older than `compliance.financing_retention_days` (default 365, minimum 30) and scrubs their audit entries.
- **Run log**: the AI run log records only which fields changed and the outcome, never the figures.

## 7. Conversation rules (in the AI instructions, enforced by code where possible)
- The AI asks LPPSA or bank first, then one or two questions at a time, using the engine's next questions. It addresses the buyer as Tuan/Puan and accepts rough figures.
- It never asks for an IC number, payslip, bank statement, online banking login, CCRIS/CTOS report or any document.
- It quotes only engine figures. **Enforced:** the reply checker allows only the engine's numbers, the buyer's own figures and verified prices.
- It always says the result is a preliminary estimate, not an approval. **Enforced:** guarantee language is blocked.
- It hands over to an advisor (reason "financing") on the triggers above, or when the buyer disputes the result or wants a full assessment. **Enforced:** a new result that needs an advisor creates a handover automatically, with a summary for the advisor.

## 8. Switching it on
- **Settings → Feature switches → Loan eligibility engine.** It is off by default for WhatsApp.
- The AI test console always uses the engine, so you can try it first.
- The lead page calculator works for advisors and above whatever the switch says.

## 9. Tests (all run, all passing)
- **Unit tests** (`finance.test.mjs`, 17; plus 5 pipeline tests in `ai.test.mjs`). The expected values were computed independently in Python, not by running this code. They cover:
  - the instalment formula and its zero-rate case
  - the inverse formula and tiered rates
  - tenure
  - the three LPPSA tests and the binding test
  - second financing and the RM1M cap
  - shorter tenure for an older applicant
  - outcome bands
  - not confirmed in service, and missing information
  - bank scenarios, the 70% margin from the 3rd loan, the credit card 5% rule, variable / self-employed / joint income
  - owner overrides and upfront costs
  - project suggestions
  - merging of the AI's figures
  - the strict reply check
  - recalculate-then-rewrite, an invented instalment being blocked, the switch being off for live chats, escalation, saving, and figures kept out of the run log
- **Database tests** (T41): access only for advisors and above, the history cannot be edited, constraints, the audit trail, PDPA erasure (including audit scrub), and retention purge.
- **Browser tests**: the lead card shows the saved result; the calculator previews and saves a bank check on a phone and on desktop; settings check and save the rule set; viewers neither see the card nor fetch the figures. The test console carries the figures between messages.
- **Layout audit**: the new card and settings tab are included, with no findings at all 12 widths.
- Full suite: regression 40, unit 136, database all, browser 20 + layout 12.

## 10. Limitations
- The LPPSA rules are unverified (section 3). Please check them against the official LPPSA FAQ or a circular, then tick Verified.
- Bank figures are generic assumptions. Real banks differ in DSR bands, income recognition, CCRIS/CTOS checks, stress rates and age limits.
- The engine does not cover:
  - the LPPSA joint-financing scheme for spouses who are both public servants
  - pension-scheme specifics
  - MRTA/MLTA
  - developer packages
  - stamp duty exemptions
  - refinancing
- All figures are as the buyer stated them; nothing is checked against documents.
- Not verified on a real iPad or iPhone, or with a real advisor account (tested with headless Chromium and a fake backend).
