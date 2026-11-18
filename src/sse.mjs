export async function* parseSSE(stream, maxEventBytes = 32 * 1024 * 1024) {
  const decoder = new TextDecoder();
  let buffer = '', data = [], eventBytes = 0;
  function consume(line) {
    if (!line) {
      const raw = data.join('\n'); data = []; eventBytes = 0;
      if (!raw) return undefined;
      if (raw === '[DONE]') return undefined;
      try { return JSON.parse(raw); }
      catch { const error = new Error('Invalid JSON in upstream SSE event.'); error.status = 502; throw error; }
    }
    if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '');
      eventBytes += Buffer.byteLength(value);
      if (eventBytes > maxEventBytes) { const error = new Error('Upstream SSE event is too large.'); error.status = 502; throw error; }
      data.push(value);
    }
    return undefined;
  }
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      const event = consume(line);
      if (event !== undefined) yield event;
    }
    if (Buffer.byteLength(buffer) > maxEventBytes) { const error = new Error('Upstream SSE line is too large.'); error.status = 502; throw error; }
  }
  buffer += decoder.decode();
  // An event without its blank delimiter is truncated, even if its JSON parses.
  if (buffer.trim() || data.length) { const error = new Error('Upstream SSE stream ended inside an event.'); error.status = 502; throw error; }
}
