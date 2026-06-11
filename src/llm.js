import { chatPathFor, providerConfig, resolveProtocol } from "./providers.js";
import { debug, warn } from "./logger.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE_MS = 1_000;

function requestTimeoutMs() {
  const env = process.env.AZYCODE_REQUEST_TIMEOUT_MS;
  if (env) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

function isRetryableError(error) {
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  if (error.message?.includes("fetch failed") || error.message?.includes("network")) return true;
  if (error.code && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(error.code)) return true;
  if (error.message?.includes("ECONNREFUSED") || error.message?.includes("ECONNRESET") || error.message?.includes("ETIMEDOUT") || error.message?.includes("ENOTFOUND")) return true;
  return false;
}

function isRetryableStatus(status) {
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeSignals(signals = []) {
  const active = signals.filter(Boolean);
  if (!active.length) return null;
  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const signal of active) {
    if (signal.aborted) {
      abort(signal.reason || new Error("Aborted"));
      break;
    }
    signal.addEventListener("abort", () => abort(signal.reason || new Error("Aborted")), { once: true });
  }
  return controller.signal;
}

async function fetchWithTimeout(url, init, timeoutMs, externalSignal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("TimeoutError")), timeoutMs);
  const signal = mergeSignals([controller.signal, externalSignal]);
  try {
    const response = await fetch(url, { ...init, signal: signal || controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function jitterDelay(baseMs, attempt) {
  const exponential = baseMs * (2 ** attempt);
  return exponential + Math.random() * baseMs;
}

async function fetchWithRetry(url, init, { timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = MAX_RETRIES, signal = null } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new Error("Aborted");
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs, signal);
      if (!response.ok && isRetryableStatus(response.status) && attempt < maxRetries) {
        const delay = Math.round(jitterDelay(RETRY_DELAY_BASE_MS, attempt));
        warn(`LLM request HTTP ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
        await sleep(delay);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw signal.reason || error;
      if (isRetryableError(error) && attempt < maxRetries) {
        const delay = Math.round(jitterDelay(RETRY_DELAY_BASE_MS, attempt));
        warn(`LLM request error (${error.name || error.message}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error(`Request failed after ${maxRetries + 1} attempts`);
}

export class LlmClient {
  constructor(cfg, providerName = cfg.activeProvider) {
    this.provider = providerConfig(cfg, providerName);
    if (!this.provider.apiKey) {
      throw new Error(`Missing API key for ${this.provider.name}. Run 'azycode login ${this.provider.name}'.`);
    }
  }

  async listModels() {
    const response = await this.request(this.provider.modelsPath || "/models", { method: "GET" });
    const data = await response.json();
    return Array.isArray(data.data) ? data.data : data.models || data;
  }

  async chat({ messages, tools = [], model, reasoning, stream = false, signal = null, onDelta = null }) {
    const selectedModel = model || this.provider.model;
    const protocol = resolveProtocol(this.provider, selectedModel);
    if (protocol === "anthropic-messages") {
      return this.anthropicMessages({ messages, tools, model: selectedModel, reasoning, stream, signal, onDelta });
    }
    return this.openaiChat({ messages, tools, model: selectedModel, reasoning, stream, signal, onDelta });
  }

  async openaiChat({ messages, tools = [], model, reasoning, stream = false, signal = null, onDelta = null }) {
    const body = {
      model,
      messages,
      stream: Boolean(stream),
      tools: tools.length ? tools.map((tool) => tool.schema) : undefined,
      tool_choice: tools.length ? "auto" : undefined
    };
    applyReasoning(body, reasoning);
    if (stream) {
      return this.openaiChatStream(chatPathFor(this.provider, model), body, signal, onDelta);
    }
    const response = await this.request(chatPathFor(this.provider, model), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }, signal);
    return response.json();
  }

  async openaiChatStream(path, body, signal = null, onDelta = null) {
    const response = await this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ ...body, stream: true })
    }, signal);
    if (!response.body) throw new Error("Streaming response missing body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const message = {
      role: "assistant",
      content: "",
      tool_calls: []
    };
    let usage = null;
    let finishReason = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineBreak;
      while ((lineBreak = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, lineBreak).trim();
        buffer = buffer.slice(lineBreak + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        usage = chunk.usage || usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        finishReason = choice.finish_reason || finishReason;
        const delta = choice.delta || {};
        if (delta.content) {
          message.content += delta.content;
          onDelta?.({ content: delta.content });
        }
        for (const call of delta.tool_calls || []) {
          const index = call.index ?? message.tool_calls.length;
          if (!message.tool_calls[index]) {
            message.tool_calls[index] = {
              id: call.id || "",
              type: "function",
              function: { name: call.function?.name || "", arguments: "" }
            };
          }
          const target = message.tool_calls[index];
          if (call.id) target.id = call.id;
          if (call.function?.name) target.function.name = call.function.name;
          if (call.function?.arguments) target.function.arguments += call.function.arguments;
        }
      }
    }

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
        finish_reason: finishReason,
        message
      }],
      usage
    };
  }

  async anthropicMessages({ messages, tools = [], model, reasoning, stream = false, signal = null, onDelta = null }) {
    const { system, anthropicMessages } = toAnthropicMessages(messages);
    const body = {
      model,
      max_tokens: 4096,
      stream,
      system: system || undefined,
      messages: anthropicMessages,
      tools: tools.length ? tools.map((tool) => toAnthropicTool(tool.schema)) : undefined
    };
    applyReasoning(body, reasoning);
    const path = chatPathFor(this.provider, model);
    if (stream) {
      return this.anthropicMessagesStream(path, body, signal, onDelta);
    }
    const response = await this.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    }, signal);
    const raw = await response.json();
    return fromAnthropicMessage(raw);
  }

  async anthropicMessagesStream(path, body, signal = null, onDelta = null) {
    const response = await this.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ ...body, stream: true })
    }, signal);
    if (!response.body) throw new Error("Streaming response missing body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let messageId = "stream";
    let text = "";
    const toolBlocks = new Map();
    let finishReason = null;
    let usage = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let eventEnd;
      while ((eventEnd = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, eventEnd);
        buffer = buffer.slice(eventEnd + 2);
        let data = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (!data) continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.type === "message_start") {
          messageId = parsed.message?.id || messageId;
        } else if (parsed.type === "content_block_start") {
          const block = parsed.content_block;
          if (block?.type === "tool_use") {
            toolBlocks.set(parsed.index, {
              id: block.id || "",
              name: block.name || "",
              arguments: ""
            });
          }
        } else if (parsed.type === "content_block_delta") {
          const delta = parsed.delta;
          if (delta?.type === "text_delta" && delta.text) {
            text += delta.text;
            onDelta?.({ content: delta.text });
          } else if (delta?.type === "input_json_delta" && delta.partial_json) {
            const block = toolBlocks.get(parsed.index);
            if (block) block.arguments += delta.partial_json;
          }
        } else if (parsed.type === "message_delta") {
          finishReason = parsed.delta?.stop_reason || finishReason;
          usage = parsed.usage || usage;
        }
      }
    }

    const toolCalls = [...toolBlocks.entries()]
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
      content: text,
      tool_calls: toolCalls.length ? toolCalls : undefined
    };
    if (!message.tool_calls) delete message.tool_calls;
    return {
      id: messageId,
      object: "chat.completion",
      choices: [{
        index: 0,
        finish_reason: finishReason,
        message
      }],
      usage
    };
  }

  async request(path, init, signal = null) {
    const url = `${this.provider.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const response = await fetchWithRetry(url, {
      ...init,
      headers: {
        ...(this.provider.headers || {}),
        authorization: `Bearer ${this.provider.apiKey}`,
        ...(init.headers || {})
      }
    }, { signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(formatProviderHttpError(this.provider.name, response.status, text));
    }
    return response;
  }
}

export function formatProviderHttpError(providerName, status, body = "") {
  const detail = body.slice(0, 800);
  const prefix = `${providerName} HTTP ${status}`;
  if (status === 401 || status === 403) {
    return `${prefix}: authentication failed. The saved API key was rejected by ${providerName}. Run '/login' in the TUI or 'azycode login ${providerName}' and enter a valid API key for this provider. Detail: ${detail}`;
  }
  return `${prefix}: ${detail}`;
}

export function applyReasoning(body, reasoning) {
  if (!reasoning) return;
  body.reasoning_effort = reasoning;
  body.extra_body = {
    ...(body.extra_body || {}),
    reasoning_effort: reasoning,
    thinking: reasoning === "minimal" ? false : { type: "enabled", budget: reasoning }
  };
}

export function assistantMessageFromCompletion(completion) {
  return completion?.choices?.[0]?.message || completion?.message || null;
}

export function toAnthropicTool(openaiTool) {
  const fn = openaiTool.function;
  return {
    name: fn.name,
    description: fn.description,
    input_schema: fn.parameters || { type: "object", properties: {} }
  };
}

export function toAnthropicMessages(messages) {
  const system = messages.filter((msg) => msg.role === "system").map((msg) => msg.content).join("\n\n");
  const anthropicMessages = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "tool") {
      const last = anthropicMessages[anthropicMessages.length - 1];
      const block = { type: "tool_result", tool_use_id: msg.tool_call_id, content: msg.content || "" };
      if (last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
        last.content.push(block);
      } else {
        anthropicMessages.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const content = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const call of msg.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(call.function?.arguments || "{}");
        } catch {
          input = { _invalidArguments: String(call.function?.arguments || "") };
        }
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function?.name,
          input
        });
      }
      anthropicMessages.push({ role: "assistant", content });
      continue;
    }
    if (msg.role === "assistant" || msg.role === "user") {
      anthropicMessages.push({ role: msg.role, content: msg.content || "" });
    }
  }
  return { system, anthropicMessages };
}

export function fromAnthropicMessage(raw) {
  const contentBlocks = raw.content || [];
  const text = contentBlocks.filter((block) => block.type === "text").map((block) => block.text).join("");
  const toolCalls = contentBlocks
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input || {})
      }
    }));
  return {
    id: raw.id,
    object: "chat.completion",
    choices: [{
      index: 0,
      finish_reason: raw.stop_reason || null,
      message: {
        role: "assistant",
        content: text,
        tool_calls: toolCalls.length ? toolCalls : undefined
      }
    }],
    usage: raw.usage
  };
}
