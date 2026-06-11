import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOpenAiStreamChunk,
  createAnthropicStreamState,
  createOpenAiStreamState,
  finalizeAnthropicStream,
  finalizeOpenAiStream,
  parseAnthropicSseChunk,
  parseOpenAiSsePayload
} from "../src/stream-parse.js";

test("parseOpenAiSsePayload assembles fragmented tool call arguments", () => {
  let state = createOpenAiStreamState();
  const first = JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "{\"file\":" } }]
      }
    }]
  });
  const second = JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, function: { arguments: "\"src/a.js\"}" } }]
      },
      finish_reason: "tool_calls"
    }],
    usage: { total_tokens: 12 }
  });

  state = parseOpenAiSsePayload(first, state).state;
  state = parseOpenAiSsePayload(second, state).state;
  const completion = finalizeOpenAiStream(state);
  const call = completion.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "read_file");
  assert.equal(call.function.arguments, "{\"file\":\"src/a.js\"}");
  assert.equal(completion.usage.total_tokens, 12);
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
});

test("parseOpenAiSsePayload tolerates malformed chunks", () => {
  let state = createOpenAiStreamState();
  state = parseOpenAiSsePayload("{not-json", state).state;
  state = applyOpenAiStreamChunk(state, {
    choices: [{ delta: { content: "ok" }, finish_reason: "stop" }]
  });
  const completion = finalizeOpenAiStream(state);
  assert.equal(completion.choices[0].message.content, "ok");
  assert.equal(completion.malformedChunks, 1);
});

test("parseAnthropicSseChunk handles parallel tool blocks and empty text", () => {
  let state = parseAnthropicSseChunk("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\"}}\n\n", createAnthropicStreamState()).state;
  state = parseAnthropicSseChunk("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"search\"}}\n\n", state).state;
  state = parseAnthropicSseChunk("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"read_file\"}}\n\n", state).state;
  state = parseAnthropicSseChunk("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\"}}\n\n", state).state;
  state = parseAnthropicSseChunk("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"x\\\"}\"}}\n\n", state).state;
  state = parseAnthropicSseChunk("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":4}}\n\n", state).state;
  const completion = finalizeAnthropicStream(state);
  assert.equal(completion.choices[0].message.content, "");
  assert.equal(completion.choices[0].message.tool_calls.length, 2);
  assert.equal(completion.choices[0].message.tool_calls[0].function.arguments, "{\"query\":\"x\"}");
});