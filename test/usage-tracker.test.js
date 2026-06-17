import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordUsage,
  getUsageStats,
  resetUsage,
  computeCost,
  formatUsageReport,
  flushUsage,
  pricingInfo,
  resetUsageCache
} from "../src/usage-tracker.js";

function isolateHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-usage-"));
  process.env.AZYCODE_HOME = home;
  resetUsageCache();
  return home;
}

test("recordUsage stores token data and computes cost", () => {
  isolateHome();
  recordUsage("openai", "gpt-4o", { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });
  const stats = getUsageStats();
  assert.equal(stats.entries, 1);
  assert.equal(stats.promptTokens, 1000);
  assert.equal(stats.completionTokens, 500);
  assert.equal(stats.totalTokens, 1500);
  assert.ok(stats.cost > 0, "cost should be positive for gpt-4o");
  // gpt-4o: $2.5/1M input + $10/1M output = $0.0025 + $0.005 = $0.0075
  assert.ok(Math.abs(stats.cost - 0.0075) < 0.0001, `expected ~0.0075, got ${stats.cost}`);
});

test("recordUsage with zero tokens is ignored", () => {
  isolateHome();
  recordUsage("openai", "gpt-4o", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  const stats = getUsageStats();
  assert.equal(stats.entries, 0);
});

test("recordUsage without usage object is ignored", () => {
  isolateHome();
  recordUsage("openai", "gpt-4o", null);
  recordUsage("openai", "gpt-4o", undefined);
  assert.equal(getUsageStats().entries, 0);
});

test("getUsageStats filters by provider", () => {
  isolateHome();
  recordUsage("openai", "gpt-4o", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  recordUsage("kimi", "moonshot-v1-8k", { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 });
  const openaiStats = getUsageStats({ provider: "openai" });
  assert.equal(openaiStats.entries, 1);
  assert.equal(openaiStats.promptTokens, 100);
  const kimiStats = getUsageStats({ provider: "kimi" });
  assert.equal(kimiStats.entries, 1);
  assert.equal(kimiStats.promptTokens, 200);
});

test("getUsageStats filters by model", () => {
  isolateHome();
  recordUsage("openai", "gpt-4o", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  recordUsage("openai", "gpt-4o-mini", { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 });
  const stats = getUsageStats({ model: "gpt-4o" });
  assert.equal(stats.entries, 1);
  assert.equal(stats.promptTokens, 100);
});

test("getUsageStats filters by since date", () => {
  isolateHome();
  recordUsage("openai", "gpt-4o", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  const future = new Date(Date.now() + 60000).toISOString();
  const stats = getUsageStats({ since: future });
  assert.equal(stats.entries, 0);
  const past = new Date(Date.now() - 60000).toISOString();
  const stats2 = getUsageStats({ since: past });
  assert.equal(stats2.entries, 1);
});

test("resetUsage clears all entries", () => {
  isolateHome();
  recordUsage("openai", "gpt-4o", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  assert.equal(getUsageStats().entries, 1);
  const remaining = resetUsage();
  assert.equal(remaining, 0);
  assert.equal(getUsageStats().entries, 0);
});

test("resetUsage with before date preserves entries before it", () => {
  isolateHome();
  recordUsage("openai", "gpt-4o", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  // 'before' keeps entries older than the given date.
  // With a future date, all current entries are kept.
  const future = new Date(Date.now() + 60000).toISOString();
  const remaining = resetUsage({ before: future });
  assert.equal(remaining, 1);
});

test("computeCost uses correct pricing", () => {
  // gpt-4o: $2.5/1M input, $10/1M output
  const cost = computeCost("openai", "gpt-4o", 1_000_000, 1_000_000);
  assert.ok(Math.abs(cost - 12.5) < 0.01, `expected 12.5, got ${cost}`);
});

test("computeCost falls back to zero for byok", () => {
  const cost = computeCost("byok", "custom-model", 1_000_000, 1_000_000);
  assert.equal(cost, 0);
});

test("computeCost uses default pricing for unknown model", () => {
  const cost = computeCost("kimi", "unknown-model", 1_000_000, 0);
  // kimi default: $2/1M input
  assert.ok(Math.abs(cost - 2) < 0.01, `expected 2, got ${cost}`);
});

test("byProvider and byModel breakdown", () => {
  isolateHome();
  recordUsage("openai", "gpt-4o", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  recordUsage("openai", "gpt-4o", { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 });
  recordUsage("kimi", "moonshot-v1-8k", { prompt_tokens: 300, completion_tokens: 150, total_tokens: 450 });
  const stats = getUsageStats();
  assert.ok(stats.byProvider.openai);
  assert.ok(stats.byProvider.kimi);
  assert.equal(stats.byProvider.openai.calls, 2);
  assert.equal(stats.byProvider.kimi.calls, 1);
  assert.ok(stats.byModel["gpt-4o"]);
  assert.equal(stats.byModel["gpt-4o"].calls, 2);
});

test("formatUsageReport produces readable output", () => {
  isolateHome();
  recordUsage("openai", "gpt-4o", { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });
  const stats = getUsageStats();
  const report = formatUsageReport(stats);
  assert.match(report, /Usage Summary/);
  assert.match(report, /total tokens: 1,500/);
  assert.match(report, /estimated cost/);
});

test("pricingInfo returns provider pricing table", () => {
  const pricing = pricingInfo();
  assert.ok(pricing.openai);
  assert.ok(pricing.openai["gpt-4o"]);
  assert.ok(pricing.kimi);
});

test("multiple entries aggregate correctly", () => {
  isolateHome();
  for (let i = 0; i < 5; i++) {
    recordUsage("openai", "gpt-4o", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  }
  const stats = getUsageStats();
  assert.equal(stats.entries, 5);
  assert.equal(stats.promptTokens, 500);
  assert.equal(stats.completionTokens, 250);
  assert.equal(stats.totalTokens, 750);
});

test("recordUsage stores sessionId", () => {
  isolateHome();
  recordUsage("openai", "gpt-4o", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, "ses_test123");
  const stats = getUsageStats();
  assert.equal(stats.entries, 1);
});

test("byok provider with default pricing is zero cost", () => {
  isolateHome();
  recordUsage("byok", "llama-3-70b", { prompt_tokens: 10000, completion_tokens: 5000, total_tokens: 15000 });
  const stats = getUsageStats();
  assert.equal(stats.cost, 0);
});
