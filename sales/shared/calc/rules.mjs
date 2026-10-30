// Versioned rules for the financing calculators, each tied to the source it came from. The figures the owner can
// change in Settings → Financing rules (ai_settings.financing) are overlaid on these defaults by lppsaRuleset() /
// bankRuleset(); everything else changes only with a new version here (and a new entry in SOURCES).
//
// Verification status (30 Oct 2026): the LPPSA web domains (lppsa.gov.my, myfinancing.lppsa.gov.my,
// selfservice.lppsa.gov.my) cannot be opened from the development environment, and Smart Kira needs an IC number, so
// no rule could be read on the official page itself or compared with Smart Kira. "official (quoted)" means a web search
// quoted the official LPPSA page; "secondary" means published guides only; "assumption" means no published rule found.
import { financingRules } from "../finance.mjs";

export const VERIFIED_ON = "2026-10-30";

export const SOURCES = {
  lppsa_faq4: { org: "LPPSA", url: "https://myfinancing.lppsa.gov.my/my/faq4", status: "official (quoted)",
    rule: "Instalment ≤ 60% of basic salary + eligible fixed allowances (50% for a second financing); total debt ≤ 80% of net income (basic + eligible fixed allowances − mandatory deductions); net salary ≥ 20% of gross income. Eligible fixed allowances: ITP, ITKA, ITK, ITKT, ITJU, EPW, acting allowance, COLA, BIW, BISM, BISS." },
  lppsa_faq23: { org: "LPPSA", url: "https://myfinancing.lppsa.gov.my/my/faq23", status: "official (quoted)",
    rule: "SPPM (applicants aged 30 and below): tenure up to 40 years (480 months) or age 90 for the pension scheme, or the end of service for the KWSP scheme, whichever is earlier." },
  lppsa_rate: { org: "LPPSA (Smart Kira, as reported)", url: "https://www.lppsa.gov.my/en/kalkulator-anggaran-pembiayaan", status: "secondary",
    rule: "Profit 4.00% on the first RM750,000 and 4.50% on the part above, up to RM1,000,000, as one weighted-average rate on the whole amount: {(A1 × 4.00%) + (A2 × 4.50%)} / amount (e.g. RM800,000 → 4.03%, RM1,000,000 → 4.13%).", effective: "Budget 2026 (reported 23 Sep / 4 Oct 2026)" },
  lppsa_max: { org: "LPPSA (Budget 2026, as reported)", url: "https://www.majalahlabur.com/pelaburan-hartanah/lppsa-kedua-boleh-mohon-walaupun-pembiayaan-pertama-belum-habis-ini-syarat-kelayakannya/", status: "secondary",
    rule: "Maximum financing RM1,000,000 (was RM750,000); second financing allowed before the first is settled, within the remaining eligibility.", effective: "4 Oct 2026 (reported)" },
  lppsa_tenure: { org: "LPPSA (as reported)", url: "https://calculatormalaysia.com/calculator/lppsa-calculator-malaysia/", status: "secondary",
    rule: "Normal financing: up to 35 years or age 90 (pension scheme), whichever is earlier. KWSP scheme: until the end of service (retirement age)." },
  lppsa_package: { org: "LPPSA Garis Panduan Pembiayaan Perumahan Bil. 1/2024 (as reported)", url: "https://rumahibs.com/garis-panduan-pembiayaan-perumahan-lppsa-bil-1-2024/", status: "secondary",
    rule: "The approved financing includes the property price, the MRTA/MRTT premium and LTHO, and the financing legal fees; approved = the lowest of price, valuation and the applicant's eligibility." },
  sro_legal: { org: "Solicitors' Remuneration Order 2023 (as reported)", url: "https://guaman.my/panduan/kos-guaman-pinjaman-perumahan-lppsa/", status: "secondary",
    rule: "Legal fee on a financing agreement: 1.25% of the first RM500,000 (minimum RM500), 1.00% above; SST 8% on the fee." },
  bnm_mof: { org: "Bank Negara Malaysia (as reported)", url: "https://www.iproperty.com.my/guides/bank-negara-malaysia-s-lending-policies-how-do-they-affect-you-4793", status: "secondary",
    rule: "Margin of financing capped at 70% for a borrower's third and later outstanding housing loans; maximum tenure 35 years." },
  bank_dsr: { org: "—", url: "", status: "assumption",
    rule: "No bank publishes its DSR limits or income-recognition rules. 60% / 70% / 80% DSR and the recognition percentages are indicative scenarios, not any bank's policy." },
  bank_age: { org: "—", url: "", status: "assumption", rule: "Repayment by age 70 is common practice reported by guides, not a published BNM rule." },
};

/* ---------- LPPSA ---------- */
export const LPPSA_ALLOWANCES = [
  ["itp", "ITP"], ["itka", "ITKA"], ["itk", "ITK"], ["itkt", "ITKT"], ["itju", "ITJU"], ["epw", "EPW"],
  ["acting", "Elaun memangku (acting)"], ["cola", "COLA"], ["biw", "BIW"], ["bism", "BISM"], ["biss", "BISS"],
];

export function lppsaRuleset(saved) {
  const R = financingRules(saved).lppsa, C = financingRules(saved).costs;
  return {
    version: `CALC-LPPSA-1 / ${R.rules_version}`, owner_verified: !!R.verified, owner_verified_on: R.verified_on || null,
    instalment_pct: { first: R.repayment_pct_first, second: R.repayment_pct_second }, // faq4
    debt_pct_of_net: R.dsr_pct,                                                       // faq4
    min_net_pct_of_gross: R.min_net_pct,                                              // faq4
    rate_tiers: R.rate_tiers, rate_method: "weighted_average",                        // lppsa_rate
    max_financing: R.max_financing, margin_pct: R.margin_pct,                         // lppsa_max
    tenure: { normal_years: R.max_tenure_years, sppm_years: 40, sppm_max_age: 30, pension_max_age: R.max_age }, // lppsa_tenure, faq23
    min_service_years: R.min_service_years,
    legal: { tiers: C.legal_tiers, min: C.legal_min, sst_pct: C.legal_sst_pct },     // sro_legal
    allowances: LPPSA_ALLOWANCES.map(([k]) => k),                                     // faq4
    sources: ["lppsa_faq4", "lppsa_faq23", "lppsa_rate", "lppsa_max", "lppsa_tenure", "lppsa_package", "sro_legal"],
  };
}

/* ---------- banks ---------- */
// official calculator pages where one was found; no bank-specific rates or DSR limits are stored (none verified)
export const BANKS = [
  { key: "", name: "Any bank (indicative)", calculator: null },
  { key: "maybank", name: "Maybank / Maybank Islamic", calculator: "https://www.maybank2u.com.my/maybank2u/malaysia/en/tools-calculators/home-loan-financing.page" },
  { key: "hlb", name: "Hong Leong Bank", calculator: "https://www.hlb.com.my/en/personal-banking/help-support/property-financing-tools.html" },
  { key: "cimb", name: "CIMB", calculator: null }, { key: "pbb", name: "Public Bank", calculator: null }, { key: "rhb", name: "RHB", calculator: null },
  { key: "bimb", name: "Bank Islam", calculator: null }, { key: "bsn", name: "BSN", calculator: null },
  { key: "ambank", name: "AmBank", calculator: null }, { key: "bank_rakyat", name: "Bank Rakyat", calculator: null }, { key: "other", name: "Other bank", calculator: null },
];

export function bankRuleset(saved) {
  const B = financingRules(saved).bank;
  return {
    version: "CALC-BANK-1", label: "Indicative scenario — not any bank's eligibility assessment",
    default_rate_pct: B.rate_pct, max_tenure_years: B.max_tenure_years, max_age: B.max_age,          // bnm_mof, bank_age
    margin_options: [70, 80, 85, 90, 95, 100], third_loan_max_margin_pct: B.margin_pct_third,          // bnm_mof
    dsr_options: B.scenarios.map((s) => ({ label: s.label, dsr_pct: s.dsr_pct })), default_dsr_pct: (B.scenarios[1] || B.scenarios[0]).dsr_pct, // bank_dsr
    variable_income_pct: B.variable_income_pct, self_employed_income_pct: B.self_employed_income_pct, credit_card_pct: B.credit_card_pct,      // bank_dsr
    sources: ["bnm_mof", "bank_dsr", "bank_age"],
  };
}
