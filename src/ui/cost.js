// src/ui/cost.js
// Model pricing + cost estimation business logic, separated from rendering.
// Depends on the ansi layer for formatting styles and layout for the box.

import { style, muted, faint, bold, padEnd, truncate } from "./ansi.js";
import { box } from "./layout.js";

/**
 * Per-model USD pricing per 1M tokens (input/output). Used by {@link estimateCost}.
 * Unknown models fall back to partial (substring) matching against these keys.
 */
export const MODEL_PRICING = {
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

/**
 * Estimate the USD cost of a model call. Unknown models resolve via partial
 * substring matching against {@link MODEL_PRICING}; if no match is found the
 * result is `null` (caller should render "pricing unavailable").
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {{inputCost:number,outputCost:number,totalCost:number}|null}
 */
export function estimateCost(model, inputTokens, outputTokens) {
  const modelName = String(model ?? "").toLowerCase();
  let pricing = MODEL_PRICING[modelName] || null;
  if (!pricing) {
    for (const key of Object.keys(MODEL_PRICING)) {
      if (modelName.includes(key) || key.includes(modelName)) {
        pricing = MODEL_PRICING[key];
        break;
      }
    }
  }
  if (!pricing) return null;
  const inTok = Math.max(0, Number(inputTokens) || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  const inputCost = (inTok / 1_000_000) * pricing.input;
  const outputCost = (outTok / 1_000_000) * pricing.output;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

/** Format a token count compactly (e.g. 12.3k, 1.2M). */
export function formatTokenCount(n) {
  const val = Number(n) || 0;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
  return String(val);
}

/** Format a USD amount with adaptive precision for very small costs. */
export function formatUSD(amount) {
  const val = Math.max(0, Number(amount) || 0);
  if (val === 0) return "$0.00";
  if (val < 0.001) return `$${val.toFixed(6)}`;
  if (val < 0.01) return `$${val.toFixed(4)}`;
  if (val < 1) return `$${val.toFixed(3)}`;
  return `$${val.toFixed(2)}`;
}

/** Map a cost amount to a severity color name (success/warn/error). */
export function costColor(amount) {
  if (amount < 0.01) return "success";
  if (amount < 0.10) return "warn";
  return "error";
}

/** Render a single-run cost line with in/out token counts and optional session total. */
export function costDisplay({ model, inputTokens, outputTokens, sessionTotal = null, width = 60 } = {}) {
  const estimate = estimateCost(model, inputTokens, outputTokens);
  if (!estimate) return muted("(pricing unavailable)");

  const costStr = style(formatUSD(estimate.totalCost), costColor(estimate.totalCost));
  const inStr = faint(`in: ${formatTokenCount(inputTokens)}`);
  const outStr = faint(`out: ${formatTokenCount(outputTokens)}`);
  const parts = [`${costStr} ${muted("(")}${inStr}${muted(" · ")}${outStr}${muted(")")}`];

  if (sessionTotal != null) {
    parts.push(`${muted("session:")} ${style(formatUSD(sessionTotal), costColor(sessionTotal))}`);
  }

  return parts.join(style(" · ", "subtle"));
}

/** Render a boxed cost summary listing individual runs and the session total. */
export function costSummaryPanel({ runs = [], sessionTotal = 0, width = 60 } = {}) {
  const rows = [];
  if (runs.length) {
    for (const [i, run] of runs.entries()) {
      const idx = faint(`#${i + 1}`);
      const modelLabel = run.model ? truncate(run.model, 20) : "unknown";
      const cost = run.cost != null ? style(formatUSD(run.cost), costColor(run.cost)) : muted("—");
      rows.push(`  ${idx}  ${padEnd(modelLabel, 22)} ${cost}`);
    }
    rows.push("");
  }
  const total = style(formatUSD(sessionTotal), costColor(sessionTotal));
  rows.push(`  ${bold("Session total:")} ${total}`);
  return box(rows, { width, title: "Cost Summary", titleTone: "accent", frame: "rounded", color: "borderSoft", padding: 1 });
}
