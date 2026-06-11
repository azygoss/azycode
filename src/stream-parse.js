export function createOpenAiStreamState() {
  return {
    message: { role: "assistant", content: "", tool_calls: [] },
    usage: null,
    finishReason: null,
    malformedChunks: 0
  };
}

export function applyOpenAiStreamChunk(state, chunk) {
  if (!chunk || typeof chunk !== "object") return state;
  state.usage = chunk.usage || state.usage;
  const choice = chunk.choices?.[0];
  if (!choice) return state;
  state.finishReason = choice.finish_reason || state.finishReason;
  const delta = choice.delta || {};
  if (delta.content) state.message.content += delta.content;
  for (const call of delta.tool_calls || []) {
    const index = call.index ?? state.message.tool_calls.length;
    if (!state.message.tool_calls[index]) {
      state.message.tool_calls[index] = {
        id: call.id || "",
        type: "function",
        function: { name: call.function?.name || "", arguments: "" }
      };
    }
    const target = state.message.tool_calls[index];
    if (call.id) target.id = call.id;
    if (call.function?.name) target.function.name = call.function.name;
    if (call.function?.arguments) target.function.arguments += call.function.arguments;
  }
  return state;
}

export function parseOpenAiSsePayload(payload, state = createOpenAiStreamState()) {
  if (!payload || payload === "[DONE]") return { state, done: true };
  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return { state: { ...state, malformedChunks: (state.malformedChunks || 0) + 1 }, done: false };
  }
  return { state: applyOpenAiStreamChunk(state, chunk), done: false };
}

export function finalizeOpenAiStream(state) {
  const message = { ...state.message };
  if (message.tool_calls.length) {
    message.tool_calls = message.tool_calls.filter(Boolean);
  } else {
    delete message.tool_calls;
  }
  return {
    id: "stream",
    object: "chat.completion",
    choices: [{
      index: 0,
      finish_reason: state.finishReason,
      message
    }],
    usage: state.usage,
    malformedChunks: state.malformedChunks || 0
  };
}

export function createAnthropicStreamState() {
  return {
    messageId: "stream",
    text: "",
    toolBlocks: new Map(),
    finishReason: null,
    usage: null,
    malformedChunks: 0
  };
}

export function applyAnthropicStreamEvent(state, parsed) {
  if (!parsed || typeof parsed !== "object") return state;
  if (parsed.type === "message_start") {
    state.messageId = parsed.message?.id || state.messageId;
  } else if (parsed.type === "content_block_start") {
    const block = parsed.content_block;
    if (block?.type === "tool_use") {
      state.toolBlocks.set(parsed.index, {
        id: block.id || "",
        name: block.name || "",
        arguments: ""
      });
    }
  } else if (parsed.type === "content_block_delta") {
    const delta = parsed.delta;
    if (delta?.type === "text_delta" && delta.text) {
      state.text += delta.text;
    } else if (delta?.type === "input_json_delta" && delta.partial_json) {
      const block = state.toolBlocks.get(parsed.index);
      if (block) block.arguments += delta.partial_json;
    }
  } else if (parsed.type === "message_delta") {
    state.finishReason = parsed.delta?.stop_reason || state.finishReason;
    state.usage = parsed.usage || state.usage;
  }
  return state;
}

export function parseAnthropicSseChunk(chunkText, state = createAnthropicStreamState()) {
  let data = "";
  for (const line of String(chunkText || "").split("\n")) {
    if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  if (!data) return { state, done: false };
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { state: { ...state, malformedChunks: (state.malformedChunks || 0) + 1 }, done: false };
  }
  return { state: applyAnthropicStreamEvent(state, parsed), done: false };
}

export function finalizeAnthropicStream(state) {
  const toolCalls = [...state.toolBlocks.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, block]) => ({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: block.arguments || "{}"
      }
    }));
  const message = {
    role: "assistant",
    content: state.text,
    tool_calls: toolCalls.length ? toolCalls : undefined
  };
  if (!message.tool_calls) delete message.tool_calls;
  return {
    id: state.messageId,
    object: "chat.completion",
    choices: [{
      index: 0,
      finish_reason: state.finishReason,
      message
    }],
    usage: state.usage,
    malformedChunks: state.malformedChunks || 0
  };
}