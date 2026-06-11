import { buildStepLimitReport } from "./agent-report.js";
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
  constructor({ maxSteps, events = [], partialContent = "", style = "tui", cwd = process.cwd() } = {}) {
    const body = buildStepLimitReport({ maxSteps, events, partialContent, cwd, style });
    const report = body.split("\n").slice(3).join("\n");
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