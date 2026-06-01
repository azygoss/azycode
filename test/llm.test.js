import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { LlmClient, formatProviderHttpError, fromAnthropicMessage, toAnthropicMessages, toAnthropicTool } from "../src/llm.js";

test("converts OpenAI tool schema to Anthropic tool schema", () => {
  const tool = toAnthropicTool({
    type: "function",
    function: {
      name: "read_file",
      description: "Read file",
      parameters: { type: "object", properties: { file: { type: "string" } } }
    }
  });
  assert.equal(tool.name, "read_file");
  assert.equal(tool.input_schema.properties.file.type, "string");
});

test("converts tool call transcript to Anthropic messages", () => {
  const converted = toAnthropicMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "toolu_1", function: { name: "read_file", arguments: "{\"file\":\"a\"}" } }]
    },
    { role: "tool", tool_call_id: "toolu_1", content: "content" }
  ]);
  assert.equal(converted.system, "sys");
  assert.equal(converted.anthropicMessages[1].content[0].type, "tool_use");
  assert.equal(converted.anthropicMessages[2].content[0].type, "tool_result");
});

test("normalizes Anthropic response to OpenAI completion shape", () => {
  const normalized = fromAnthropicMessage({
    id: "msg_1",
    stop_reason: "tool_use",
    content: [{ type: "text", text: "Use tool" }, { type: "tool_use", id: "t1", name: "search", input: { query: "x" } }]
  });
  const message = normalized.choices[0].message;
  assert.equal(message.content, "Use tool");
  assert.equal(message.tool_calls[0].function.name, "search");
});

test("provider auth errors explain how to recover", () => {
  const message = formatProviderHttpError("kimi", 401, "{\"error\":\"Invalid Authentication\"}");
  assert.match(message, /authentication failed/);
  assert.match(message, /azycode login kimi/);
  assert.match(message, /Invalid Authentication/);
});

test("LlmClient sends OpenAI chat request to configured BYOK endpoint", async () => {
  const seen = {};
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.auth = req.headers.authorization;
        seen.body = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const client = new LlmClient({
      activeProvider: "byok",
      activeModel: "mock",
      providers: { byok: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test", model: "mock" } }
    });
    const response = await client.chat({ messages: [{ role: "user", content: "hello" }] });
    assert.equal(response.choices[0].message.content, "ok");
    assert.equal(seen.auth, "Bearer sk-test");
    assert.equal(seen.body.model, "mock");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
