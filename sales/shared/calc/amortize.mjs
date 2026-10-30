// Repayment mathematics (no eligibility rules): monthly reducing balance, in exact decimals (decimal.mjs).
//   instalment A = P × r × (1+r)^n / ((1+r)^n − 1),  r = annual rate % / 12 / 100,  n = months
//   zero rate:  A = P / n
import { D, add, sub, mul, div, pow, ZERO, ONE } from "./decimal.mjs";

const monthlyRate = (ratePct) => div(D(ratePct), D(1200));

function check(n, ratePct) {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError("months must be a whole number above 0");
  if (D(ratePct) < ZERO) throw new RangeError("the rate cannot be negative");
}

/** Monthly instalment for principal P (decimal) at an annual rate % over n months. */
export function instalment(P, ratePct, n) {
  check(n, ratePct);
  if (P <= ZERO) return ZERO;
  const r = monthlyRate(ratePct);
  if (r === ZERO) return div(P, D(n));
  const f = pow(add(ONE, r), n);
  return div(mul(mul(P, r), f), sub(f, ONE));
}

/** The principal a monthly payment A (decimal) repays at an annual rate % over n months (inverse of instalment). */
export function principalFor(A, ratePct, n) {
  check(n, ratePct);
  if (A <= ZERO) return ZERO;
  const r = monthlyRate(ratePct);
  if (r === ZERO) return mul(A, D(n));
  const f = pow(add(ONE, r), n);
  return div(mul(A, sub(f, ONE)), mul(r, f));
}

/** Total paid and total interest / profit over the term. */
export function totals(P, A, n) {
  const paid = mul(A, D(n));
  return { paid, interest: sub(paid, P) };
}
