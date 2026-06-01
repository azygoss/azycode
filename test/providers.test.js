import test from "node:test";
import assert from "node:assert/strict";
import { providerDiagnostics, providerModelList, providerPreset, normalizeBaseUrl } from "../src/providers.js";

test("provider presets include requested coding subscriptions", () => {
  assert.equal(providerPreset("kimi").defaultModel, "kimi-k2.6");
  assert.equal(providerPreset("zai-coding").baseUrl, "https://api.z.ai/api/coding/paas/v4");
  assert.equal(providerPreset("minimax").defaultModel, "MiniMax-M2.7");
  assert.equal(providerPreset("opencode-go").baseUrl, "https://opencode.ai/zen/go/v1");
  assert.deepEqual(providerPreset("kimi").models.slice(0, 2), ["kimi-k2.6", "kimi-k2.5"]);
  assert.ok(providerPreset("minimax").models.includes("MiniMax-M3"));
  assert.ok(providerPreset("opencode-go").models.includes("glm-5.1"));
  assert.ok(providerPreset("opencode-go").models.includes("qwen3.7-max"));
  assert.ok(providerPreset("opencode-go").models.includes("qwen3.5-plus"));
  assert.ok(providerPreset("zai-coding").models.includes("glm-5.1"));
  assert.ok(providerPreset("openai").models.includes("gpt-5.2-codex"));
});

test("base url normalization strips trailing slash", () => {
  assert.equal(normalizeBaseUrl("https://example.com/v1/"), "https://example.com/v1");
});

test("providerDiagnostics reports protocol and key source", () => {
  const diag = providerDiagnostics({
    activeProvider: "opencode-go",
    activeModel: "minimax-m2.7",
    providers: { "opencode-go": { apiKey: "sk-test", model: "minimax-m2.7" } }
  });
  assert.equal(diag.protocol, "anthropic-messages");
  assert.equal(diag.chatPath, "/messages");
  assert.equal(diag.apiKeySource, "config");
});

test("providerModelList merges saved and preset models without duplicates", () => {
  const models = providerModelList({
    activeProvider: "kimi",
    activeModel: "custom-kimi",
    providers: { kimi: { model: "kimi-k2.6", models: ["kimi-k2.5", "custom-kimi"] } }
  }, "kimi");
  assert.deepEqual(models.slice(0, 3), ["kimi-k2.5", "custom-kimi", "kimi-k2.6"]);
  assert.equal(models.filter((model) => model === "kimi-k2.6").length, 1);
});
