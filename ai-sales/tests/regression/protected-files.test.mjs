// Guards the existing website: every file that existed before the AI Sales module
// must stay byte-identical, and the three Netlify config files may only be appended to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const baseline = JSON.parse(readFileSync(path.join(here, "baseline-hashes.json"), "utf8"));
const sha = (f) => createHash("sha256").update(readFileSync(path.join(root, f))).digest("hex");

for (const [file, hash] of Object.entries(baseline)) {
  if (file.startsWith("_comment")) continue;
  test(`existing file unchanged: ${file}`, () => {
    assert.equal(sha(file), hash, `${file} was modified – the existing website must not change`);
  });
}

// _redirects is first-match-wins, so the original rules must stay first and in order.
for (const [file, snap] of [["_redirects", "baseline-_redirects.txt"], ["_headers", "baseline-_headers.txt"], ["robots.txt", "baseline-robots.txt"]]) {
  test(`${file} keeps every original line, in order, at the top`, () => {
    const before = readFileSync(path.join(here, snap), "utf8").replace(/\n+$/, "").split("\n");
    const now = readFileSync(path.join(root, file), "utf8").split("\n");
    assert.deepEqual(now.slice(0, before.length), before);
  });
}

test("no package.json at the site root (Netlify build must stay a plain static publish)", () => {
  assert.throws(() => readFileSync(path.join(root, "package.json")), /ENOENT/);
});
