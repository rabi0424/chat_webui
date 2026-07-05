/**
 * Parses a text/event-stream body and yields the payload of each `data:` line.
 * Comment lines (e.g. OpenRouter's ": OPENROUTER PROCESSING" keep-alives) are
 * skipped. Ends when the stream closes or a `[DONE]` sentinel arrives.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trimEnd();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line.startsWith("data: ")) continue;
        const data = line.slice("data: ".length);
        if (data === "[DONE]") return;
        yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
