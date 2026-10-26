// Every browser module must parse as an ES module (the dashboard has no build step to catch this).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, copyFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tmp = mkdtempSync(path.join(tmpdir(), "osc-syntax-"));
for (const dir of ["sales/js", "sales/shared", "netlify/functions", "ai-sales/lib"]) {
  for (const f of readdirSync(path.join(root, dir)).filter((x) => /\.m?js$/.test(x))) {
    test(`parses as an ES module: ${dir}/${f}`, () => {
      const copy = path.join(tmp, f.replace(/\.js$/, ".mjs"));
      copyFileSync(path.join(root, dir, f), copy);
      const r = spawnSync(process.execPath, ["--check", copy], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    });
  }
}
