import test from "node:test";
import assert from "node:assert/strict";
import { debug, info, warn, error, getLevel, setLevel } from "../src/logger.js";

test("logger respects AZYCODE_LOG_LEVEL", () => {
  const original = process.env.AZYCODE_LOG_LEVEL;
  process.env.AZYCODE_LOG_LEVEL = "warn";
  assert.equal(getLevel(), "warn");
  process.env.AZYCODE_LOG_LEVEL = original;
});

test("logger debug is enabled when AZYCODE_DEBUG is set", () => {
  const originalLevel = process.env.AZYCODE_LOG_LEVEL;
  const originalDebug = process.env.AZYCODE_DEBUG;
  delete process.env.AZYCODE_LOG_LEVEL;
  process.env.AZYCODE_DEBUG = "1";
  assert.equal(getLevel(), "debug");
  process.env.AZYCODE_LOG_LEVEL = originalLevel;
  process.env.AZYCODE_DEBUG = originalDebug;
});

test("setLevel updates the active log level", () => {
  const original = process.env.AZYCODE_LOG_LEVEL;
  setLevel("error");
  assert.equal(getLevel(), "error");
  process.env.AZYCODE_LOG_LEVEL = original;
});

test("logger functions do not throw", () => {
  assert.doesNotThrow(() => debug("debug message"));
  assert.doesNotThrow(() => info("info message"));
  assert.doesNotThrow(() => warn("warn message"));
  assert.doesNotThrow(() => error("error message"));
});
