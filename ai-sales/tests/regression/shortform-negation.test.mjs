// 30 Oct 2026: the persona writes WhatsApp short forms. "Pulangan … x dpt dijamin" (returns cannot be guaranteed) was
// read as a promise and the whole reply was replaced by the safe fallback. Negations in short form must count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReply } from "../../../sales/shared/validator.mjs";

const codes = (t) => (validateReply(t, { allowedAmounts: new Set(), allowedUrls: new Set() }).violations || []).map((v) => v.code);

test("a disclaimer written with short forms is not a guarantee", () => {
  for (const t of ["Pulangan pelaburan dan kenaikan harga juga x dpt dijamin.", "Harga tk blh dijamin naik.", "Kelulusan loan tdk dijamin.",
    "Ni bkn jaminan untung.", "Returns cannot be guaranteed.", "Kenaikan harga tak dapat dijamin."]) {
    assert.ok(!codes(t).includes("guarantee_language"), t);
  }
});

test("real promises are still blocked, and a word ending in 'x' or 'no' is not a negation", () => {
  for (const t of ["Loan dijamin lulus!", "Kami jamin untung.", "Confirm lulus punya.", "Box dijamin lulus.", "Piano dijamin naik harga."]) {
    assert.ok(codes(t).includes("guarantee_language"), t);
  }
});
