export interface SseMessage {
  event?: string;
  data: string;
}

export class SseParser {
  private buffer = "";

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const messages: SseMessage[] = [];
    let split = this.buffer.indexOf("\n\n");
    while (split >= 0) {
      const block = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      const message = parseBlock(block);
      if (message) messages.push(message);
      split = this.buffer.indexOf("\n\n");
    }
    return messages;
  }
}

function parseBlock(block: string): SseMessage | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (data.length === 0) return null;
  return event ? { event, data: data.join("\n") } : { data: data.join("\n") };
}
