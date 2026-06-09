// Inject relevant memories as a non-persistent preamble on the latest user
// message. Keeping the system prompt stable lets local providers reuse their
// prefix/KV cache; only the most recent user turn carries the memory block.
export function applyUserPreamble(messages: any[], preamble: string): any[] {
  if (!preamble) return messages;
  const next = [...messages];
  const idx = next.findLastIndex((message) => message?.role === "user");
  if (idx < 0) return messages;
  const message = { ...next[idx] };
  const prefix = `${preamble}\n\n## User request\n`;
  if (typeof message.content === "string") {
    message.content = message.content.startsWith(preamble) ? message.content : `${prefix}${message.content}`;
  } else if (Array.isArray(message.content)) {
    const content = [...message.content];
    const textIdx = content.findIndex((block) => block?.type === "text");
    if (textIdx >= 0) {
      const block = { ...content[textIdx] };
      const text = String(block.text ?? "");
      block.text = text.startsWith(preamble) ? text : `${prefix}${text}`;
      content[textIdx] = block;
    } else {
      content.unshift({ type: "text", text: prefix.trimEnd() });
    }
    message.content = content;
  }
  next[idx] = message;
  return next;
}
