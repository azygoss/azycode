import test from "node:test";
import assert from "node:assert/strict";
import { listBenchmarks, runAllBenchmarks, runBenchmark } from "../src/bench.js";

test("listBenchmarks discovers fixtures", () => {
  const items = listBenchmarks();
  assert.ok(items.length >= 4);
  assert.ok(items.some((item) => item.id === "shell-safety"));
});

test("runBenchmark shell-safety passes with mock", async () => {
  const result = await runBenchmark("shell-safety", { mock: true });
  assert.equal(result.ok, true);
  assert.ok(result.checks?.length >= 4);
});

test("runBenchmark path-guard passes", async () => {
  const result = await runBenchmark("path-guard", { mock: true });
  assert.equal(result.ok, true);
});

test("runBenchmark prompt-injection passes", async () => {
  const result = await runBenchmark("prompt-injection", { mock: true });
  assert.equal(result.ok, true);
});

test("runBenchmark context-retrieval passes with v3 sections", async () => {
  const result = await runBenchmark("context-retrieval", { mock: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("runAllBenchmarks produces summary", async () => {
  const report = await runAllBenchmarks({ mock: true });
  assert.ok(report.total >= 4);
  assert.ok(report.passed >= 4);
  assert.equal(report.failed, 0);
});