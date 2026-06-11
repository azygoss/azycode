export const DEFAULT_MAX_CONVERSATION_MESSAGES = 40;

export function trimConversation(messages, maxMessages = DEFAULT_MAX_CONVERSATION_MESSAGES) {
  if (messages.length <= maxMessages) return messages;
  const tailStart = Math.max(0, messages.length - maxMessages);
  const userBoundary = messages.findIndex((message, index) => index >= tailStart && message.role === "user");
  return messages.slice(userBoundary === -1 ? tailStart : userBoundary);
}