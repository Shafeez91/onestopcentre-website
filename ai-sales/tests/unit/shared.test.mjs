import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, formatPhone } from "../../../sales/shared/phone.mjs";
import { scoreLead, DEFAULT_SCORING } from "../../../sales/shared/scoring.mjs";

test("phone normalisation matches the database function cases", () => {
  const cases = {
    "012-345 6789": "60123456789", "+60 12-345 6789": "60123456789", "0060123456789": "60123456789",
    "123456789": "60123456789", "011-2345 6789": "601123456789", "03-2345 6789": "60323456789",
    "+65 9123 4567": "6591234567", "abc": null, "123": null, "": null, null: null,
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(normalizePhone(input === "null" ? null : input), want, input);
  assert.equal(formatPhone("60123456789"), "+60 12-345 6789");
  assert.equal(formatPhone("601123456789"), "+60 11-2345 6789");
});

test("new lead with nothing known scores 0 and is nurture, with every factor marked unknown", () => {
  const r = scoreLead({}, {});
  assert.equal(r.score, 0);
  assert.equal(r.temperature, "nurture");
  assert.ok(r.rationale.every((x) => x.known === false));
});

test("ready buyer within budget asking for appointment is hot", () => {
  const r = scoreLead({ readiness: "ready", budget_max: 500000, project_price_from: 450000, project_fit: "strong", timeline_months: 2, financing: "lppsa" }, { appointment_requested: true });
  assert.ok(r.score >= DEFAULT_SCORING.thresholds.hot, "score " + r.score);
  assert.equal(r.temperature, "hot");
  assert.match(r.rationale.find((x) => x.factor === "budget").detail, /within budget/);
});

test("warm and nurture boundaries follow configurable thresholds", () => {
  const q = { readiness: "considering", project_fit: "partial", timeline_months: 6 };
  const base = scoreLead(q, { replies: 2 });
  assert.equal(base.temperature, base.score >= 45 ? "warm" : "nurture");
  const strict = scoreLead(q, { replies: 2 }, { thresholds: { hot: 99, warm: 98, nurture: 0 } });
  assert.equal(strict.temperature, "nurture");
  assert.equal(strict.score, base.score, "thresholds do not change the score");
});

test("budget mismatch lowers the budget factor; unsuitable overrides temperature", () => {
  const over = scoreLead({ budget_max: 300000, project_price_from: 450000 });
  assert.equal(over.rationale.find((x) => x.factor === "budget").points, 0);
  const near = scoreLead({ budget_max: 420000, project_price_from: 450000 });
  assert.ok(near.rationale.find((x) => x.factor === "budget").points > 0);
  const u = scoreLead({ readiness: "ready", project_fit: "strong", unsuitable: true, unsuitable_reason: "looking for rental only" });
  assert.equal(u.temperature, "unqualified");
});

test("weights are configurable and points always sum to the score", () => {
  const r = scoreLead({ readiness: "ready", financing: "cash" }, {}, { weights: { readiness: 50, budget: 0, suitability: 0, timeline: 0, engagement: 0, financing: 50 } });
  assert.equal(r.score, 100);
  const sum = r.rationale.reduce((a, x) => a + x.points, 0);
  assert.ok(Math.abs(sum - r.score) <= 1);
});

import { parseCSV, chunkText } from "../../../sales/shared/text.mjs";

test("CSV import: quoted fields, commas, CRLF and header normalisation", () => {
  const rows = parseCSV('﻿Unit No,Unit Type,List Price,Status\r\nA-10-1,"Type A, corner","RM 450,000",Available\r\n\r\nA-10-2,Type B,,sold\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { unit_no: "A-10-1", unit_type: "Type A, corner", list_price: "RM 450,000", status: "Available" });
  assert.equal(rows[1].list_price, "");
  assert.deepEqual(parseCSV(""), []);
});

test("document chunking: paragraphs stay together, long text is split, tables keep their header", () => {
  const para = (n) => ("Ayat " + n + " tentang projek. ").repeat(20).trim();
  const chunks = chunkText([{ title: "Page 1", text: [para(1), para(2), para(3), para(4)].join("\n\n") }], 1200);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.content.length <= 1200));
  assert.ok(chunks.every((c) => c.title === "Page 1"));
  const table = "type,price\n" + Array.from({ length: 200 }, (_, i) => `Type ${i},RM${400000 + i}`).join("\n");
  const t = chunkText([{ title: "Sheet Prices", text: table, table: true }], 500);
  assert.ok(t.length > 1);
  assert.ok(t.every((c) => c.content.startsWith("type,price\n")), "header repeated on every chunk");
  assert.equal(t.map((c) => c.content.split("\n").length - 1).reduce((a, b) => a + b, 0), 200, "no rows lost");
  assert.deepEqual(chunkText([{ title: "x", text: "   " }]), []);
});
