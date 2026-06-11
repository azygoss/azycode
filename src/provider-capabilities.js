import { resolveProtocol } from "./providers.js";

export const DEFAULT_CAPABILITIES = {
  supportsTools: true,
  supportsStreaming: true,
  supportsReasoningEffort: true,
  supportsResponsesAPI: false,
  supportsAnthropicMessages: false,
  supportsVision: false,
  maxInputTokens: null,
  maxOutputTokens: null,
  toolChoice: "auto"
};

const VISION_MODEL_PATTERN = /vision|gpt-4o|gpt-5|claude-3|gemini/i;

export function resolveProviderCapabilities(provider, model = provider?.model) {
  const protocol = resolveProtocol(provider, model);
  const presetCaps = provider?.capabilities || {};
  const modelCaps = provider?.modelCapabilities?.[model] || {};
  const apiMode = provider?.apiMode || "chat";

  const capabilities = {
    ...DEFAULT_CAPABILITIES,
    ...presetCaps,
    ...modelCaps,
    supportsAnthropicMessages: protocol === "anthropic-messages",
    supportsResponsesAPI: apiMode === "responses" || Boolean(provider?.responsesPath) || presetCaps.supportsResponsesAPI === true,
    protocol,
    apiMode: apiMode === "responses" && (presetCaps.supportsResponsesAPI || provider?.responsesPath) ? "responses" : "chat"
  };

  if (VISION_MODEL_PATTERN.test(String(model || ""))) {
    capabilities.supportsVision = modelCaps.supportsVision ?? true;
  }

  return capabilities;
}

export function buildOpenAiChatPayload({ messages, tools, model, reasoning, capabilities }) {
  const body = {
    model,
    messages,
    stream: false
  };

  if (capabilities.supportsTools && tools.length) {
    body.tools = tools.map((tool) => tool.schema);
    body.tool_choice = capabilities.toolChoice || "auto";
  }

  if (capabilities.supportsReasoningEffort && reasoning) {
    body.reasoning_effort = reasoning;
    body.extra_body = {
      ...(body.extra_body || {}),
      reasoning_effort: reasoning,
      thinking: reasoning === "minimal" ? false : { type: "enabled", budget: reasoning }
    };
  }

  if (capabilities.maxOutputTokens) {
    body.max_tokens = capabilities.maxOutputTokens;
  }

  return body;
}

export function messagesToResponsesInput(messages) {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") {
        return {
          type: "function_call_output",
          call_id: message.tool_call_id,
          output: String(message.content || "")
        };
      }
      if (message.role === "assistant" && message.tool_calls?.length) {
        return message.tool_calls.map((call) => ({
          type: "function_call",
          call_id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments || "{}"
        }));
      }
      return {
        role: message.role,
        content: String(message.content || "")
      };
    })
    .flat();
}

export function buildResponsesPayload({ messages, tools, model, reasoning, capabilities }) {
  const system = messages.filter((msg) => msg.role === "system").map((msg) => msg.content).join("\n\n");
  const body = {
    model,
    input: messagesToResponsesInput(messages)
  };
  if (system) body.instructions = system;
  if (capabilities.supportsTools && tools.length) {
    body.tools = tools.map((tool) => tool.schema);
    body.tool_choice = capabilities.toolChoice || "auto";
  }
  if (capabilities.supportsReasoningEffort && reasoning) {
    body.reasoning = { effort: reasoning };
  }
  if (capabilities.maxOutputTokens) {
    body.max_output_tokens = capabilities.maxOutputTokens;
  }
  return body;
}