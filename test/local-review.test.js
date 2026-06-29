import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { formatLocalReview, localReview } from "../src/local-review.js";

test("localReview parses leading-space porcelain status without truncating paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-path-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature/test"], { cwd: dir, stdio: "ignore" });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.js"), "export const x = 1;\n");
  execFileSync("git", ["add", "src/app.js"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "src", "app.js"), "export const x = 2;\n");
  const review = localReview(dir);
  assert.ok(review.files.includes("src/app.js"));
  assert.ok(!review.files.some((file) => file.startsWith("rc/")));
});

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

test("localReview detects path traversal patterns in diff", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "bad.js"), "const p = path.join(base, req.query.file)\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const review = localReview(dir);
  assert(review.findings.some((f) => f.id === "path-traversal" || f.title.includes("path traversal")));
});

test("localReview detects insecure random for tokens", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "token.js"), "const token = Math.random().toString() + 'session'\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const review = localReview(dir);
  assert(review.findings.some((f) => f.title.includes("random") || f.title.includes("token")));
});

test("localReview flags CI workflow changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "name: ci\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const review = localReview(dir);
  assert(review.findings.some((f) => f.title.includes("CI workflow")));
});

test("localReview detects TODO and FIXME markers in diff", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "todo.js"), "// TODO: fix this\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const review = localReview(dir);
  assert(review.findings.some((f) => f.title.includes("Code markers")));
});

test("localReview detects AWS access key id and GitHub token patterns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-secret-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(
    path.join(dir, "keys.js"),
    "const AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';\nconst GITHUB_TOKEN = 'ghp_0123456789abcdef0123456789abcdef';\n"
  );
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const review = localReview(dir);
  assert(review.findings.some((f) => f.id === "secret" || f.title.includes("secret")), "AWS/GitHub token must be flagged");
});

test("localReview detects password/secret/token assignment patterns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-assign-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "cfg.js"), "const password = 'supersecretvalue';\nconst dbToken = 'tok_abcdef123456';\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const review = localReview(dir);
  assert(review.findings.some((f) => f.id === "secret" || f.title.includes("secret")), "password/token assignment must be flagged");
});

test("localReview detects SSRF via axios/http/node-fetch libraries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-ssrf-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(
    path.join(dir, "fetch.js"),
    "import axios from 'axios';\nawait axios.get(req.query.url);\nhttp.request(params.target);\n"
  );
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const review = localReview(dir);
  assert(review.findings.some((f) => f.id === "ssrf" || f.title.includes("SSRF")), "axios/http SSRF must be flagged");
});

test("localReview detects fs read of user-controlled input (path traversal)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-fs-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "read.js"), "const data = fs.readFileSync(req.body.filename);\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const review = localReview(dir);
  assert(review.findings.some((f) => f.id === "path-traversal" || f.title.includes("path traversal")), "fs read of user input must be flagged");
});

test("localReview detects permission config change by content, not filename", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-review-cfg-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.mkdirSync(path.join(dir, ".azycode"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".azycode", "config.json"), JSON.stringify({ permissionProfile: "full-auto", gitGuard: { enabled: false } }));
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  const review = localReview(dir);
  assert(review.findings.some((f) => f.id === "permission-change" || f.title.includes("Permission or guard")), "permission config change must be flagged by content");
});
