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

test("localReview detects eval and new Function in diff", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "bad.js"), "eval(userInput)\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const review = localReview(dir);
  assert(review.findings.some((f) => f.title.includes("code injection")));
});

test("localReview detects innerHTML assignment in diff", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "xss.js"), "el.innerHTML = html\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const review = localReview(dir);
  assert(review.findings.some((f) => f.title.includes("innerHTML")));
});

test("localReview detects child_process.exec in diff", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "exec.js"), "const cp = require('child_process'); cp.exec(cmd)\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const review = localReview(dir);
  assert(review.findings.some((f) => f.title.includes("Unsafe shell")));
});

test("localReview detects TODO and FIXME markers in diff", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "todo.js"), "// TODO: fix this\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const review = localReview(dir);
  assert(review.findings.some((f) => f.title.includes("Code markers")));
});
