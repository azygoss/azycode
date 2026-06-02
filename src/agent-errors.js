import { formatAgentRunReport } from "./harness.js";

export class AgentStepLimitError extends Error {
  constructor({ maxSteps, events = [], partialContent = "" } = {}) {
    const report = formatAgentRunReport(events, { maxSteps });
    const body = [
      `Agent stopped after ${maxSteps} steps without a final answer.`,
      "The model kept requesting tools instead of returning a closing message.",
      "",
      "Steps in this run:",
      report || "  (no steps recorded)",
      "",
      "Try: simplify the task, use /compact, or remove agentMaxSteps from config for unlimited runs."
    ].join("\n");
    super(body);
    this.name = "AgentStepLimitError";
    this.maxSteps = maxSteps;
    this.events = events;
    this.partialContent = partialContent || "";
    this.report = report;
  }
}