import { LlmClient } from "./llm.js";
import { modelIdsFromResponse, providerModelList, withProviderModels } from "./providers.js";

export async function syncProviderModels(cfg, providerName) {
  if (!providerName || !cfg.providers?.[providerName]) {
    throw new Error(`Provider is not configured: ${providerName || "none"}`);
  }
  const scopedCfg = {
    ...cfg,
    activeProvider: providerName,
    activeModel: cfg.providers[providerName]?.model || cfg.activeModel
  };
  const result = await new LlmClient(scopedCfg, providerName).listModels();
  const remoteModels = modelIdsFromResponse(result);
  const beforeModels = providerModelList(scopedCfg, providerName);
  cfg.providers[providerName] = withProviderModels(scopedCfg, providerName, {
    ...cfg.providers[providerName],
    models: [...beforeModels, ...remoteModels]
  });
  if (cfg.activeProvider === providerName) {
    cfg.activeModel = cfg.providers[providerName].model;
  }
  return {
    provider: providerName,
    remoteCount: remoteModels.length,
    totalCount: providerModelList(cfg, providerName).length
  };
}

export async function syncConfiguredProviderModels(cfg, names = Object.keys(cfg.providers || {})) {
  const results = [];
  for (const name of names) {
    try {
      results.push({ ok: true, ...(await syncProviderModels(cfg, name)) });
    } catch (error) {
      results.push({ ok: false, provider: name, error: error.message });
    }
  }
  return results;
}
