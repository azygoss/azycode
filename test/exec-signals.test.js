import test from "node:test";
import assert from "node:assert/strict";
import { mergeAbortSignals } from "../src/exec.js";

test("mergeAbortSignals aborts when any linked signal aborts", async () => {
  const parent = new AbortController();
  const merged = mergeAbortSignals([parent.signal]);
  let aborted = false;
  merged.addEventListener("abort", () => { aborted = true; });
  parent.abort();
  assert.equal(aborted, true);
  assert.equal(merged.aborted, true);
});

test("mergeAbortSignals returns null for empty input", () => {
  assert.equal(mergeAbortSignals([]), null);
  assert.equal(mergeAbortSignals([null, undefined]), null);
});