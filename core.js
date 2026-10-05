// Pure logic: no SillyTavern or DOM dependencies, so it can be tested in Node.

const STOP = new Set(('the and for that this with from have was were are but not you your she her his him they them their ' +
  'what when where which who how into over then than just like out about would could should there here been being had has did ' +
  'does done say said can will its our all any one too very more some also back only even still').split(' '));

export const norm = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const tokens = (s) => norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function emptyGraph() {
  return { nodes: [], edges: [], lastIndex: 0 };
}

export function ensureShape(g) {
  if (!Array.isArray(g.nodes)) g.nodes = [];
  if (!Array.isArray(g.edges)) g.edges = [];
  if (typeof g.lastIndex !== 'number') g.lastIndex = 0;
  return g;
}

// Comparison key: lowercase, no leading article, no "(parenthetical)", no trailing possessive.
export function nameKey(s) {
  const k = norm(String(s || '').replace(/\([^)]*\)/g, ' '))
    .replace(/^(?:the|a|an)\s+/, '')
    .replace(/'s$/, '')
    .replace(/s'$/, 's')
    .trim();
  return k || norm(s);
}
const parenOf = (s) => norm((String(s || '').match(/\(([^)]*)\)/) || [])[1] || '');
// Same key, and parentheticals do not contradict each other ("Bar (Mondstadt)" vs "Bar (Liyue)" stay distinct).
const sameName = (a, b) => {
  const ka = nameKey(a);
  if (!ka || ka !== nameKey(b)) return false;
  const pa = parenOf(a), pb = parenOf(b);
  return !pa || !pb || pa === pb;
};

export function findNode(g, name) {
  const n = norm(name);
  if (!n) return undefined;
  const exact = g.nodes.find((x) => norm(x.name) === n || (x.aliases || []).some((a) => norm(a) === n));
  if (exact) return exact;
  // Fuzzy stage: only accept an unambiguous match. Two candidates means we cannot tell, so treat it as new.
  const cands = g.nodes.filter((x) => sameName(x.name, name) || (x.aliases || []).some((a) => sameName(a, name)));
  return cands.length === 1 ? cands[0] : undefined;
}

function uniqAliases(arr, selfName) {
  const seen = new Set([norm(selfName)]);
  const out = [];
  for (const a of arr) {
    const k = norm(a);
    if (k && !seen.has(k)) { seen.add(k); out.push(String(a).trim()); }
  }
  return out;
}

function newId(g, name) {
  const base = norm(name).replace(/\s+/g, '-').slice(0, 24) || 'node';
  let id = base, i = 2;
  while (g.nodes.some((n) => n.id === id)) id = `${base}-${i++}`;
  return id;
}

function ensureNode(g, name, now) {
  let n = findNode(g, name);
  if (!n) {
    n = { id: newId(g, name), name: String(name).trim(), type: 'thing', aliases: [], text: '', createdAt: now, updatedAt: now };
    g.nodes.push(n);
  }
  return n;
}

// Pull the first JSON object out of a model reply (handles code fences, chatter, trailing commas).
// Close a reply that was cut off mid-JSON: drop the unfinished tail, close open brackets.
function repairTruncated(t) {
  const stack = [];
  let inStr = false, esc = false, lastGood = -1, goodStack = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length >= 1) { lastGood = i; goodStack = [...stack]; }
    }
  }
  if (lastGood < 0) return null;
  const closers = goodStack.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
  return t.slice(0, lastGood + 1).replace(/,\s*$/, '') + closers;
}

export function extractJson(text, info = {}) {
  if (!text) return null;
  let t = String(text)
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{');
  if (a < 0) return null;
  t = t.slice(a);
  const b = t.lastIndexOf('}');
  const whole = b > 0 ? t.slice(0, b + 1) : t;
  try { return JSON.parse(whole); } catch { /* try repairs */ }
  try { return JSON.parse(whole.replace(/,\s*([}\]])/g, '$1')); } catch { /* truncated? */ }
  const fixed = repairTruncated(t);
  if (fixed) {
    try {
      const v = JSON.parse(fixed.replace(/,\s*([}\]])/g, '$1'));
      info.repaired = true;   // reply was cut off; only the complete entries were recovered
      return v;
    } catch { /* give up */ }
  }
  return null;
}

export function mergeUpdate(g, upd, now = Date.now()) {
  ensureShape(g);
  const stats = { added: 0, updated: 0, edges: 0 };
  const nodes = Array.isArray(upd?.nodes) ? upd.nodes : [];
  for (const n of nodes) {
    if (!n || typeof n.name !== 'string' || !n.name.trim()) continue;
    const aliases = (Array.isArray(n.aliases) ? n.aliases : []).filter((a) => typeof a === 'string');
    const ex = findNode(g, n.name);
    if (ex) {
      if (typeof n.text === 'string' && n.text.trim()) ex.text = n.text.trim();
      if (n.type) ex.type = String(n.type);
      ex.aliases = uniqAliases([...(ex.aliases || []), ...aliases, n.name], ex.name);
      ex.updatedAt = now;
      stats.updated++;
    } else {
      g.nodes.push({
        id: newId(g, n.name), name: n.name.trim(), type: String(n.type || 'thing'),
        aliases: uniqAliases(aliases, n.name), text: String(n.text || '').trim(), createdAt: now, updatedAt: now,
      });
      stats.added++;
    }
  }
  const edges = Array.isArray(upd?.edges) ? upd.edges : [];
  for (const e of edges) {
    if (!e || !e.from || !e.to || !e.relation) continue;
    const a = ensureNode(g, e.from, now);
    const b = ensureNode(g, e.to, now);
    if (a === b) continue;
    if (e.replace) {
      g.edges = g.edges.filter((x) => !((x.from === a.id && x.to === b.id) || (x.from === b.id && x.to === a.id)));
    }
    const rel = String(e.relation).trim();
    const dup = g.edges.find((x) => x.from === a.id && x.to === b.id && norm(x.relation) === norm(rel));
    if (dup) dup.updatedAt = now;
    else g.edges.push({ from: a.id, to: b.id, relation: rel, updatedAt: now });
    stats.edges++;
  }
  return stats;
}

export function cosine(a, b) {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? d / Math.sqrt(x * y) : 0;
}

function lexScore(n, qn, qt) {
  const names = [n.name, ...(n.aliases || [])];
  const nameHit = names.some((x) => [norm(x), nameKey(x)].some((xn) =>
    xn.length >= 3 && new RegExp(`(^|\\s)${esc(xn)}(?:s|es)?(?=\\s|$)`).test(qn)));
  const nt = new Set(tokens(`${n.name} ${n.text}`));
  let inter = 0;
  for (const w of qt) if (nt.has(w)) inter++;
  const overlap = qt.size && nt.size ? inter / Math.sqrt(qt.size * nt.size) : 0;
  return clamp((nameHit ? 0.8 : 0) + overlap * 2, 0, 1);
}

// Hybrid retrieval: name/alias/keyword score, optionally blended with embedding similarity.
export function retrieve(g, { query, topK = 5, threshold = 0.3, qVec = null, nodeVecs = null, vecFloor = 0.35, maxEdges = 12 }) {
  const qn = norm(query);
  const qt = new Set(tokens(query));
  const scored = [];
  for (const n of g.nodes) {
    const lex = lexScore(n, qn, qt);
    let v = 0;
    const nv = nodeVecs && nodeVecs.get(n.id);
    if (qVec && nv) v = clamp((cosine(qVec, nv) - vecFloor) / (1 - vecFloor), 0, 1);
    const score = Math.max(lex, v) + 0.1 * Math.min(lex, v);
    if (score >= threshold) scored.push({ node: n, score, lex, vec: v });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, topK);
  const ids = new Set(picked.map((p) => p.node.id));
  const rel = g.edges.filter((e) => ids.has(e.from) || ids.has(e.to));
  rel.sort((a, b) => (ids.has(b.from) && ids.has(b.to)) - (ids.has(a.from) && ids.has(a.to)));
  return { picked, edges: rel.slice(0, maxEdges) };
}

export function formatBlock(g, res) {
  if (!res.picked.length) return '';
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const lines = ['[Story memory: established facts relevant to this scene]'];
  for (const { node } of res.picked) {
    lines.push(`- ${node.name} (${node.type}): ${node.text || '(no details yet)'}`);
  }
  if (res.edges.length) {
    lines.push('Relationships:');
    for (const e of res.edges) lines.push(`- ${byId.get(e.from)?.name} -> ${byId.get(e.to)?.name}: ${e.relation}`);
  }
  return lines.join('\n');
}

// Nodes whose name or alias appears in the text, most-mentioned first.
export function relevantNodes(g, text, max = 14) {
  const qn = norm(text);
  const out = [];
  for (const n of g.nodes) {
    let hits = 0;
    const pats = new Set();
    for (const nm of [n.name, ...(n.aliases || [])]) {
      for (const k of [norm(nm), nameKey(nm)]) if (k.length >= 3) pats.add(k);
    }
    for (const k of pats) {
      const m = qn.match(new RegExp(`(^|\\s)${esc(k)}(?:s|es)?(?=\\s|$)`, 'g'));
      if (m) hits += m.length;
    }
    if (hits) out.push({ n, hits });
  }
  out.sort((a, b) => b.hits - a.hits);
  return out.slice(0, max).map((x) => x.n);
}

// Split [{idx, line}] into parts of at most `limit` characters. A single huge message gets its own part.
export function chunkItems(items, limit) {
  const chunks = [];
  let cur = [], len = 0;
  for (const it of items) {
    const l = it.line.length + 2;
    if (cur.length && len + l > limit) { chunks.push(cur); cur = []; len = 0; }
    cur.push(it); len += l;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function buildExtractionPrompt(g, transcript, userName, charName) {
  const rel = relevantNodes(g, transcript, 14);
  const relIds = new Set(rel.map((n) => n.id));
  const others = g.nodes
    .filter((n) => !relIds.has(n.id))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 400);
  const full = rel.length
    ? rel.map((n) => `- ${n.name} (${n.type})${n.aliases && n.aliases.length ? ` [aliases: ${n.aliases.join(', ')}]` : ''}: ${n.text || '(no details yet)'}`).join('\n')
    : '(none)';
  const known = others.length ? others.map((n) => `${n.name} (${n.type})`).join('; ') : '(none)';
  const system =
    'You maintain a knowledge graph for a long-running roleplay. Read the new transcript and output ONLY a JSON object, no commentary. Do not deliberate at length: this is extraction, not analysis.';
  const prompt = `Update the story knowledge graph using the NEW TRANSCRIPT below.

Main participants: ${userName || 'User'} and ${charName || 'Character'}.

NODES ALREADY IN THE GRAPH THAT APPEAR IN THIS TRANSCRIPT (current full text):
${full}

OTHER NODES ALREADY IN THE GRAPH (names only):
${known}

RULES
- Nodes are named entities worth remembering: characters, places, objects, factions, events, promises, secrets, open plot threads.
- If an entity is already in the graph (under any name or alias), use its EXACT existing name. Never create a second node for the same thing. Put new nicknames in "aliases".
- "text" must be a self-contained 1-3 sentence description that makes sense without the transcript (who/what/where/when, why it matters, current state). When updating an existing node, return its FULL revised text: keep the still-true facts from the current text and add or change what happened.
- Edges link two nodes. "relation" is a short phrase (e.g. "gave a flower to", "distrusts", "located in"). Set "replace": true on an edge when the relationship between that pair has changed and old edges between them are now outdated.
- Only include nodes that are new or changed. Skip trivia. Do not invent facts.

OUTPUT FORMAT
{"nodes":[{"name":"","type":"character|place|object|faction|event|thread","aliases":[],"text":""}],"edges":[{"from":"","to":"","relation":"","replace":false}]}

NEW TRANSCRIPT
${transcript}`;
  return { system, prompt };
}

// Simple Fruchterman-Reingold layout for the viewer.
export function layout(nodes, edges, w = 640, h = 420, iters = 250) {
  const pos = new Map();
  const n = nodes.length;
  nodes.forEach((nd, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, n);
    pos.set(nd.id, { x: w / 2 + Math.cos(a) * w / 3, y: h / 2 + Math.sin(a) * h / 3, dx: 0, dy: 0 });
  });
  if (n < 2) return pos;
  const k = Math.sqrt((w * h) / n) * 0.8;
  const arr = nodes.map((nd) => pos.get(nd.id));
  for (let it = 0; it < iters; it++) {
    const t = (1 - it / iters) * (w / 10);
    arr.forEach((p) => { p.dx = 0; p.dy = 0; });
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = arr[i].x - arr[j].x, dy = arr[i].y - arr[j].y;
        const d = Math.max(0.01, Math.hypot(dx, dy));
        const f = (k * k) / d;
        dx /= d; dy /= d;
        arr[i].dx += dx * f; arr[i].dy += dy * f;
        arr[j].dx -= dx * f; arr[j].dy -= dy * f;
      }
    }
    for (const e of edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      let dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = (d * d) / k;
      dx /= d; dy /= d;
      a.dx -= dx * f; a.dy -= dy * f;
      b.dx += dx * f; b.dy += dy * f;
    }
    for (const p of arr) {
      p.dx += (w / 2 - p.x) * 0.02; p.dy += (h / 2 - p.y) * 0.02;
      const d = Math.max(0.01, Math.hypot(p.dx, p.dy));
      p.x = clamp(p.x + (p.dx / d) * Math.min(d, t), 40, w - 40);
      p.y = clamp(p.y + (p.dy / d) * Math.min(d, t), 30, h - 30);
    }
  }
  return pos;
}

// Better layout for the viewer. Nodes that already have x/y keep them (when keep=true),
// so manual arrangement survives and new nodes settle around the old ones.
export function layoutGraph(nodes, edges, { iters, keep = true } = {}) {
  const n = nodes.length;
  if (!n) return;
  const size = Math.max(700, Math.sqrt(n) * 260);
  const k = Math.sqrt((size * size) / n) * 0.9;
  const steps = iters || (n > 300 ? 120 : 300);
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  const P = nodes.map((nd, i) => {
    if (keep && Number.isFinite(nd.x) && Number.isFinite(nd.y)) return { x: nd.x, y: nd.y, fixed: true, dx: 0, dy: 0 };
    const a = i * 2.399963;
    const r = k * 0.6 * Math.sqrt(i + 1);
    return { x: size / 2 + Math.cos(a) * r, y: size / 2 + Math.sin(a) * r, fixed: false, dx: 0, dy: 0 };
  });
  if (P.every((p) => p.fixed)) return;
  const E = edges
    .map((e) => [idx.get(e.from), idx.get(e.to)])
    .filter(([a, b]) => a !== undefined && b !== undefined && a !== b);
  for (let it = 0; it < steps; it++) {
    const t = (1 - it / steps) * k * 0.6 + 0.5;
    for (const p of P) { p.dx = 0; p.dy = 0; }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = dx * dx + dy * dy + 0.01; }
        const d = Math.sqrt(d2);
        const f = (k * k) / d;
        dx /= d; dy /= d;
        P[i].dx += dx * f; P[i].dy += dy * f;
        P[j].dx -= dx * f; P[j].dy -= dy * f;
      }
    }
    for (const [a, b] of E) {
      let dx = P[a].x - P[b].x, dy = P[a].y - P[b].y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = (d * d) / k;
      dx /= d; dy /= d;
      P[a].dx -= dx * f; P[a].dy -= dy * f;
      P[b].dx += dx * f; P[b].dy += dy * f;
    }
    for (const p of P) {
      if (p.fixed) continue;
      p.dx += (size / 2 - p.x) * 0.25;
      p.dy += (size / 2 - p.y) * 0.25;
      const d = Math.max(0.01, Math.hypot(p.dx, p.dy));
      const m = Math.min(d, t);
      p.x = clampN(p.x + (p.dx / d) * m, 0, size);   // keep stray nodes inside the box
      p.y = clampN(p.y + (p.dy / d) * m, 0, size);
    }
  }
  nodes.forEach((nd, i) => { nd.x = Math.round(P[i].x); nd.y = Math.round(P[i].y); });
}

function clampN(x, a, b) { return Math.min(b, Math.max(a, x)); }

// Wraps the extraction prompt with the user's preset (system side) and reminder (after the transcript).
export function composeRequest(g, transcript, userName, charName, { preset = '', reminder = '' } = {}) {
  const base = buildExtractionPrompt(g, transcript, userName, charName);
  const system = [String(preset || '').trim(), base.system].filter(Boolean).join('\n\n');
  const rem = String(reminder || '').trim();
  const prompt = rem ? `${base.prompt}\n\n${rem}` : base.prompt;
  return { system, prompt };
}

// Best x for each item in order, at least `gap` apart, as close to its desired x as possible.
function spreadRow(des, gap) {
  const blocks = [];
  des.forEach((d, i) => {
    blocks.push({ sum: d - i * gap, cnt: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sum / a.cnt <= b.sum / b.cnt) break;
      a.sum += b.sum; a.cnt += b.cnt; blocks.pop();
    }
  });
  const xs = [];
  let i = 0;
  for (const b of blocks) {
    const v = b.sum / b.cnt;
    for (let k = 0; k < b.cnt; k++, i++) xs.push(v + i * gap);
  }
  return xs;
}

// Chronological tree: the first node is at the top and every update (summary batch) gets its own rows
// below the previous one, so new nodes always appear lower down. Inside an update, a node sits one row
// under the earlier node it links to, and each row is arranged to stay close to those parents.
export function treeLayout(nodes, edges, { gapX = 170, gapY = 96, batchGap = 56, maxPerRow = 9 } = {}) {
  const pos = new Map();
  const rows = [];
  const batches = [];
  if (!nodes.length) return { pos, rows, batches };

  const order = nodes.map((nd, i) => ({ nd, i }))
    .sort((a, b) => ((a.nd.createdAt || 0) - (b.nd.createdAt || 0)) || (a.i - b.i))
    .map((x) => x.nd);
  const rank = new Map(order.map((nd, i) => [nd.id, i]));
  const adj = new Map(order.map((nd) => [nd.id, []]));
  for (const e of edges) {
    if (e.from !== e.to && adj.has(e.from) && adj.has(e.to)) { adj.get(e.from).push(e.to); adj.get(e.to).push(e.from); }
  }

  const groups = [];
  const batchOf = new Map();
  let lastT;
  for (const nd of order) {
    const t = nd.createdAt || 0;
    if (!groups.length || t !== lastT) { groups.push([]); lastT = t; }
    groups[groups.length - 1].push(nd);
    batchOf.set(nd.id, groups.length - 1);
  }

  const parentOf = (nd) => {
    let best = null;
    for (const id of adj.get(nd.id)) if (rank.get(id) < rank.get(nd.id) && (best === null || rank.get(id) < rank.get(best))) best = id;
    return best;
  };

  let y = 0;
  groups.forEach((members, b) => {
    const depth = new Map();
    let maxD = 0;
    for (const nd of members) {
      const p = parentOf(nd);
      const d = p !== null && batchOf.get(p) === b ? depth.get(p) + 1 : 0;
      depth.set(nd.id, d);
      if (d > maxD) maxD = d;
    }
    let top = null, bottom = null;
    for (let d = 0; d <= maxD; d++) {
      const level = members.filter((nd) => depth.get(nd.id) === d);
      if (!level.length) continue;
      const want = level.map((nd) => {
        const xs = adj.get(nd.id).filter((id) => pos.has(id)).map((id) => pos.get(id).x);
        return { nd, x: xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null };
      });
      const known = want.filter((w) => w.x !== null).map((w) => w.x);
      const fill = known.length ? known.reduce((s, v) => s + v, 0) / known.length : 0;
      want.forEach((w) => { if (w.x === null) w.x = fill; });
      want.sort((a, c) => a.x - c.x);
      // too many for one row: deal them out round-robin so every row spans the same width
      const nRows = Math.ceil(want.length / maxPerRow);
      const lanes = Array.from({ length: nRows }, () => []);
      want.forEach((w, i) => lanes[i % nRows].push(w));
      for (const lane of lanes) {
        if (rows.length) y += (top === null && bottom === null ? batchGap : 0) + gapY;
        else y = 0;
        const xs = spreadRow(lane.map((w) => w.x), gapX);
        lane.forEach((w, i) => pos.set(w.nd.id, { x: Math.round(xs[i]), y }));
        rows.push({ y, batch: b });
        if (top === null) top = y;
        bottom = y;
      }
    }
    batches.push({ index: b, top, bottom, count: members.length, createdAt: members[0].createdAt || 0 });
  });
  return { pos, rows, batches };
}
