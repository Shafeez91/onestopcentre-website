// Text helpers shared by the dashboard (document extraction / CSV import) and tests.

/** Tiny CSV parser (quoted fields, commas, newlines). Returns objects keyed by snake_cased header. */
export function parseCSV(text) {
  const rows = []; let row = [], cell = "", i = 0, inQ = false;
  text = String(text).replace(/^﻿/, "");
  while (i < text.length) {
    const ch = text[i];
    if (inQ) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; } if (ch === '"') { inQ = false; i++; continue; } cell += ch; i++; continue; }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
    cell += ch; i++;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!clean.length) return [];
  const head = clean[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  return clean.slice(1).map((r) => Object.fromEntries(head.map((h, j) => [h, (r[j] ?? "").trim()])));
}
/** Splits text into ~1,200-character chunks on paragraph boundaries; tables keep their header row on every chunk. */
export function chunkText(sections, max = 1200) {
  const out = [];
  for (const s of sections) {
    const text = String(s.text || "").replace(/\r/g, "").trim();
    if (!text) continue;
    if (s.table) {
      const lines = text.split("\n").filter((l) => l.replace(/,/g, "").trim());
      const head = lines.shift() || "";
      let cur = [];
      for (const l of lines) { if ((head + "\n" + cur.join("\n") + "\n" + l).length > max && cur.length) { out.push({ title: s.title, content: head + "\n" + cur.join("\n") }); cur = []; } cur.push(l); }
      if (cur.length || !out.length) out.push({ title: s.title, content: head + (cur.length ? "\n" + cur.join("\n") : "") });
      continue;
    }
    let cur = "";
    for (const para of text.split(/\n\s*\n|(?<=[.!?])\s{2,}/)) {
      const pTxt = para.replace(/\s+/g, " ").trim();
      if (!pTxt) continue;
      if ((cur + "\n\n" + pTxt).length > max && cur) { out.push({ title: s.title, content: cur }); cur = ""; }
      if (pTxt.length > max) { for (let i = 0; i < pTxt.length; i += max) out.push({ title: s.title, content: pTxt.slice(i, i + max) }); continue; }
      cur = cur ? cur + "\n\n" + pTxt : pTxt;
    }
    if (cur) out.push({ title: s.title, content: cur });
  }
  return out;
}
