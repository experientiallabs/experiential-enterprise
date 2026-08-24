/**
 * Minimal SSE reading over a fetch body. `EventSource` cannot POST or carry
 * custom headers, so streaming surfaces (playground rollouts, optimizer run
 * progress, trace-ingest progress) read the response body directly. This is
 * the one shared reader: split the byte stream into events on blank lines,
 * join multi-line `data:` fields, ignore comments and non-data fields.
 * Consumers validate each payload through their own typed parser.
 */

/** Yield each SSE `data:` payload (joined per event) from a byte stream. */
export async function* readSseData(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  function takeEvent(): string | null {
    if (dataLines.length === 0) {
      return null;
    }
    const payload = dataLines.join("\n");
    dataLines = [];
    return payload;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Events are separated by blank lines; lines may end \n or \r\n.
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line === "") {
          const payload = takeEvent();
          if (payload !== null) {
            yield payload;
          }
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        // Comments (":") and other fields ("event:", "id:", "retry:") are ignored.
        newlineIndex = buffer.indexOf("\n");
      }
      if (done) {
        // A final event may end at EOF without a trailing blank line.
        if (buffer !== "" && buffer.startsWith("data:")) {
          dataLines.push(buffer.replace(/\r$/, "").slice(5).replace(/^ /, ""));
        }
        const payload = takeEvent();
        if (payload !== null) {
          yield payload;
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
