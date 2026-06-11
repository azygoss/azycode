import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildSecurityReview,
  formatSecurityReview,
  formatSecurityReviewJson,
  recommendSecurityTests,
  securityReviewPrompt
} from "../src/security-review.js";

function initRepo(dir, files = {}) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

test("recommendSecurityTests suggests npm test for source changes", () => {
  const checks = recommendSecurityTests(["src/agent.js", "README.md"]);
  assert.ok(checks.includes("npm test"));
});

test("buildSecurityReview includes test recommendations and local findings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-sec-review-"));
  initRepo(dir, { "README.md": "base\n" });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "console.log('x')\n", "utf8");
  const review = buildSecurityReview(dir);
  assert.ok(review.testRecommendations.length > 0);
  assert.ok(review.findings.some((finding) => finding.title.includes("Runtime code changed")));
  assert.match(formatSecurityReview(review), /recommendedTests:/);
});

test("securityReviewPrompt includes findings and verification commands", () => {
  const review = buildSecurityReview(process.cwd());
  const prompt = securityReviewPrompt(review);
  assert.match(prompt, /security-focused review/i);
  assert.match(prompt, /Recommended verification commands/);
});

test("formatSecurityReviewJson exposes structured metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-sec-json-"));
  initRepo(dir, { "README.md": "base\n" });
  fs.writeFileSync(path.join(dir, "risk.js"), "eval(input)\n", "utf8");
  execFileSync("git", ["add", "risk.js"], { cwd: dir, stdio: "ignore" });
  const review = buildSecurityReview(dir);
  const json = formatSecurityReviewJson(review);
  assert.ok(Array.isArray(json.testRecommendations));
  assert.ok(json.findings.some((finding) => finding.title.includes("code injection")));
});