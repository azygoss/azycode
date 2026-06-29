import { assistantMessageFromCompletion } from "./llm.js";
import { trimConversation } from "./conversation.js";
import { compactionSystemPrompt } from "./prompts.js";
import { formatActiveTodos } from "./todos.js";
import { searchMemory } from "./memory.js";

const DEFAULT_KEEP_RECENT = 12;
const PATH_PATTERN = /\b(?:[a-z0-9_./-]+\/)?[a-z0-9_./-]+\.(?:js|ts|jsx|tsx|py|go|rs|md|json|yml|yaml)\b/gi;

/**
 * Gather todo and memory context for compaction so long-horizon runs preserve
 * actionable state across context trims.
 */
export function buildCompactionContext(cwd = process.cwd(), { prompt = "", sessionId = null } = {}) {
  const todoState = formatActiveTodos(cwd, { sessionId });
  const memoryHits = searchMemory(String(prompt || "").slice(0, 160)).slice(0, 4);
  const memoryState = memoryHits.length
    ? `Relevant memory:\n${memoryHits.map((item) => `- ${item.text}`).join("\n")}`
    : "";
  return [todoState, memoryState].filter(Boolean).join("\n\n");
}

export function compactConversationDeterministic(messages, {
  keepRecent = DEFAULT_KEEP_RECENT,
  todoState = "",
  cwd = null,
  sessionId = null,
  prompt = ""
} = {}) {
  if (cwd) {
    const built = buildCompactionContext(cwd, { prompt, sessionId });
    todoState = todoState ? `${todoState}\n\n${built}` : built;
  }
  const nonSystem = messages.filter((message) => message.role !== "system");
  if (nonSystem.length <= keepRecent) return nonSystem;

  const old = nonSystem.slice(0, -keepRecent);
  const recent = nonSystem.slice(-keepRecent);
  const userRequirements = old
    .filter((message) => message.role === "user")
    .map((message) => String(message.content || "").trim())
    .filter(Boolean);

  const paths = new Set();
  const commands = new Set();
  const toolSummaries = [];

  for (const message of old) {
    if (message.role === "tool") {
      const text = String(message.content || "");
      const name = message.name || "tool";
      if (name === "shell" || /backend=/.test(text)) {
        const cmdMatch = text.match(/cmd=([^\n]+)/) || text.match(/shell.*?:\s*(.+)/i);
        if (cmdMatch) commands.add(cmdMatch[1].trim().slice(0, 200));
      }
      for (const match of text.matchAll(PATH_PATTERN)) paths.add(match[0]);
      const firstLine = text.split("\n")[0].slice(0, 180);
      toolSummaries.push(`[${name}] ${firstLine}${text.length > firstLine.length ? "…" : ""}`);
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        const toolName = call.function?.name;
        if (toolName) toolSummaries.push(`[planned ${toolName}]`);
      }
    }
    if (message.role === "user") {
      for (const match of String(message.content || "").matchAll(PATH_PATTERN)) paths.add(match[0]);
    }
  }

  const summaryParts = [
    "Earlier conversation compacted (deterministic).",
    userRequirements.length ? `User requirements preserved:\n${userRequirements.slice(0, 4).join("\n\n")}` : null,
    paths.size ? `Files referenced: ${[...paths].slice(0, 24).join(", ")}` : null,
    commands.size ? `Commands run: ${[...commands].slice(0, 12).join("; ")}` : null,
    todoState ? todoState : null,
    toolSummaries.length ? `Tool outcomes:\n${toolSummaries.slice(-18).join("\n")}` : null
  ].filter(Boolean);

  return [
    { role: "assistant", content: summaryParts.join("\n\n") },
    ...recent
  ];
}

export async function compactConversationWithModel({
  client,
  messages,
  model,
  keepRecent = DEFAULT_KEEP_RECENT,
  signal = null
}) {
  const nonSystem = messages.filter((message) => message.role !== "system");
  if (nonSystem.length <= keepRecent) return nonSystem;
  const old = nonSystem.slice(0, -keepRecent);
  const recent = nonSystem.slice(-keepRecent);
  const transcript = old.map((message) => {
    const prefix = message.role === "tool" ? `[tool:${message.name || "tool"}]` : `[${message.role}]`;
    const body = String(message.content || "").slice(0, 4000);
    const tools = message.tool_calls?.length
      ? `\n(tool_calls: ${message.tool_calls.map((call) => call.function?.name).filter(Boolean).join(", ")})`
      : "";
    return `${prefix} ${body}${tools}`;
  }).join("\n\n");

  const completion = await client.chat({
    messages: [
      {
        role: "system",
        content: compactionSystemPrompt()
      },
      { role: "user", content: transcript }
    ],
    tools: [],
    model,
    stream: false,
    signal
  });
  const summary = String(assistantMessageFromCompletion(completion)?.content || "").trim();
  if (!summary) return trimConversation(nonSystem, keepRecent);
  return [
    { role: "user", content: `Earlier conversation summary:\n${summary}` },
    { role: "assistant", content: "Understood. Continuing with the summarized prior context." },
    ...recent
  ];
}