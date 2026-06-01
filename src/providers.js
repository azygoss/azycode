export const PROVIDERS = {
  openai: {
    label: "OpenAI API / Codex models",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    defaultModel: "gpt-5.2",
    models: [
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.2-pro",
      "gpt-5.1",
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
      "gpt-5",
      "gpt-5-codex",
      "gpt-5-mini",
      "gpt-5-nano"
    ],
    envKey: "OPENAI_API_KEY",
    note: "ChatGPT subscription credentials are not an API key. Use an OpenAI API key or a compatible endpoint.",
    quota: "OpenAI API usage and limits are account/project specific; check the OpenAI dashboard when no quota endpoint is exposed."
  },
  kimi: {
    label: "Kimi Code / Coding Plan",
    protocol: "openai-chat",
    baseUrl: "https://api.kimi.com/coding/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    defaultModel: "kimi-for-coding",
    models: ["kimi-for-coding"],
    envKey: "KIMI_API_KEY",
    headers: { "user-agent": "claude-code/0.1.0" },
    note: "Kimi Code uses the coding-plan endpoint and quota, not the standard Moonshot API endpoint.",
    quota: "Kimi Code shares quota with the Kimi membership plan; exact remaining usage is shown in Kimi Code/Kimi membership surfaces."
  },
  "kimi-api": {
    label: "Kimi / Moonshot API",
    protocol: "openai-chat",
    baseUrl: "https://api.moonshot.ai/v1",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    defaultModel: "kimi-k2.6",
    models: [
      "kimi-k2.6",
      "kimi-k2.5",
      "moonshot-v1-8k",
      "moonshot-v1-32k",
      "moonshot-v1-128k",
      "moonshot-v1-8k-vision-preview",
      "moonshot-v1-32k-vision-preview",
      "moonshot-v1-128k-vision-preview"
    ],
    envKey: "MOONSHOT_API_KEY",
    quota: "Kimi/Moonshot API quota is account specific; Azycode can verify connectivity through /models."
  },
  "zai-coding": {
    label: "Z.AI GLM Coding Plan",
    protocol: "openai-chat",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    defaultModel: "glm-5.1",
    models: ["glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.6", "glm-4.5"],
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
    models: [
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2"
    ],
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
    models: [
      "glm-5.1",
      "glm-5",
      "kimi-k2.5",
      "kimi-k2.6",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "minimax-m3",
      "minimax-m2.7",
      "minimax-m2.5",
      "qwen3.7-max",
      "qwen3.6-plus",
      "qwen3.5-plus"
    ],
    envKey: "OPENCODE_GO_API_KEY",
    anthropicModels: ["minimax-m3", "minimax-m2.7", "minimax-m2.5"],
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

export function providerModelList(cfg, name) {
  const preset = providerPreset(name);
  const rawSaved = cfg.providers?.[name] || {};
  const saved = normalizeSavedProvider(name, rawSaved);
  const includeActiveModel = !(name === "kimi" && isOldKimiMoonshotConfig(rawSaved));
  return uniqueModels([
    ...(saved.models || []),
    saved.model,
    includeActiveModel && cfg.activeProvider === name ? cfg.activeModel : null,
    ...(preset.models || []),
    preset.defaultModel
  ]);
}

export function withProviderModels(cfg, name, saved = cfg.providers?.[name] || {}) {
  const normalized = normalizeSavedProvider(name, saved);
  const includeActiveModel = !(name === "kimi" && isOldKimiMoonshotConfig(saved));
  return {
    ...normalized,
    model: normalized.model || (includeActiveModel ? cfg.activeModel : null) || providerPreset(name).defaultModel,
    models: providerModelList({ ...cfg, providers: { ...(cfg.providers || {}), [name]: normalized } }, name)
  };
}

export function modelIdsFromResponse(result) {
  if (Array.isArray(result)) {
    return uniqueModels(result.map((model) => model.id || model.name || model.model || (typeof model === "string" ? model : null)));
  }
  if (result && typeof result === "object") return uniqueModels(Object.keys(result));
  return [];
}

export function providerConfig(cfg, name = cfg.activeProvider) {
  if (!name) throw new Error("No active provider. Run 'azycode login <provider>'.");
  const preset = providerPreset(name);
  const rawSaved = cfg.providers?.[name] || {};
  const saved = normalizeSavedProvider(name, rawSaved);
  const includeActiveModel = !(name === "kimi" && isOldKimiMoonshotConfig(rawSaved));
  return {
    name,
    ...preset,
    ...saved,
    baseUrl: normalizeBaseUrl(saved.baseUrl || preset.baseUrl),
    model: saved.model || (includeActiveModel ? cfg.activeModel : null) || preset.defaultModel,
    models: providerModelList(cfg, name),
    apiKey: saved.apiKey || process.env[preset.envKey]
  };
}

export function resolveProtocol(provider, model = provider.model) {
  if (provider.protocol !== "auto") return provider.protocol;
  if (provider.anthropicModels?.includes(model)) return "anthropic-messages";
  return "openai-chat";
}

function uniqueModels(models) {
  return [...new Set(models.filter(Boolean).map(String))];
}

function normalizeSavedProvider(name, saved) {
  if (name !== "kimi") return saved;
  if (!isOldKimiMoonshotConfig(saved)) return saved;
  return {
    ...saved,
    baseUrl: "",
    model: saved.model === "kimi-for-coding" ? saved.model : "",
    models: (saved.models || []).filter((model) => model === "kimi-for-coding")
  };
}

function isOldKimiMoonshotConfig(saved) {
  return normalizeBaseUrl(saved.baseUrl) === "https://api.moonshot.ai/v1";
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
