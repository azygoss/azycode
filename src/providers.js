export const PROVIDERS = {
  openai: {
    label: "OpenAI API / Codex models",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    defaultModel: "gpt-5.2",
    envKey: "OPENAI_API_KEY",
    note: "ChatGPT subscription credentials are not an API key. Use an OpenAI API key or a compatible endpoint.",
    quota: "OpenAI API usage and limits are account/project specific; check the OpenAI dashboard when no quota endpoint is exposed."
  },
  kimi: {
    label: "Kimi / Moonshot",
    protocol: "openai-chat",
    baseUrl: "https://api.moonshot.ai/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    defaultModel: "kimi-k2.6",
    envKey: "MOONSHOT_API_KEY",
    quota: "Kimi/Moonshot quota is account specific; Azycode can verify connectivity through /models."
  },
  "zai-coding": {
    label: "Z.AI GLM Coding Plan",
    protocol: "openai-chat",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    defaultModel: "glm-5.1",
    envKey: "ZHIPU_API_KEY",
    quota: "Z.AI Coding Plan exposes coding models through the dedicated coding endpoint; remaining plan limits may require the Z.AI dashboard."
  },
  minimax: {
    label: "MiniMax Token/Coding Plan",
    protocol: "openai-chat",
    baseUrl: "https://api.minimax.io/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    defaultModel: "MiniMax-M2.7",
    envKey: "MINIMAX_API_KEY",
    quota: "MiniMax plan usage is provider-account specific; use /models for availability and the dashboard for exact remaining usage."
  },
  "opencode-go": {
    label: "OpenCode Go",
    protocol: "auto",
    baseUrl: "https://opencode.ai/zen/go/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    messagesPath: "/messages",
    defaultModel: "kimi-k2.6",
    envKey: "OPENCODE_GO_API_KEY",
    anthropicModels: ["minimax-m3", "minimax-m2.7", "minimax-m2.5", "qwen3.7-max", "qwen3.6-plus"],
    note: "OpenCode Go routes Kimi/GLM/DeepSeek/MiMo through chat/completions and MiniMax/Qwen through Anthropic messages.",
    quota: "Documented Go limits: $12 per 5 hours, $30 weekly, $60 monthly. Exact remaining usage is tracked in the OpenCode console."
  },
  byok: {
    label: "BYOK OpenAI-compatible",
    protocol: "openai-chat",
    baseUrl: "",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    defaultModel: "",
    envKey: "AZYCODE_API_KEY",
    quota: "BYOK quota depends on the custom endpoint."
  }
};

export function providerPreset(name) {
  const preset = PROVIDERS[name];
  if (!preset) {
    throw new Error(`Unknown provider '${name}'. Run 'azycode providers'.`);
  }
  return preset;
}

export function providerNames() {
  return Object.keys(PROVIDERS);
}

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

export function providerConfig(cfg, name = cfg.activeProvider) {
  if (!name) throw new Error("No active provider. Run 'azycode login <provider>'.");
  const preset = providerPreset(name);
  const saved = cfg.providers?.[name] || {};
  return {
    name,
    ...preset,
    ...saved,
    baseUrl: normalizeBaseUrl(saved.baseUrl || preset.baseUrl),
    model: saved.model || cfg.activeModel || preset.defaultModel,
    apiKey: saved.apiKey || process.env[preset.envKey]
  };
}

export function resolveProtocol(provider, model = provider.model) {
  if (provider.protocol !== "auto") return provider.protocol;
  if (provider.anthropicModels?.includes(model)) return "anthropic-messages";
  return "openai-chat";
}

export function chatPathFor(provider, model = provider.model) {
  return resolveProtocol(provider, model) === "anthropic-messages"
    ? provider.messagesPath || "/messages"
    : provider.chatPath || "/chat/completions";
}

export function providerDiagnostics(cfg, name = cfg.activeProvider) {
  const provider = providerConfig(cfg, name);
  return {
    name: provider.name,
    label: provider.label,
    baseUrl: provider.baseUrl,
    model: provider.model,
    protocol: resolveProtocol(provider, provider.model),
    chatPath: chatPathFor(provider, provider.model),
    hasApiKey: Boolean(provider.apiKey),
    apiKeySource: cfg.providers?.[name]?.apiKey ? "config" : provider.envKey,
    quota: provider.quota || null
  };
}
