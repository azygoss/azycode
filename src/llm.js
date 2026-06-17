import { activeApiPath, chatPathFor, providerConfig, resolveProtocol, responsesPathFor } from "./providers.js";
import { buildOpenAiChatPayload, buildResponsesPayload, resolveProviderCapabilities } from "./provider-capabilities.js";
import { recordProviderFailure } from "./provider-errors.js";
import {
  applyAnthropicStreamEvent,
  createAnthropicStreamState,
  createOpenAiStreamState,
  finalizeAnthropicStream,
  finalizeOpenAiStream,
  parseAnthropicSseChunk,
  applyOpenAiStreamChunk
} from "./stream-parse.js";
import { debug, warn } from "./logger.js";
import { recordUsage } from "./usage-tracker.js";

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

/**
 * Merge multiple abort signals into one. Returns `{ signal, release }` so the
 * per-source listeners can be detached on completion (otherwise a long-lived
 * external signal accumulates leaked listeners across repeated calls).
 */
function mergeSignals(signals = []) {
  const active = signals.filter(Boolean);
  if (!active.length) return { signal: null, release: () => {} };
  const controller = new AbortController();
  const handlers = [];
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const signal of active) {
    if (signal.aborted) {
      abort(signal.reason || new Error("Aborted"));
      break;
    }
    const onAbort = () => abort(signal.reason || new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    handlers.push({ signal, onAbort });
  }
  const release = () => {
    for (const { signal, onAbort } of handlers) {
      signal.removeEventListener("abort", onAbort);
    }
  };
  // Self-clean if the merged signal itself fires.
  controller.signal.addEventListener("abort", release, { once: true });
  return { signal: controller.signal, release };
}

async function fetchWithTimeout(url, init, timeoutMs, externalSignal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("TimeoutError")), timeoutMs);
  const { signal: merged, release } = mergeSignals([controller.signal, externalSignal]);
  try {
    const response = await fetch(url, { ...init, signal: merged || controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
    release();
  }
}

function jitterDelay(baseMs, attempt) {
  const exponential = baseMs * (2 ** attempt);
  return exponential + Math.random() * baseMs;
}

export function parseRetryAfterMs(response) {
  const header = response?.headers?.get?.("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), 120_000);
  }
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), 120_000);
  }
  return null;
}

async function fetchWithRetry(url, init, { timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = MAX_RETRIES, signal = null } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new Error("Aborted");
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs, signal);
      if (!response.ok && isRetryableStatus(response.status) && attempt < maxRetries) {
        const retryAfter = parseRetryAfterMs(response);
        const delay = retryAfter ?? Math.round(jitterDelay(RETRY_DELAY_BASE_MS, attempt));
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
    const capabilities = resolveProviderCapabilities(this.provider, selectedModel);
    let completion;
    if (capabilities.supportsAnthropicMessages) {
      completion = await this.anthropicMessages({ messages, tools, model: selectedModel, reasoning, stream, signal, onDelta, capabilities });
    } else if (capabilities.apiMode === "responses" && capabilities.supportsResponsesAPI) {
      completion = await this.openaiResponses({ messages, tools, model: selectedModel, reasoning, stream, signal, onDelta, capabilities });
    } else {
      completion = await this.openaiChat({ messages, tools, model: selectedModel, reasoning, stream, signal, onDelta, capabilities });
    }
    if (completion?.usage) {
      recordUsage(this.provider.name, selectedModel, completion.usage);
    }
    return completion;
  }

  async openaiChat({ messages, tools = [], model, reasoning, stream = false, signal = null, onDelta = null, capabilities = null }) {
    const caps = capabilities || resolveProviderCapabilities(this.provider, model);
    const body = buildOpenAiChatPayload({ messages, tools, model, reasoning, capabilities: caps });
    body.stream = Boolean(stream);
    const path = chatPathFor(this.provider, model);
    if (stream && caps.supportsStreaming) {
      return this.openaiChatStream(path, body, signal, onDelta);
    }
    const response = await this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }, signal);
    return response.json();
  }

  async openaiResponses({ messages, tools = [], model, reasoning, stream = false, signal = null, onDelta = null, capabilities = null }) {
    const caps = capabilities || resolveProviderCapabilities(this.provider, model);
    const body = buildResponsesPayload({ messages, tools, model, reasoning, capabilities: caps });
    const path = responsesPathFor(this.provider);
    if (stream && caps.supportsStreaming) {
      return this.openaiResponsesStream(path, body, signal, onDelta);
    }
    const response = await this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }, signal);
    const raw = await response.json();
    return fromResponsesPayload(raw);
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
    let state = createOpenAiStreamState();

    try {
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
            state = { ...state, malformedChunks: (state.malformedChunks || 0) + 1 };
            continue;
          }
          const delta = chunk.choices?.[0]?.delta || {};
          if (delta.content) onDelta?.({ content: delta.content });
          state = applyOpenAiStreamChunk(state, chunk);
        }
      }

      return finalizeOpenAiStream(state);
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async openaiResponsesStream(path, body, signal = null, onDelta = null) {
    const response = await this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ ...body, stream: true })
    }, signal);
    if (!response.body) throw new Error("Streaming response missing body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCalls = [];
    let finishReason = null;
    let usage = null;

    try {
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
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          usage = event.response?.usage || event.usage || usage;
          finishReason = event.response?.status || event.type || finishReason;
          for (const item of event.response?.output || event.output || []) {
            if (item.type === "message" && item.content) {
              for (const part of item.content) {
                if (part.type === "output_text" && part.text) {
                  text += part.text;
                  onDelta?.({ content: part.text });
                }
              }
            }
            if (item.type === "function_call") {
              toolCalls.push({
                id: item.call_id || item.id || `call_${toolCalls.length}`,
                type: "function",
                function: {
                  name: item.name,
                  arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
                }
              });
            }
          }
        }
      }

      const message = {
        role: "assistant",
        content: text,
        tool_calls: toolCalls.length ? toolCalls : undefined
      };
      if (!message.tool_calls) delete message.tool_calls;
      return {
        id: "stream",
        object: "chat.completion",
        choices: [{ index: 0, finish_reason: finishReason, message }],
        usage
      };
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async anthropicMessages({ messages, tools = [], model, reasoning, stream = false, signal = null, onDelta = null, capabilities = null }) {
    const { system, anthropicMessages } = toAnthropicMessages(messages);
    const body = {
      model,
      max_tokens: 4096,
      stream,
      system: system || undefined,
      messages: anthropicMessages,
      tools: tools.length ? tools.map((tool) => toAnthropicTool(tool.schema)) : undefined
    };
    const caps = capabilities || resolveProviderCapabilities(this.provider, model);
    if (caps.supportsReasoningEffort && reasoning) applyReasoning(body, reasoning);
    const path = chatPathFor(this.provider, model);
    if (stream && caps.supportsStreaming) {
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
    let state = createAnthropicStreamState();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let eventEnd;
        while ((eventEnd = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          const parsed = parseAnthropicSseChunk(chunk, state);
          state = parsed.state;
          const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
          if (dataLine) {
            try {
              const event = JSON.parse(dataLine);
              if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
                onDelta?.({ content: event.delta.text });
              }
            } catch {
              // ignore malformed chunk
            }
          }
        }
      }

      return finalizeAnthropicStream(state);
    } finally {
      await reader.cancel().catch(() => {});
    }
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
    }, { timeoutMs: requestTimeoutMs(), signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const message = formatProviderHttpError(this.provider.name, response.status, text);
      recordProviderFailure({
        provider: this.provider.name,
        status: response.status,
        message,
        path
      });
      throw new Error(message);
    }
    return response;
  }
}

export function fromResponsesPayload(raw) {
  const output = raw.output || raw.response?.output || [];
  let text = "";
  const toolCalls = [];
  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text") text += part.text || "";
        if (part.type === "text") text += part.text || "";
      }
    }
    if (item.type === "function_call" || item.type === "tool_call") {
      toolCalls.push({
        id: item.call_id || item.id || `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || item.input || {})
        }
      });
    }
  }
  const message = {
    role: "assistant",
    content: text || raw.output_text || "",
    tool_calls: toolCalls.length ? toolCalls : undefined
  };
  if (!message.tool_calls) delete message.tool_calls;
  return {
    id: raw.id || "responses",
    object: "chat.completion",
    choices: [{
      index: 0,
      finish_reason: raw.status || raw.stop_reason || null,
      message
    }],
    usage: raw.usage || raw.response?.usage || null
  };
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
