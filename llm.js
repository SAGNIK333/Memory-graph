// Streaming chat client (Server-Sent Events). No SillyTavern dependencies, so it can be tested in Node.

export class StreamError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'StreamError';
    Object.assign(this, extra);
  }
}

const str = (x) => (typeof x === 'string' ? x : '');
const finishOf = (f) => {
  const k = String(f || '').toLowerCase();
  if (!k) return null;
  return k === 'length' || k === 'max_tokens' ? 'length' : k;
};

// Pull answer text / reasoning text / finish reason out of one streamed JSON chunk, whatever the provider's shape.
export function extractDelta(d) {
  const out = { text: '', reasoning: '', finish: null };
  if (!d || typeof d !== 'object') return out;

  // OpenAI-style (OpenAI, DeepSeek, OpenRouter, custom endpoints...)
  const ch = Array.isArray(d.choices) ? d.choices[0] : null;
  if (ch) {
    const delta = ch.delta || ch.message || {};
    const c = delta.content;
    if (typeof c === 'string') out.text += c;
    else if (Array.isArray(c)) out.text += c.map((p) => str(p && p.text)).join('');
    else if (typeof ch.text === 'string') out.text += ch.text;
    out.reasoning += str(delta.reasoning_content) + str(delta.reasoning) + str(delta.thinking);
    out.finish = finishOf(ch.finish_reason);
    return out;
  }

  // Gemini
  const cand = Array.isArray(d.candidates) ? d.candidates[0] : null;
  if (cand) {
    for (const p of (cand.content && cand.content.parts) || []) {
      if (p && p.thought) out.reasoning += str(p.text);
      else out.text += str(p && p.text);
    }
    const f = finishOf(cand.finishReason);
    out.finish = f === 'stop' ? 'stop' : f;
    return out;
  }

  // Anthropic / Cohere
  if (d.delta && typeof d.delta === 'object') {
    const dl = d.delta;
    if (dl.type === 'thinking_delta' || dl.thinking) out.reasoning += str(dl.thinking);
    else out.text += str(dl.text);
    const cm = dl.message && dl.message.content && dl.message.content.text;
    if (cm) out.text += str(cm);
    out.finish = finishOf(dl.stop_reason);
  }
  return out;
}

function parseBlock(block) {
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;               // keep-alive comment
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length ? data.join('\n') : null;
}

// Yields the data payload of each SSE event. Calls onBytes for every network read (including keep-alives).
export async function* sseEvents(body, { onBytes } = {}) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (onBytes) onBytes(value.length);
      buf += dec.decode(value, { stream: true });
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const ev = parseBlock(block);
        if (ev !== null) yield ev;
      }
    }
    buf += dec.decode();
    if (buf.trim()) {
      const ev = parseBlock(buf);
      if (ev !== null) yield ev;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

const errMsg = (e) => (typeof e === 'string' ? e : (e && e.message) || JSON.stringify(e));

// POST `payload` and read the streamed reply. Aborts if no bytes arrive for `stallMs` (0 = never).
// Returns { text, reasoningChars, finish }.
export async function streamChat({ url, headers, payload, signal, stallMs = 120000, onProgress, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const ctl = new AbortController();
  let stalled = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    if (stallMs > 0) timer = setTimeout(() => { stalled = true; ctl.abort(); }, stallMs);
  };
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let text = '';
  let reasoning = 0;
  let finish = null;
  try {
    arm();
    const res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctl.signal });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new StreamError(`HTTP ${res.status}: ${t.slice(0, 300)}`, { status: res.status });
    }
    arm();

    // Some servers ignore `stream: true` and answer with one JSON document.
    const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (/application\/json/i.test(ct)) {
      const obj = await res.json();
      if (obj && obj.error) throw new StreamError(`Provider error: ${errMsg(obj.error)}`, { provider: true });
      const d = extractDelta(obj);
      if (onProgress) onProgress({ chars: d.text.length, reasoningChars: d.reasoning.length });
      return { text: d.text, reasoningChars: d.reasoning.length, finish: d.finish };
    }
    if (!res.body) throw new StreamError('The response had no body to stream.');

    for await (const data of sseEvents(res.body, { onBytes: arm })) {
      if (data === '[DONE]') break;
      let obj;
      try { obj = JSON.parse(data); } catch { continue; }
      if (obj && obj.error) throw new StreamError(`Provider error: ${errMsg(obj.error)}`, { provider: true });
      const d = extractDelta(obj);
      text += d.text;
      reasoning += d.reasoning.length;
      if (d.finish) finish = d.finish;
      if (onProgress) onProgress({ chars: text.length, reasoningChars: reasoning });
    }
    return { text, reasoningChars: reasoning, finish };
  } catch (e) {
    if (stalled) {
      throw new StreamError(`No data from the API for ${Math.round(stallMs / 1000)}s (stalled).`, { stalled: true, partial: text });
    }
    if (signal && signal.aborted) {
      const err = new Error('Stopped');
      err.name = 'AbortError';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
