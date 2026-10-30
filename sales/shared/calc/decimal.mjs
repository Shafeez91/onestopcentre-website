// Fixed-point decimal arithmetic for the financing calculators: every value is a BigInt scaled by 10^24, so money
// and rates are exact to 24 decimal places and the only rounding is the one we choose (to the sen, half up).
// Zero dependencies; works in the browser and in Netlify Functions.

const SCALE_DIGITS = 24;
const S = 10n ** BigInt(SCALE_DIGITS);

/** A decimal from a number, numeric string or decimal. Numbers are read through their shortest exact string form. */
export function D(x) {
  if (typeof x === "bigint") return x;
  if (x === null || x === undefined || x === "") throw new RangeError("D: a number is required");
  let s = typeof x === "number" ? (Number.isFinite(x) ? x.toFixed(12) : NaN) : String(x).trim().replace(/,/g, "");
  if (typeof s !== "string" || !/^-?\d+(\.\d+)?$/.test(s)) throw new RangeError(`D: not a number: ${x}`);
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const [int, frac = ""] = s.split(".");
  const v = BigInt(int) * S + BigInt((frac + "0".repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS));
  return neg ? -v : v;
}
export const ZERO = 0n, ONE = S;
export const add = (a, b) => a + b;
export const sub = (a, b) => a - b;
export const mul = (a, b) => (a * b) / S;
export function div(a, b) {
  if (b === 0n) throw new RangeError("div: division by zero");
  return (a * S) / b;
}
/** a^n for a whole n ≥ 0 (square-and-multiply; each step keeps 24 decimals). */
export function pow(a, n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("pow: whole n ≥ 0 required");
  let result = S, base = a, k = n;
  while (k > 0) { if (k & 1) result = mul(result, base); base = mul(base, base); k >>= 1; }
  return result;
}
export const min = (...xs) => xs.reduce((m, x) => (x < m ? x : m));
export const max = (...xs) => xs.reduce((m, x) => (x > m ? x : m));
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Rounds to `places` decimals, half away from zero, and returns a decimal. */
export function roundTo(a, places = 2) {
  const unit = 10n ** BigInt(SCALE_DIGITS - places), half = unit / 2n;
  const q = (a < 0n ? a - half : a + half) / unit;
  return q * unit;
}
/** Rounds down (towards zero) to `places` decimals. */
export function floorTo(a, places = 0) {
  const unit = 10n ** BigInt(SCALE_DIGITS - places);
  return (a / unit) * unit;
}
/** A plain JS number with `places` decimals (for display and JSON), after rounding half up. */
export function toNumber(a, places = 2) {
  const r = roundTo(a, places), unit = 10n ** BigInt(SCALE_DIGITS - places);
  return Number(r / unit) / 10 ** places;
}
/** Sen (integer) from a decimal amount, rounded half up. */
export const toSen = (a) => Number(roundTo(a, 2) / 10n ** BigInt(SCALE_DIGITS - 2));
