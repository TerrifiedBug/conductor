/** Read one property off an unvalidated transcript entry. */
function prop(source: unknown, key: string): unknown {
  if (source === null || typeof source !== "object") return undefined;
  return Reflect.get(source, key);
}

/**
 * One transcript line rendered for somebody watching, or `undefined` for the
 * lines not worth a row: thinking blocks, tool results, session metadata, and
 * anything this parser does not recognise.
 *
 * Defensive throughout. The transcript is written by the harness, not by this
 * package, so its shape is a peer dependency's business and can gain entry
 * types without warning.
 */
export function formatTranscriptLine(line: string): string | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (prop(entry, "type") !== "message") return undefined;
  const message = prop(entry, "message");
  if (prop(message, "role") !== "assistant") return undefined;

  const content = prop(message, "content");
  if (typeof content === "string") {
    return content.trim() === "" ? undefined : `assistant: ${content.trim()}`;
  }

  const blocks: readonly unknown[] = Array.isArray(content) ? content : [];
  const out: string[] = [];
  for (const block of blocks) {
    const type = prop(block, "type");
    if (type === "text") {
      const text = prop(block, "text");
      if (typeof text === "string" && text.trim() !== "") out.push(`assistant: ${text.trim()}`);
    } else if (type === "toolCall") {
      const name = prop(block, "name");
      if (typeof name === "string" && name !== "") out.push(`tool: ${name}`);
    }
  }
  return out.length === 0 ? undefined : out.join("\n");
}
