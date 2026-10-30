// Plain-text summaries of a calculator result (copy for WhatsApp, saved notes) and the LPPSA vs bank comparison.
// Figures come only from the calculator results; nothing is recalculated here except the upfront cash.

const rm = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : "RM" + Number(n).toLocaleString("en-MY", { minimumFractionDigits: d, maximumFractionDigits: d }));
const rm0 = (n) => rm(n, 0);
const STATUS_MS = { within: "Dalam anggaran kelayakan", exceeds: "Mungkin melebihi kelayakan", more_info: "Maklumat tambahan diperlukan", cannot_assess: "Tidak dapat dinilai dengan maklumat yang diberi" };
const NOTE = {
  ms: "Anggaran awal sahaja, bukan kelulusan atau tawaran pembiayaan. Keputusan muktamad dibuat oleh LPPSA atau pihak bank.",
  en: "Preliminary estimate only, not a financing approval or offer. The final decision is made by LPPSA or the bank.",
};

/** WhatsApp-ready text (Bahasa Malaysia by default). */
export function whatsappSummary(r, lang = "ms") {
  const ms = lang !== "en", L = [];
  if (r.calculator === "lppsa") {
    L.push(ms ? "*Anggaran Pembiayaan LPPSA*" : "*LPPSA financing estimate*");
    if (r.eligibility) {
      L.push(`${ms ? "Anggaran kelayakan maksimum" : "Estimated maximum eligibility"}: ${rm0(r.eligibility.max_financing)}`);
      L.push(`${ms ? "Ansuran maksimum layak" : "Maximum eligible instalment"}: ${rm(r.max_instalment)}`);
      L.push(`${ms ? "Tempoh" : "Tenure"}: ${r.tenure_years} ${ms ? "tahun" : "years"}`);
    }
    if (r.approved_estimate) {
      const a = r.approved_estimate;
      L.push("", `${ms ? "Harga rumah" : "Property price"}: ${rm0(r.requested.property_price)}`);
      L.push(`${ms ? "Jumlah pembiayaan" : "Total financing"}: ${rm(a.total)} (${ms ? "rumah" : "property"} ${rm(a.property_part)}${a.mrtt ? ` + MRTT ${rm(a.mrtt)}` : ""}${a.legal_fee ? ` + ${ms ? "yuran guaman" : "legal fee"} ${rm(a.legal_fee)}` : ""}${a.other_costs ? ` + ${ms ? "kos lain" : "other costs"} ${rm(a.other_costs)}` : ""})`);
      L.push(`${ms ? "Kadar keuntungan" : "Profit rate"}: ${a.rate_pct}%`);
      L.push(`${ms ? "Anggaran ansuran bulanan" : "Estimated monthly instalment"}: ${rm(a.instalment)}`);
      if (a.buyer_pays_for_property) L.push(`${ms ? "Bayaran sendiri untuk rumah" : "Paid by the buyer for the property"}: ${rm(a.buyer_pays_for_property)}`);
    }
  } else {
    L.push(ms ? "*Anggaran Pinjaman Bank (senario)*" : "*Bank loan estimate (scenario)*");
    if (r.eligibility) {
      L.push(`${ms ? "Anggaran pinjaman maksimum" : "Indicative maximum financing"}: ${rm0(r.eligibility.max_financing)} (DSR ${r.dsr_pct}%, ${r.rate_pct}%, ${r.tenure_years} ${ms ? "tahun" : "years"})`);
    }
    if (r.requested) {
      const q = r.requested;
      L.push("", `${ms ? "Harga rumah" : "Property price"}: ${rm0(q.property_price)}`);
      L.push(`${ms ? "Pinjaman" : "Financing"} ${q.margin_pct}%: ${rm(q.financing)}`);
      L.push(`${ms ? "Bayaran muka" : "Down payment"}: ${rm(q.down_payment)}`);
      L.push(`${ms ? "Anggaran ansuran bulanan" : "Estimated monthly instalment"}: ${rm(q.instalment)} (${r.rate_pct}%, ${r.tenure_years} ${ms ? "tahun" : "years"})`);
    }
  }
  L.push("", `${ms ? "Status" : "Status"}: ${ms ? STATUS_MS[r.status] : r.status_label}`, "", NOTE[ms ? "ms" : "en"]);
  return L.join("\n");
}

/** Side-by-side LPPSA vs bank (each may be missing). Upfront cash = what the buyer pays for the property itself. */
export function compareScenarios(lppsa, bank) {
  const row = (label, a, b) => ({ label, lppsa: a ?? null, bank: b ?? null });
  const la = lppsa?.approved_estimate, bq = bank?.requested;
  const rows = [
    row("Property price", lppsa?.requested?.property_price, bq?.property_price),
    row("Financing amount", la?.total, bq?.financing),
    row("Of which property", la?.property_part, bq?.property_loan),
    row("Insurance (MRTT / MRTA) financed", la?.mrtt, bq?.mrta_premium),
    row("Fees financed", la ? (la.legal_fee || 0) + (la.other_costs || 0) : null, bq?.other_fees),
    row("Rate (% a year)", la?.rate_pct, bank?.rate_pct),
    row("Tenure (years)", lppsa?.tenure_years, bank?.tenure_years),
    row("Monthly instalment", la?.instalment, bq?.instalment),
    row("Upfront cash for the property", la?.buyer_pays_for_property, bq?.down_payment),
    row("Total profit / interest over the term", la?.total_profit, bq?.total_interest),
    row("Status", lppsa?.status_label, bank?.status_label),
  ];
  const diffs = [
    "LPPSA is for permanent, confirmed public servants; deductions are taken from salary. A bank loan is open to any eligible applicant, repaid from the account.",
    "LPPSA uses three salary tests (60% / 80% / 20%); the bank scenario uses one DSR assumption that you chose, not the bank's own rule.",
    "LPPSA finances up to 100% of the lower of price and valuation, plus MRTT and the legal fee; bank margins are usually 90% or less, lower from the third housing loan.",
    "LPPSA's profit rate is fixed by its rules; a bank's rate is the one you entered and may change with the bank's base rate.",
  ];
  if (la && bq && la.instalment && bq.instalment) diffs.unshift(`Monthly instalment: LPPSA ${rm(la.instalment)} vs bank ${rm(bq.instalment)} (difference ${rm(Math.abs(la.instalment - bq.instalment))}).`);
  if (la && bq) diffs.unshift(`Upfront cash for the property: LPPSA ${rm(la.buyer_pays_for_property)} vs bank ${rm(bq.down_payment)}.`);
  return { rows, differences: diffs, note: "The two schemes have different rules and structures; this is a side-by-side view, not like-for-like equivalence." };
}
