import { formatAgentRunReport } from "./harness.js";

export class AgentRunError extends Error {
  constructor(message, { events = [], report = "", style = "tui" } = {}) {
    super(message);
    this.name = "AgentRunError";
    this.events = events;
    this.report = report;
    this.style = style;
  }
}

export class AgentStepLimitError extends AgentRunError {
  constructor({ maxSteps, events = [], partialContent = "", style = "tui" } = {}) {
    const report = formatAgentRunReport(events, { maxSteps, style });
    const body = [
      `Agent stopped after ${maxSteps} steps without a final answer.`,
      "The model kept requesting tools instead of returning a closing message.",
      "",
      "Steps in this run:",
      report || "  (no steps recorded)",
      "",
      "Try: simplify the task, use /compact, or remove agentMaxSteps from config for unlimited runs."
    ].join("\n");
    super(body, { events, report, style });
    this.name = "AgentStepLimitError";
    this.maxSteps = maxSteps;
    this.partialContent = partialContent || "";
  }
}

export class AgentCancelledError extends AgentRunError {
  constructor({ events = [], style = "tui" } = {}) {
    const report = formatAgentRunReport(events, { style });
    super("Agent run cancelled.", { events, report, style });
    this.name = "AgentCancelledError";
  }
}