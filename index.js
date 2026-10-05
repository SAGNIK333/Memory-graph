import { emptyGraph, ensureShape, extractJson, mergeUpdate, retrieve, formatBlock, composeRequest, chunkItems } from './core.js';
import { openViewer } from './viewer.js';
import { streamChat } from './llm.js';
import { showPreview } from './preview.js';

const MODULE = 'rp_memory_graph';
const KEY = 'rp_memory_graph_inject';
const DEFAULTS = {
  enabled: true,
  autoEvery: 40,        // auto-summarize after this many new messages (0 = manual only)
  topK: 5,
  threshold: 0.3,
  depth: 4,
  queryMessages: 3,
  useEmbeddings: false,
  embedUrl: 'http://localhost:11434/v1/embeddings',
  embedModel: 'bge-m3',
  embedKey: '',
  vecFloor: 0.35,
  maxTokens: 8000,       // thinking models count their reasoning against this
  chunkChars: 12000,
  stream: true,
  stallSec: 120,
  effort: 'keep',        // keep | low | min
  preset: '',            // extra instructions added to the system prompt of every summary request
  reminder: '',          // optional text placed after the chat history
  reviewFirst: false,    // show the exact request and ask before each summary
  applyRegex: true,      // run SillyTavern's own regex scripts (prompt-only ones too) on messages before summarizing
  cacheMode: true,       // inject at the very end and keep the block stable, so provider prompt caching keeps working
};

let busy = false;
let cancelled = false;
let abortCtl = null;
let lastInjected = '';
let lastRaw = '';
let lastSent = '';
const vecCache = new Map();

const ctxNow = () => SillyTavern.getContext();

// SillyTavern's regex engine (the Regex extension). Not part of getContext(), so it is imported on demand.
let rx = null;
async function ensureRegex() {
  if (rx || !S().applyRegex) return;
  try {
    rx = await hooks.loadRegex();
  } catch (e) {
    console.warn('[RP Memory Graph] could not load the SillyTavern regex engine; messages are summarized unfiltered:', e);
  }
}
function regexed(m, depth) {
  const text = String(m.mes || '');
  if (!rx || !S().applyRegex || typeof rx.getRegexedString !== 'function') return text;
  try {
    const place = m.is_user ? rx.regex_placement.USER_INPUT : rx.regex_placement.AI_OUTPUT;
    return rx.getRegexedString(text, place, { isPrompt: true, depth });
  } catch (e) {
    console.warn('[RP Memory Graph] regex failed on a message:', e);
    return text;
  }
}

function S() {
  const st = ctxNow().extensionSettings;
  if (!st[MODULE]) st[MODULE] = {};
  const cfg = st[MODULE];
  for (const k in DEFAULTS) if (cfg[k] === undefined) cfg[k] = DEFAULTS[k];
  if ((cfg.v || 1) < 2) { cfg.maxTokens = Math.max(Number(cfg.maxTokens) || 0, 8000); cfg.v = 2; }
  return cfg;
}

function G() {
  const ctx = ctxNow();
  if (!ctx.chatMetadata[MODULE]) ctx.chatMetadata[MODULE] = emptyGraph();
  return ensureShape(ctx.chatMetadata[MODULE]);
}

const saveSettings = () => ctxNow().saveSettingsDebounced();
const saveGraph = () => ctxNow().saveMetadata();
const nodeText = (n) => `${n.name}. ${n.text}`;

// ---------- embeddings (optional, any OpenAI-compatible or Ollama endpoint) ----------
async function embed(texts) {
  const s = S();
  const need = [...new Set(texts)].filter((t) => !vecCache.has(t));
  if (need.length) {
    const headers = { 'Content-Type': 'application/json' };
    if (s.embedKey) headers.Authorization = `Bearer ${s.embedKey}`;
    const res = await fetch(s.embedUrl, { method: 'POST', headers, body: JSON.stringify({ model: s.embedModel, input: need }) });
    if (!res.ok) throw new Error(`Embedding HTTP ${res.status}`);
    const j = await res.json();
    const arr = j.data ? j.data.map((d) => d.embedding) : j.embeddings;
    if (!arr || arr.length !== need.length) throw new Error('Unexpected embedding response');
    need.forEach((t, i) => vecCache.set(t, arr[i]));
  }
  return texts.map((t) => vecCache.get(t));
}

// ---------- retrieval + injection (runs before every generation) ----------
// Cache-friendly block: the same text is reused for as long as the newly relevant nodes were already in it.
// A provider's prompt cache only helps while everything before the injected text stays identical.
let stickyIds = null;
function stableBlock(g, res, topK) {
  const want = res.picked.map((p) => p.node.id);
  const have = (stickyIds || []).filter((id) => g.nodes.some((n) => n.id === id));
  let ids;
  if (!want.length) ids = have;                                                      // nothing matched: keep what was there
  else if (want.every((id) => have.includes(id))) ids = have;                        // nothing new: block text stays the same
  else {
    const union = [...have, ...want.filter((id) => !have.includes(id))];
    ids = union.length <= topK + 3 ? union : want;                                   // grow a little, then start over
  }
  stickyIds = ids;
  if (!ids.length) return '';
  const order = new Map(g.nodes.map((n, i) => [n.id, i]));
  ids.sort((a, b) => order.get(a) - order.get(b));                                   // fixed order, not by score
  const idSet = new Set(ids);
  const picked = ids.map((id) => ({ node: g.nodes.find((n) => n.id === id), score: 1 }));
  const edges = g.edges.filter((e) => idSet.has(e.from) || idSet.has(e.to)).slice(0, 12);
  return formatBlock(g, { picked, edges });
}

globalThis.rpGraphIntercept = async function (chat, _contextSize, _abort, type) {
  try {
    const s = S();
    const ctx = ctxNow();
    if (!s.enabled || type === 'quiet') return;
    const g = G();
    if (!g.nodes.length) {
      ctx.setExtensionPrompt(KEY, '', 1, s.depth, false, 0);
      lastInjected = '';
      return;
    }
    const recent = chat.filter((m) => !m.is_system && m.mes).slice(-s.queryMessages);
    const query = recent.map((m) => m.mes).join('\n');
    let qVec = null;
    let nodeVecs = null;
    if (s.useEmbeddings && query.trim()) {
      try {
        const texts = [query, ...g.nodes.map(nodeText)];
        const vecs = await embed(texts);
        qVec = vecs[0];
        nodeVecs = new Map(g.nodes.map((n, i) => [n.id, vecs[i + 1]]));
      } catch (e) {
        console.warn('[RP Memory Graph] embeddings failed, using keyword matching only:', e);
      }
    }
    const res = retrieve(g, { query, topK: s.topK, threshold: s.threshold, qVec, nodeVecs, vecFloor: s.vecFloor });
    let block;
    if (s.cacheMode) {
      block = stableBlock(g, res, s.topK);
    } else {
      stickyIds = null;
      block = formatBlock(g, res);
    }
    lastInjected = block;
    ctx.setExtensionPrompt(KEY, block, 1, s.cacheMode ? 0 : s.depth, false, 0);
    $('#rpg_inject').val(block);
  } catch (e) {
    console.error('[RP Memory Graph] intercept error', e);
  }
};

// ---------- learn the user's connection from SillyTavern's own requests ----------
let template = null;        // the last chat-completion request ST built, minus its messages
let streamBroken = false;   // set if the backend rejected a streaming request

export function captureTemplate(data) {
  try {
    if (!data || typeof data !== 'object' || !data.chat_completion_source) return;
    const { messages, ...rest } = data;
    template = JSON.parse(JSON.stringify(rest));
  } catch { /* ignore */ }
}

function buildStreamPayload(system, prompt, s) {
  const p = { ...template };
  p.type = 'quiet';
  p.messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  p.stream = true;
  for (const k of ['tools', 'tool_choice', 'json_schema', 'logit_bias', 'stop', 'n']) delete p[k];
  if ('max_completion_tokens' in p) p.max_completion_tokens = s.maxTokens;
  else p.max_tokens = s.maxTokens;
  if ('temperature' in p) p.temperature = Number.isFinite(Number(p.temperature)) ? Math.min(Number(p.temperature), 0.4) : 0.3;
  if ('frequency_penalty' in p) p.frequency_penalty = 0;
  if ('presence_penalty' in p) p.presence_penalty = 0;
  if ('enable_web_search' in p) p.enable_web_search = false;
  if ('request_images' in p) p.request_images = false;
  if (s.effort !== 'keep' && p.reasoning_effort !== undefined) p.reasoning_effort = s.effort;
  return p;
}

// ---------- calling the model ----------
const STRICT = '\n\nIMPORTANT: respond with the JSON object only. No thinking out loud, no explanation, no code fences. Keep every node text to at most 3 short sentences.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortError = () => Object.assign(new Error('Stopped'), { name: 'AbortError' });
const isAbort = (e) => Boolean(e) && e.name === 'AbortError';
const kfmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const live = { part: 0, total: 0, tag: '', startedAt: 0, chars: 0, reasoning: 0, attempt: 1 };
function renderLive() {
  const secs = Math.round((Date.now() - live.startedAt) / 1000);
  let t = `Part ${live.part}/${live.total}${live.tag}${live.attempt > 1 ? ' (retry)' : ''}`;
  try { t += ` · ${statusCounts(G(), ctxNow().chat.length)}`; } catch { /* no chat */ }
  if (live.chars || live.reasoning) {
    t += ` · receiving ${kfmt(live.chars)} chars${live.reasoning ? `, thinking ${kfmt(live.reasoning)}` : ''}`;
  } else {
    t += ` · waiting for the API ${secs}s`;
  }
  setStatus(t);
}

async function rawGenerate(system, prompt) {
  const s = S();
  const gr = ctxNow().generateRaw;
  // newer SillyTavern takes an options object, older versions take positional arguments
  if (gr.length === 0) return await gr({ prompt, systemPrompt: system, responseLength: s.maxTokens, trimNames: false });
  return await gr(prompt, null, false, false, system, s.maxTokens);
}

async function callLLM(system, prompt) {
  const s = S();
  const ctx = ctxNow();
  if (s.stream && !streamBroken && template && ctx.mainApi === 'openai') {
    try {
      const r = await streamChat({
        url: '/api/backends/chat-completions/generate',
        headers: ctx.getRequestHeaders(),
        payload: buildStreamPayload(system, prompt, s),
        signal: abortCtl ? abortCtl.signal : undefined,
        stallMs: Math.max(0, Number(s.stallSec) || 0) * 1000,
        onProgress: (p) => { live.chars = p.chars; live.reasoning = p.reasoningChars; },
      });
      return { text: r.text, finish: r.finish, reasoningChars: r.reasoningChars };
    } catch (e) {
      if ([400, 404, 405, 415, 422].includes(e && e.status)) {
        streamBroken = true;
        console.warn('[RP Memory Graph] streaming request was rejected, using standard requests:', e);
        toastr.warning('Streaming was rejected by your API setup, so summaries will use standard requests instead.', 'RP Memory Graph');
      } else {
        throw e;
      }
    }
  }
  const text = await rawGenerate(system, prompt);
  return { text: String(text ?? ''), finish: null, reasoningChars: 0 };
}

// ---------- summarize chat into graph updates ----------
function applyUpdate(g, json, items) {
  const t = Math.max(Date.now(), (g.lastBatchAt || 0) + 1);   // unique per update: the viewer rows nodes by it
  g.lastBatchAt = t;
  const st = mergeUpdate(g, json, t);
  g.lastIndex = Math.max(g.lastIndex, items[items.length - 1].idx + 1);
  saveGraph();   // progress is saved after every part
  return st;
}

async function processItems(items, depth = 0) {
  const ctx = ctxNow();
  const g = G();
  const transcript = items.map((i) => i.line).join('\n\n');
  let lastErr = null;
  let partial = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (cancelled) throw abortError();
    live.attempt = attempt; live.startedAt = Date.now(); live.chars = 0; live.reasoning = 0;
    try {
      const { system, prompt } = composeRequest(g, transcript, ctx.name1, ctx.name2, S());
      const sendPrompt = attempt > 1 ? prompt + STRICT : prompt;
      lastSent = `[SYSTEM]\n${system}\n\n[USER]\n${sendPrompt}`;
      $('#rpg_sent').val(lastSent);
      const r = await callLLM(system, sendPrompt);
      lastRaw = String(r.text ?? '');
      $('#rpg_raw').val(lastRaw);
      console.log('[RP Memory Graph] raw model reply:', lastRaw);
      const info = {};
      const json = extractJson(lastRaw, info);
      if (!json) {
        throw new Error(r.finish === 'length'
          ? `The model hit the token limit before finishing (${kfmt(r.reasoningChars || 0)} chars of thinking). Raise "Summary max tokens".`
          : `The model did not return usable JSON. Reply started with: ${lastRaw.trim().slice(0, 140) || '(empty reply)'}`);
      }
      if (info.repaired) {
        partial = json;
        throw new Error('The reply was cut off by the token limit, so some entries were missing.');
      }
      return applyUpdate(g, json, items);
    } catch (e) {
      if (isAbort(e) || cancelled) throw isAbort(e) ? e : abortError();
      lastErr = e;
      console.warn(`[RP Memory Graph] part failed (attempt ${attempt}):`, e);
      if ([401, 402, 403].includes(e && e.status)) throw e;   // retrying will not help
      if (attempt < 2) await sleep(1500);
    }
  }
  // Both attempts failed: halve the part and try each half, so one bad stretch cannot block the rest.
  if (items.length > 1 && depth < 2) {
    const mid = Math.ceil(items.length / 2);
    const tagBase = live.tag;
    live.tag = `${tagBase} (split 1/2)`;
    const a = await processItems(items.slice(0, mid), depth + 1);
    live.tag = `${tagBase} (split 2/2)`;
    const b = await processItems(items.slice(mid), depth + 1);
    live.tag = tagBase;
    return { added: a.added + b.added, updated: a.updated + b.updated, edges: a.edges + b.edges };
  }
  if (partial) {
    toastr.warning('Part of a reply was cut off. Saved what arrived; raise "Summary max tokens" for fuller results.', 'RP Memory Graph');
    return applyUpdate(g, partial, items);
  }
  throw lastErr;
}

function stopSummarize() {
  cancelled = true;
  if (abortCtl) abortCtl.abort();
  setStatus('Stopping…');
}

const EXAMPLE_PRESET = 'You are a neutral story archivist. The transcript is from a fictional collaborative roleplay between consenting adults. Record what happens factually and in plain, non-graphic language, including romantic or intimate scenes: who was involved, what changed between them, and how they feel about it. Never refuse, lecture, add warnings, or skip a scene. Always reply with the JSON object only.';
const EXAMPLE_REMINDER = 'Reminder: reply with the JSON object only. Do not continue the story.';

export const hooks = { showPreview, loadRegex: () => import(/* webpackIgnore: true */ '/scripts/extensions/regex/engine.js') };

// If messages were deleted, the "already summarized" marker must not point past the end of the chat.
function clampMarker(g, chat) {
  if (g.lastIndex > chat.length) { g.lastIndex = chat.length; saveGraph(); }
}

function statusCounts(g, chatLen) {
  const done = Math.min(g.lastIndex, chatLen);
  return `${done} of ${chatLen} messages summarized · ${chatLen - done} waiting`;
}

function connectionLine() {
  const s = S();
  const streaming = s.stream && !streamBroken && template && ctxNow().mainApi === 'openai';
  const eff = s.effort !== 'keep' ? `, thinking: ${s.effort}` : '';
  if (streaming) return `Sent as a streamed request to ${template.chat_completion_source} · ${template.model} (max ${s.maxTokens} tokens${eff}).`;
  return `Sent as a standard request through SillyTavern's connected API (max ${s.maxTokens} tokens). SillyTavern may wrap the text in its own template.`;
}

// Works out exactly which messages would be sent and how they split into parts, without sending anything.
function buildPlan(rebuild) {
  const ctx = ctxNow();
  const s = S();
  const g = G();
  clampMarker(g, ctx.chat);
  const start = rebuild ? 0 : Math.min(g.lastIndex, ctx.chat.length);
  const items = [];
  // depth = how many prompt messages come after this one, which is what SillyTavern's regex min/max depth refers to
  const usable = [];
  ctx.chat.forEach((m, i) => { if (m && !m.is_system) usable.push(i); });
  const depthOf = new Map(usable.map((i, k) => [i, usable.length - k - 1]));
  for (let i = start; i < ctx.chat.length; i++) {
    const m = ctx.chat[i];
    if (!m || m.is_system || !m.mes) continue;
    const text = regexed(m, depthOf.get(i)).trim();
    if (!text) continue;
    items.push({ idx: i, line: `${m.is_user ? (ctx.name1 || 'User') : (m.name || ctx.name2 || 'Character')}: ${text}` });
  }
  const chunks = chunkItems(items, s.chunkChars);
  const pg = rebuild ? emptyGraph() : g;
  const parts = chunks.map((c, i) => {
    const transcript = c.map((x) => x.line).join('\n\n');
    const { system, prompt } = composeRequest(pg, transcript, ctx.name1, ctx.name2, s);
    return {
      label: `Part ${i + 1} of ${chunks.length}`, first: c[0].idx + 1, last: c[c.length - 1].idx + 1, count: c.length,
      chars: system.length + prompt.length, system, prompt, messages: c.map((x) => ({ n: x.idx + 1, text: x.line })),
    };
  });
  return { start, items, chunks, parts, chatLen: ctx.chat.length };
}

function describePlan(plan, rebuild) {
  const s = S();
  const first = plan.items[0].idx + 1;
  const last = plan.items[plan.items.length - 1].idx + 1;
  return {
    title: rebuild ? 'Rebuild graph: what will be sent' : 'Summarize: what will be sent',
    lines: [
      `${plan.items.length} message${plan.items.length === 1 ? '' : 's'} (chat positions ${first}–${last}) in ${plan.parts.length} part${plan.parts.length === 1 ? '' : 's'} of up to ${s.chunkChars.toLocaleString()} characters.`,
      rebuild ? 'Rebuild: the whole chat is sent and the current graph is cleared first.'
        : plan.start > 0 ? `Messages 1–${plan.start} are already summarized and are NOT sent.` : 'Nothing has been summarized yet, so the whole chat is sent.',
      connectionLine(),
    ],
    note: plan.parts.length > 1 ? 'Later parts are shown with the graph as it is now; their node list will also include whatever the earlier parts add.' : '',
    parts: plan.parts,
  };
}

export async function previewNext() {
  if (busy) return toastr.info('Memory graph is busy.');
  await ensureRegex();
  const plan = buildPlan(false);
  if (!plan.items.length) return toastr.info('Nothing new to summarize yet.', 'RP Memory Graph');
  await hooks.showPreview(describePlan(plan, false), { confirm: false });
}

async function summarize(rebuild = false) {
  if (busy) return toastr.info('Memory graph is already updating.');
  const ctx = ctxNow();
  const s = S();
  const g = G();
  if (rebuild && !confirm('Rebuild the graph from the whole chat? This discards the current graph, including manual edits.')) return;
  busy = true;
  cancelled = false;
  abortCtl = new AbortController();
  const tot = { added: 0, updated: 0, edges: 0 };
  Object.assign(live, { part: 0, total: 0, tag: '', startedAt: Date.now(), chars: 0, reasoning: 0, attempt: 1 });
  setStatus('Preparing…');
  let ticker = null;
  try {
    await ensureRegex();
    const plan = buildPlan(rebuild);
    if (!plan.items.length) {
      if (rebuild) { g.nodes = []; g.edges = []; }
      g.lastIndex = ctx.chat.length;
      saveGraph();
      toastr.info('No new messages to summarize.');
      return;
    }
    if (s.reviewFirst) {
      const ok = await hooks.showPreview(describePlan(plan, rebuild), { confirm: true });
      if (!ok) { toastr.info('Cancelled. Nothing was sent.', 'RP Memory Graph'); return; }
    }
    if (rebuild) { g.nodes = []; g.edges = []; g.lastIndex = 0; saveGraph(); }
    $('#rpg_stop').show();
    ticker = setInterval(renderLive, 500);
    live.total = plan.chunks.length;
    for (let i = 0; i < plan.chunks.length; i++) {
      live.part = i + 1;
      live.tag = '';
      const st = await processItems(plan.chunks[i], 0);
      tot.added += st.added; tot.updated += st.updated; tot.edges += st.edges;
    }
    toastr.success(`Graph updated: +${tot.added} nodes, ${tot.updated} updated, ${tot.edges} edges.`);
  } catch (e) {
    if (isAbort(e) || cancelled) {
      toastr.info('Stopped. Everything finished so far is saved; press "Summarize now" to continue.', 'RP Memory Graph');
    } else {
      console.error('[RP Memory Graph]', e);
      toastr.error(`${String(e && e.message || e)}\nParts finished so far are saved. Press "Summarize now" to resume from there.`, 'RP Memory Graph', { timeOut: 15000 });
    }
  } finally {
    if (ticker) clearInterval(ticker);
    busy = false;
    abortCtl = null;
    $('#rpg_stop').hide();
    refreshUI();
  }
}

export { summarize, stopSummarize };

function openGraphViewer() {
  openViewer({ getGraph: G, save: saveGraph, onChange: refreshUI });
}

// ---------- settings UI ----------
function setStatus(t) { $('#rpg_status').text(t); }

export function refreshUI() {
  try {
    $('#rpg_inject').val(lastInjected);
    if (busy) return;
    const g = G();
    const s = S();
    const chat = ctxNow().chat;
    clampMarker(g, chat);
    const sm = !s.stream || streamBroken ? 'streaming off'
      : template ? 'streaming ready'
        : 'streaming starts after your next chat message';
    setStatus(`${statusCounts(g, chat.length)} · ${g.nodes.length} nodes, ${g.edges.length} links (${sm})`);
  } catch { /* no chat loaded yet */ }
}

function bind(id, key, kind) {
  const $el = $(`#${id}`);
  const s = S();
  if (kind === 'check') $el.prop('checked', s[key]); else $el.val(s[key]);
  $el.on('input change', () => {
    s[key] = kind === 'check' ? $el.prop('checked') : kind === 'num' ? Number($el.val()) : $el.val();
    saveSettings();
  });
}

function mountUI() {
  const html = `
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header"><b>RP Memory Graph</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content">
      <div class="rpg-row"><label class="checkbox_label"><input type="checkbox" id="rpg_enabled"> Enable memory injection</label></div>
      <div class="rpg-row"><label>Auto-summarize every N messages (0 = manual)</label><input type="number" id="rpg_autoEvery" class="text_pole" min="0"></div>
      <div class="rpg-row"><label>Max nodes injected</label><input type="number" id="rpg_topK" class="text_pole" min="1" max="20"></div>
      <div class="rpg-row"><label>Match threshold (0-1)</label><input type="number" id="rpg_threshold" class="text_pole" min="0" max="1" step="0.05"></div>
      <div class="rpg-row"><label>Injection depth</label><input type="number" id="rpg_depth" class="text_pole" min="0" max="50"></div>
      <div class="rpg-row"><label>Recent messages used as query</label><input type="number" id="rpg_queryMessages" class="text_pole" min="1" max="10"></div>
      <div class="rpg-row"><label class="checkbox_label"><input type="checkbox" id="rpg_useEmbeddings"> Use embeddings (e.g. BGE-M3)</label></div>
      <div class="rpg-row"><label>Embeddings URL</label><input type="text" id="rpg_embedUrl" class="text_pole"></div>
      <div class="rpg-row"><label>Embeddings model</label><input type="text" id="rpg_embedModel" class="text_pole"></div>
      <div class="rpg-row"><label>API key (optional)</label><input type="password" id="rpg_embedKey" class="text_pole"></div>
      <div class="rpg-row"><label>Summary max tokens (thinking models need a lot)</label><input type="number" id="rpg_maxTokens" class="text_pole" min="500" max="64000" step="500"></div>
      <div class="rpg-row"><label>Characters per summary part</label><input type="number" id="rpg_chunkChars" class="text_pole" min="2000" max="80000" step="1000"></div>
      <div class="rpg-row"><label class="checkbox_label"><input type="checkbox" id="rpg_stream"> Stream summaries (avoids API timeouts)</label></div>
      <div class="rpg-row"><label>Stall timeout, seconds (no data from API)</label><input type="number" id="rpg_stallSec" class="text_pole" min="20" max="900"></div>
      <div class="rpg-row"><label>Thinking effort for summaries</label><select id="rpg_effort" class="text_pole"><option value="keep">Keep my chat setting</option><option value="low">Low</option><option value="min">Minimum</option></select></div>
      <div class="rpg-row"><label class="checkbox_label"><input type="checkbox" id="rpg_applyRegex"> Apply SillyTavern regex scripts to messages before summarizing (strips things like GFX blocks)</label></div>
      <div class="rpg-row"><label class="checkbox_label"><input type="checkbox" id="rpg_cacheMode"> Cache-friendly injection (keeps prompt caching working; injects at the end and keeps the memory text steady)</label></div>
      <div class="rpg-row"><label class="checkbox_label"><input type="checkbox" id="rpg_reviewFirst"> Review what gets sent before each summary</label></div>
      <label>Summary preset (added to the system prompt of every summary request)</label>
      <textarea id="rpg_preset" class="rpg-inject text_pole" placeholder="e.g. instructions that stop the model refusing or censoring romantic scenes while summarizing"></textarea>
      <label>Reminder after the chat history (optional)</label>
      <textarea id="rpg_reminder" class="rpg-inject text_pole" style="min-height:50px"></textarea>
      <div class="rpg-row"><div class="menu_button" id="rpg_example">Insert example preset</div></div>
      <div class="rpg-row">
        <div class="menu_button" id="rpg_summarize">Summarize now</div>
        <div class="menu_button" id="rpg_stop" style="display:none">Stop</div>
        <div class="menu_button" id="rpg_preview">Preview request</div>
        <div class="menu_button" id="rpg_view">View / edit graph</div>
        <div class="menu_button" id="rpg_rebuild">Rebuild from chat</div>
        <div class="menu_button" id="rpg_clear">Clear graph</div>
      </div>
      <div class="rpg-status" id="rpg_status"></div>
      <label>Last injected block</label>
      <textarea id="rpg_inject" class="rpg-inject text_pole" readonly></textarea>
      <label>Last raw model reply (for debugging summaries)</label>
      <textarea id="rpg_raw" class="rpg-inject text_pole" readonly></textarea>
      <label>Last request sent (system + user text)</label>
      <textarea id="rpg_sent" class="rpg-inject text_pole" readonly></textarea>
    </div>
  </div>`;
  $('#extensions_settings2').append($('<div class="rpg-settings"></div>').html(html));
  bind('rpg_enabled', 'enabled', 'check');
  bind('rpg_autoEvery', 'autoEvery', 'num');
  bind('rpg_topK', 'topK', 'num');
  bind('rpg_threshold', 'threshold', 'num');
  bind('rpg_depth', 'depth', 'num');
  bind('rpg_queryMessages', 'queryMessages', 'num');
  bind('rpg_useEmbeddings', 'useEmbeddings', 'check');
  bind('rpg_embedUrl', 'embedUrl');
  bind('rpg_embedModel', 'embedModel');
  bind('rpg_embedKey', 'embedKey');
  bind('rpg_maxTokens', 'maxTokens', 'num');
  bind('rpg_chunkChars', 'chunkChars', 'num');
  bind('rpg_stream', 'stream', 'check');
  bind('rpg_stallSec', 'stallSec', 'num');
  bind('rpg_effort', 'effort');
  bind('rpg_reviewFirst', 'reviewFirst', 'check');
  bind('rpg_applyRegex', 'applyRegex', 'check');
  bind('rpg_cacheMode', 'cacheMode', 'check');
  bind('rpg_preset', 'preset');
  bind('rpg_reminder', 'reminder');
  $('#rpg_summarize').on('click', () => summarize(false));
  $('#rpg_stop').on('click', stopSummarize);
  $('#rpg_preview').on('click', () => previewNext());
  $('#rpg_example').on('click', () => {
    const s = S();
    if (s.preset.trim() && !confirm('Replace your current preset with the example?')) return;
    s.preset = EXAMPLE_PRESET;
    if (!s.reminder.trim()) s.reminder = EXAMPLE_REMINDER;
    $('#rpg_preset').val(s.preset); $('#rpg_reminder').val(s.reminder);
    saveSettings();
  });
  $('#rpg_rebuild').on('click', () => summarize(true));
  $('#rpg_view').on('click', openGraphViewer);
  $('#rpg_clear').on('click', () => {
    if (!confirm('Delete the whole memory graph for this chat?')) return;
    const g = G(); g.nodes = []; g.edges = []; g.lastIndex = 0;
    saveGraph(); refreshUI();
  });
}

jQuery(() => {
  const ctx = ctxNow();
  mountUI();
  refreshUI();
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, refreshUI);
  for (const name of ['MESSAGE_SENT', 'MESSAGE_DELETED']) {
    const ev = ctx.eventTypes[name];
    if (ev) ctx.eventSource.on(ev, () => refreshUI());
  }
  const readyEvent = ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
  if (readyEvent) ctx.eventSource.on(readyEvent, (data) => { captureTemplate(data); if (!busy) refreshUI(); });
  ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, () => {
    const s = S();
    if (!s.enabled || !s.autoEvery || busy) return;
    const g = G();
    if (ctxNow().chat.length - g.lastIndex >= s.autoEvery) setTimeout(() => summarize(false), 500);
    else refreshUI();
  });
});
