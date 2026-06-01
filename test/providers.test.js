import test from "node:test";
import assert from "node:assert/strict";
import { providerDiagnostics, providerPreset, normalizeBaseUrl } from "../src/providers.js";

test("provider presets include requested coding subscriptions", () => {
  assert.equal(providerPreset("kimi").defaultModel, "kimi-k2.6");
  assert.equal(providerPreset("zai-coding").baseUrl, "https://api.z.ai/api/coding/paas/v4");
  assert.equal(providerPreset("minimax").defaultModel, "MiniMax-M2.7");
  assert.equal(providerPreset("opencode-go").baseUrl, "https://opencode.ai/zen/go/v1");
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
