import { assistantMessageFromCompletion } from "./llm.js";
import { trimConversation } from "./conversation.js";
import { compactionSystemPrompt } from "./prompts.js";

const DEFAULT_KEEP_RECENT = 12;

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