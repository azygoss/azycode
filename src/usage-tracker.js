/** Token and cost tracking for LLM calls. Zero-dependency. */

import fs from "node:fs";
import path from "node:path";
import { azyHome, ensureHome } from "./config.js";
import { debug } from "./logger.js";

/** Pricing per 1M tokens in USD. null = unknown pricing. */
const PROVIDER_PRICING = {
  openai: {
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4-turbo": { input: 10, output: 30 },
    "gpt-4": { input: 30, output: 60 },
    "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
    "o1": { input: 15, output: 60 },
    "o1-mini": { input: 3, output: 12 },
    "o3-mini": { input: 1.1, output: 4.4 },
    "o3": { input: 10, output: 40 },
    "o4-mini": { input: 1.1, output: 4.4 }
  },
  anthropic: {
    "claude-3-5-sonnet": { input: 3, output: 15 },
    "claude-3-5-haiku": { input: 0.8, output: 4 },
    "claude-3-opus": { input: 15, output: 75 },
    "claude-3-sonnet": { input: 3, output: 15 },
    "claude-3-haiku": { input: 0.25, output: 1.25 },
    "claude-sonnet-4": { input: 3, output: 15 },
    "claude-opus-4": { input: 15, output: 75 }
  },
  kimi: {
    "moonshot-v1-8k": { input: 1.6, output: 1.6 },
    "moonshot-v1-32k": { input: 3.3, output: 3.3 },
    "moonshot-v1-128k": { input: 8.7, output: 8.7 },
    default: { input: 2, output: 6 }
  },
  minimax: {
    default: { input: 1, output: 1 }
  },
  "zai-coding": {
    default: { input: 2, output: 8 }
  },
  "opencode-go": {
    default: { input: 1.5, output: 6 }
  },
  byok: {
    default: { input: 0, output: 0 }
  }
};

const DEFAULT_USAGE = () => ({ version: 1, entries: [] });
const MAX_ENTRIES = 5000;

let _cachedHome = null;
let _usageCache = null;
let _usageMtime = 0;

function usagePath() {
  return path.join(azyHome(), "usage.json");
}

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function loadUsage() {
  ensureHome();
  const home = azyHome();
  const uPath = usagePath();
  const mtime = fileMtime(uPath);
  if (_usageCache && _cachedHome === home && _usageMtime === mtime) {
    return typeof structuredClone === "function" ? structuredClone(_usageCache) : JSON.parse(JSON.stringify(_usageCache));
  }
  try {
    const data = JSON.parse(fs.readFileSync(uPath, "utf8"));
    const normalized = {
      version: data.version || 1,
      entries: Array.isArray(data.entries) ? data.entries : []
    };
    _usageCache = normalized;
    _cachedHome = home;
    _usageMtime = mtime;
    return typeof structuredClone === "function" ? structuredClone(normalized) : JSON.parse(JSON.stringify(normalized));
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_USAGE();
    throw error;
  }
}

export function saveUsage(usage) {
  ensureHome();
  const tmp = `${usagePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(usage, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, usagePath());
  _usageCache = null;
  _cachedHome = null;
  _usageMtime = 0;
}

function loadUsageFresh() {
  ensureHome();
  _usageCache = null;
  _cachedHome = null;
  _usageMtime = 0;
  try {
    const data = JSON.parse(fs.readFileSync(usagePath(), "utf8"));
    return {
      version: data.version || 1,
      entries: Array.isArray(data.entries) ? data.entries : []
    };
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_USAGE();
    throw error;
  }
}

/**
 * Record a single LLM call's token usage.
 * @param {string} provider - Provider name (e.g., "openai", "kimi")
 * @param {string} model - Model identifier (e.g., "gpt-4o")
 * @param {{prompt_tokens?: number, completion_tokens?: number, total_tokens?: number}} usage - Token counts
 * @param {string} [sessionId] - Optional session ID for correlation
 */
export function recordUsage(provider, model, usage, sessionId = null) {
  if (!usage || typeof usage !== "object") return;
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const totalTokens = Number(usage.total_tokens) || (promptTokens + completionTokens);

  if (totalTokens === 0) return;

  const entry = {
    id: `usg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    provider: String(provider || "unknown"),
    model: String(model || "unknown"),
    promptTokens,
    completionTokens,
    totalTokens,
    cost: computeCost(provider, model, promptTokens, completionTokens),
    sessionId: sessionId ? String(sessionId) : null,
    at: new Date().toISOString()
  };

  try {
    const usageData = loadUsageFresh();
    usageData.entries.push(entry);
    if (usageData.entries.length > MAX_ENTRIES) {
      usageData.entries = usageData.entries.slice(-MAX_ENTRIES);
    }
    saveUsage(usageData);
    debug(`Usage recorded: ${entry.provider}/${entry.model} ${totalTokens} tokens, $${entry.cost}`);
  } catch (error) {
    debug(`Usage record failed: ${error.message}`);
  }
}

export function resetUsageCache() {
  _usageCache = null;
  _cachedHome = null;
  _usageMtime = 0;
}

export function flushUsage() {
  /* No-op: usage is written synchronously per call for reliability. */
}

export function computeCost(provider, model, promptTokens, completionTokens) {
  const providerPricing = PROVIDER_PRICING[provider] || PROVIDER_PRICING.byok;
  const modelPricing = providerPricing[model] || providerPricing.default || { input: 0, output: 0 };
  const inputCost = (promptTokens / 1_000_000) * (modelPricing.input || 0);
  const outputCost = (completionTokens / 1_000_000) * (modelPricing.output || 0);
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

export function getUsageStats({ since = null, provider = null, model = null } = {}) {
  const usage = loadUsageFresh();
  let entries = usage.entries;

  if (since) {
    const sinceMs = new Date(since).getTime();
    if (Number.isFinite(sinceMs)) {
      entries = entries.filter((entry) => new Date(entry.at).getTime() >= sinceMs);
    }
  }
  if (provider) {
    entries = entries.filter((entry) => entry.provider === provider);
  }
  if (model) {
    entries = entries.filter((entry) => entry.model === model);
  }

  const totals = entries.reduce((acc, entry) => {
    acc.promptTokens += entry.promptTokens || 0;
    acc.completionTokens += entry.completionTokens || 0;
    acc.totalTokens += entry.totalTokens || 0;
    acc.cost += entry.cost || 0;
    return acc;
  }, { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 });

  const byProvider = {};
  const byModel = {};
  for (const entry of entries) {
    if (!byProvider[entry.provider]) {
      byProvider[entry.provider] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, calls: 0 };
    }
    byProvider[entry.provider].promptTokens += entry.promptTokens || 0;
    byProvider[entry.provider].completionTokens += entry.completionTokens || 0;
    byProvider[entry.provider].totalTokens += entry.totalTokens || 0;
    byProvider[entry.provider].cost += entry.cost || 0;
    byProvider[entry.provider].calls += 1;

    if (!byModel[entry.model]) {
      byModel[entry.model] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, calls: 0 };
    }
    byModel[entry.model].promptTokens += entry.promptTokens || 0;
    byModel[entry.model].completionTokens += entry.completionTokens || 0;
    byModel[entry.model].totalTokens += entry.totalTokens || 0;
    byModel[entry.model].cost += entry.cost || 0;
    byModel[entry.model].calls += 1;
  }

  return {
    entries: entries.length,
    calls: entries.length,
    ...totals,
    cost: Math.round(totals.cost * 1_000_000) / 1_000_000,
    byProvider,
    byModel,
    firstEntry: entries[0]?.at || null,
    lastEntry: entries[entries.length - 1]?.at || null
  };
}

export function resetUsage({ before = null } = {}) {
  _usageCache = null;
  _usageMtime = 0;
  if (before) {
    const beforeMs = new Date(before).getTime();
    if (Number.isFinite(beforeMs)) {
      const usage = loadUsage();
      usage.entries = usage.entries.filter((entry) => new Date(entry.at).getTime() < beforeMs);
      saveUsage(usage);
      return usage.entries.length;
    }
  }
  saveUsage(DEFAULT_USAGE());
  return 0;
}

export function formatUsageReport(stats) {
  const lines = [
    "Usage Summary",
    `entries: ${stats.entries}`,
    `calls: ${stats.calls}`,
    `prompt tokens: ${stats.promptTokens.toLocaleString()}`,
    `completion tokens: ${stats.completionTokens.toLocaleString()}`,
    `total tokens: ${stats.totalTokens.toLocaleString()}`,
    `estimated cost: $${stats.cost.toFixed(4)}`
  ];

  if (stats.firstEntry) lines.push(`range: ${stats.firstEntry} → ${stats.lastEntry || stats.firstEntry}`);

  const providerEntries = Object.entries(stats.byProvider).sort((a, b) => b[1].cost - a[1].cost);
  if (providerEntries.length > 1) {
    lines.push("", "By provider:");
    for (const [name, data] of providerEntries) {
      lines.push(`  ${name}: ${data.calls} calls, ${data.totalTokens.toLocaleString()} tokens, $${data.cost.toFixed(4)}`);
    }
  }

  const modelEntries = Object.entries(stats.byModel).sort((a, b) => b[1].cost - a[1].cost);
  if (modelEntries.length > 1) {
    lines.push("", "By model:");
    for (const [name, data] of modelEntries) {
      lines.push(`  ${name}: ${data.calls} calls, ${data.totalTokens.toLocaleString()} tokens, $${data.cost.toFixed(4)}`);
    }
  }

  return lines.join("\n");
}

export function pricingInfo() {
  return PROVIDER_PRICING;
}

// ---------------------------------------------------------------------------
// Session cost accumulation
// ---------------------------------------------------------------------------

let sessionCosts = [];

export function trackRunCost({ model, inputTokens, outputTokens, duration, step }) {
  const pricing = getModelPricing(model);
  const cost = pricing
    ? (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output
    : 0;
  const entry = { model, inputTokens, outputTokens, cost, duration, step, timestamp: Date.now() };
  sessionCosts.push(entry);
  return entry;
}

export function getSessionCosts() {
  return {
    runs: [...sessionCosts],
    totalCost: sessionCosts.reduce((sum, entry) => sum + entry.cost, 0),
    totalInputTokens: sessionCosts.reduce((sum, entry) => sum + entry.inputTokens, 0),
    totalOutputTokens: sessionCosts.reduce((sum, entry) => sum + entry.outputTokens, 0)
  };
}

export function resetSessionCosts() {
  sessionCosts = [];
}

function getModelPricing(model) {
  const name = String(model || "").toLowerCase();
  const table = {
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4.1": { input: 2.0, output: 8.0 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "gpt-4.1-nano": { input: 0.1, output: 0.4 },
    "o3": { input: 2.0, output: 8.0 },
    "o3-mini": { input: 1.1, output: 4.4 },
    "o4-mini": { input: 1.1, output: 4.4 },
    "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
    "claude-3-5-sonnet": { input: 3.0, output: 15.0 },
    "claude-3-5-haiku": { input: 0.8, output: 4.0 },
    "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
    "gemini-2.5-pro": { input: 1.25, output: 10.0 },
    "gemini-2.5-flash": { input: 0.15, output: 0.6 },
    "moonshot-v1": { input: 1.0, output: 2.0 },
    "kimi-latest": { input: 1.0, output: 2.0 },
    "deepseek-chat": { input: 0.14, output: 0.28 },
    "deepseek-reasoner": { input: 0.55, output: 2.19 }
  };
  // Try exact match first, then partial match
  if (table[name]) return table[name];
  for (const [key, value] of Object.entries(table)) {
    if (name.includes(key) || key.includes(name)) return value;
  }
  return null;
}
