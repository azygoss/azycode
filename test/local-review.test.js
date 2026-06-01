import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { formatLocalReview, localReview } from "../src/local-review.js";

test("localReview flags runtime changes without tests", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "index.js"), "console.log('x')\n");
  const review = localReview(dir);
  assert(review.files.includes("src/index.js"));
  assert(review.findings.some((finding) => finding.title.includes("Runtime code changed")));
  assert.match(formatLocalReview(review), /Local Review/);
});
