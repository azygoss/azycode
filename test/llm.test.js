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

test("toAnthropicMessages tolerates invalid tool-call JSON", () => {
  const converted = toAnthropicMessages([
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "toolu_bad", function: { name: "write_file", arguments: "{" } }]
    }
  ]);
  const toolUse = converted.anthropicMessages[0].content[0];
  assert.equal(toolUse.type, "tool_use");
  assert.equal(toolUse.name, "write_file");
  assert.equal(toolUse.input._invalidArguments, "{");
});

test("toAnthropicMessages coalesces adjacent tool results", () => {
  const converted = toAnthropicMessages([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "a", function: { name: "read_file", arguments: "{\"file\":\"a.js\"}" } },
        { id: "b", function: { name: "read_file", arguments: "{\"file\":\"b.js\"}" } }
      ]
    },
    { role: "tool", tool_call_id: "a", content: "alpha" },
    { role: "tool", tool_call_id: "b", content: "beta" }
  ]);
  const toolResults = converted.anthropicMessages.filter((message) => message.role === "user");
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].content.length, 2);
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

test("LlmClient streams Anthropic messages when stream is enabled", async () => {
  const deltas = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/messages") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\n");
      res.write("data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_stream\"}}\n\n");
      res.write("event: content_block_delta\n");
      res.write("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\n");
      res.write("event: content_block_delta\n");
      res.write("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n");
      res.write("event: message_delta\n");
      res.write("data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n");
      res.write("event: message_stop\n");
      res.write("data: {\"type\":\"message_stop\"}\n\n");
      res.end();
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
      activeModel: "minimax-m3",
      providers: {
        byok: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "sk-test",
          model: "minimax-m3",
          protocol: "anthropic-messages",
          anthropicModels: ["minimax-m3"]
        }
      }
    });
    const response = await client.chat({
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      onDelta: (delta) => deltas.push(delta.content)
    });
    assert.equal(response.choices[0].message.content, "Hello");
    assert.deepEqual(deltas, ["Hel", "lo"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
