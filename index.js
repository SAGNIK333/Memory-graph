import { emptyGraph, ensureShape, extractJson, mergeUpdate, retrieve, formatBlock, buildExtractionPrompt } from './core.js';
import { openViewer } from './viewer.js';

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
  maxTokens: 4000,
  chunkChars: 12000,
};

let busy = false;
let lastInjected = '';
let lastRaw = '';
const vecCache = new Map();

const ctxNow = () => SillyTavern.getContext();

function S() {
  const st = ctxNow().extensionSettings;
  if (!st[MODULE]) st[MODULE] = {};
  for (const k in DEFAULTS) if (st[MODULE][k] === undefined) st[MODULE][k] = DEFAULTS[k];
  return st[MODULE];
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
    const block = formatBlock(g, res);
    lastInjected = block;
    ctx.setExtensionPrompt(KEY, block, 1, s.depth, false, 0);
    $('#rpg_inject').val(block);
  } catch (e) {
    console.error('[RP Memory Graph] intercept error', e);
  }
};

// ---------- summarize chat into graph updates ----------
async function callLLM(system, prompt) {
  const s = S();
  // positional signature is accepted by all SillyTavern versions
  return await ctxNow().generateRaw(prompt, null, false, false, system, s.maxTokens);
}

function chunkTranscript(msgs, limit) {
  const chunks = [];
  let cur = '';
  for (const line of msgs) {
    if (cur.length + line.length > limit && cur) { chunks.push(cur); cur = ''; }
    cur += line + '\n\n';
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

async function summarize(rebuild = false) {
  if (busy) return toastr.info('Memory graph is already updating.');
  const ctx = ctxNow();
  const s = S();
  const g = G();
  if (rebuild && !confirm('Rebuild the graph from the whole chat? This discards the current graph, including manual edits.')) return;
  busy = true;
  setStatus('Updating graph…');
  try {
    if (rebuild) { g.nodes = []; g.edges = []; g.lastIndex = 0; }
    const start = Math.min(g.lastIndex, ctx.chat.length);
    const msgs = ctx.chat.slice(start)
      .filter((m) => !m.is_system && m.mes)
      .map((m) => `${m.is_user ? (ctx.name1 || 'User') : (m.name || ctx.name2 || 'Character')}: ${m.mes}`);
    if (!msgs.length) { toastr.info('No new messages to summarize.'); return; }
    const chunks = chunkTranscript(msgs, s.chunkChars);
    let total = { added: 0, updated: 0, edges: 0 };
    for (let i = 0; i < chunks.length; i++) {
      setStatus(`Updating graph… part ${i + 1}/${chunks.length}`);
      const { system, prompt } = buildExtractionPrompt(g, chunks[i], ctx.name1, ctx.name2);
      let reply = await callLLM(system, prompt);
      let json = extractJson(reply);
      if (!json) {
        // one retry with a stricter instruction
        reply = await callLLM(system, prompt + '\n\nIMPORTANT: respond with the JSON object only. No thinking, no explanation, no code fences.');
        json = extractJson(reply);
      }
      lastRaw = String(reply ?? '');
      $('#rpg_raw').val(lastRaw);
      console.log('[RP Memory Graph] raw model reply:', reply);
      if (!json) {
        const preview = lastRaw.trim().slice(0, 160) || '(empty reply)';
        throw new Error(`Model did not return usable JSON. Reply started with: ${preview}`);
      }
      const st = mergeUpdate(g, json);
      if (!st.added && !st.updated && !st.edges) {
        toastr.warning('Model returned valid JSON but no new nodes or edges for this part.', 'RP Memory Graph');
      }
      total.added += st.added; total.updated += st.updated; total.edges += st.edges;
    }
    g.lastIndex = ctx.chat.length;
    saveGraph();
    toastr.success(`Graph updated: +${total.added} nodes, ${total.updated} updated, ${total.edges} edges.`);
  } catch (e) {
    console.error('[RP Memory Graph]', e);
    toastr.error(String(e.message || e), 'RP Memory Graph');
  } finally {
    busy = false;
    refreshUI();
  }
}

function openGraphViewer() {
  openViewer({ getGraph: G, save: saveGraph, onChange: refreshUI });
}

// ---------- settings UI ----------
function setStatus(t) { $('#rpg_status').text(t); }

function refreshUI() {
  try {
    const g = G();
    const pending = Math.max(0, ctxNow().chat.length - g.lastIndex);
    setStatus(`${g.nodes.length} nodes, ${g.edges.length} edges. ${pending} messages not yet summarized.`);
    $('#rpg_inject').val(lastInjected);
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
      <div class="rpg-row"><label>Summary max tokens</label><input type="number" id="rpg_maxTokens" class="text_pole" min="500" max="8000" step="100"></div>
      <div class="rpg-row">
        <div class="menu_button" id="rpg_summarize">Summarize now</div>
        <div class="menu_button" id="rpg_view">View / edit graph</div>
        <div class="menu_button" id="rpg_rebuild">Rebuild from chat</div>
        <div class="menu_button" id="rpg_clear">Clear graph</div>
      </div>
      <div class="rpg-status" id="rpg_status"></div>
      <label>Last injected block</label>
      <textarea id="rpg_inject" class="rpg-inject text_pole" readonly></textarea>
      <label>Last raw model reply (for debugging summaries)</label>
      <textarea id="rpg_raw" class="rpg-inject text_pole" readonly></textarea>
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
  $('#rpg_summarize').on('click', () => summarize(false));
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
  ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, () => {
    const s = S();
    if (!s.enabled || !s.autoEvery || busy) return;
    const g = G();
    if (ctxNow().chat.length - g.lastIndex >= s.autoEvery) setTimeout(() => summarize(false), 500);
    else refreshUI();
  });
});
