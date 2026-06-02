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
  if (error.message?.includes("fetch failed") || error.message?.includes("network") || error.message?.includes("ECONNREFUSED")) return true;
  return false;
}

function isRetryableStatus(status) {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("TimeoutError")), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, init, { timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = MAX_RETRIES } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs);
      if (!response.ok && isRetryableStatus(response.status) && attempt < maxRetries) {
        const delay = RETRY_DELAY_BASE_MS * (2 ** attempt);
        warn(`LLM request HTTP ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
        await sleep(delay);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (isRetryableError(error) && attempt < maxRetries) {
        const delay = RETRY_DELAY_BASE_MS * (2 ** attempt);
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

  async chat({ messages, tools = [], model, reasoning, stream = false }) {
    const selectedModel = model || this.provider.model;
    const protocol = resolveProtocol(this.provider, selectedModel);
    if (protocol === "anthropic-messages") {
      return this.anthropicMessages({ messages, tools, model: selectedModel, reasoning, stream });
    }
    return this.openaiChat({ messages, tools, model: selectedModel, reasoning, stream });
  }

  async openaiChat({ messages, tools = [], model, reasoning, stream = false }) {
    const body = {
      model,
      messages,
      stream,
      tools: tools.length ? tools.map((tool) => tool.schema) : undefined,
      tool_choice: tools.length ? "auto" : undefined
    };
    applyReasoning(body, reasoning);
    const response = await this.request(chatPathFor(this.provider, model), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return response.json();
  }

  async anthropicMessages({ messages, tools = [], model, reasoning, stream = false }) {
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
    const response = await this.request(chatPathFor(this.provider, model), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });
    const raw = await response.json();
    return fromAnthropicMessage(raw);
  }

  async request(path, init) {
    const url = `${this.provider.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const response = await fetchWithRetry(url, {
      ...init,
      headers: {
        ...(this.provider.headers || {}),
        authorization: `Bearer ${this.provider.apiKey}`,
        ...(init.headers || {})
      }
    });
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
      anthropicMessages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: msg.tool_call_id, content: msg.content || "" }]
      });
      continue;
    }
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const content = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const call of msg.tool_calls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function?.name,
          input: JSON.parse(call.function?.arguments || "{}")
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
