import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOpenAiChatPayload,
  buildResponsesPayload,
  resolveProviderCapabilities
} from "../src/provider-capabilities.js";
import { providerPreset } from "../src/providers.js";

test("resolveProviderCapabilities infers anthropic and vision support", () => {
  const provider = {
    ...providerPreset("opencode-go"),
    model: "minimax-m2.7"
  };
  const caps = resolveProviderCapabilities(provider, "minimax-m2.7");
  assert.equal(caps.supportsAnthropicMessages, true);
  assert.equal(caps.protocol, "anthropic-messages");
  assert.equal(caps.apiMode, "chat");
});

test("resolveProviderCapabilities enables responses api mode when configured", () => {
  const provider = {
    ...providerPreset("byok"),
    apiMode: "responses",
    model: "gpt-5.2"
  };
  const caps = resolveProviderCapabilities(provider, "gpt-5.2");
  assert.equal(caps.supportsResponsesAPI, true);
  assert.equal(caps.apiMode, "responses");
});

test("buildOpenAiChatPayload omits tools when unsupported", () => {
  const body = buildOpenAiChatPayload({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ schema: { type: "function", function: { name: "read_file", parameters: {} } } }],
    model: "mock",
    reasoning: "high",
    capabilities: { supportsTools: false, supportsReasoningEffort: false, toolChoice: "auto" }
  });
  assert.equal(body.tools, undefined);
  assert.equal(body.reasoning_effort, undefined);
});

test("buildResponsesPayload preserves instructions and tool choice", () => {
  const body = buildResponsesPayload({
    messages: [
      { role: "system", content: "be careful" },
      { role: "user", content: "fix src/app.js" }
    ],
    tools: [{ schema: { type: "function", function: { name: "read_file", parameters: {} } } }],
    model: "gpt-5.2",
    reasoning: "medium",
    capabilities: {
      supportsTools: true,
      supportsReasoningEffort: true,
      toolChoice: "auto",
      maxOutputTokens: 4096
    }
  });
  assert.equal(body.instructions, "be careful");
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.max_output_tokens, 4096);
  assert.ok(Array.isArray(body.input));
});