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

export function findNode(g, name) {
  const n = norm(name);
  if (!n) return undefined;
  return g.nodes.find((x) => norm(x.name) === n || (x.aliases || []).some((a) => norm(a) === n));
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
export function extractJson(text) {
  if (!text) return null;
  let t = String(text).replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch { /* try repair */ }
  try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
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
      ex.aliases = uniqAliases([...(ex.aliases || []), ...aliases], ex.name);
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
  const nameHit = names.some((x) => {
    const xn = norm(x);
    return xn.length >= 3 && new RegExp(`(^|\\s)${esc(xn)}(?:s|es)?(?=\\s|$)`).test(qn);
  });
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

export function buildExtractionPrompt(g, transcript, userName, charName) {
  const existing = g.nodes.length
    ? g.nodes.map((n) => `- ${n.name} (${n.type}): ${(n.text || '').slice(0, 220)}`).join('\n')
    : '(none yet)';
  const system =
    'You maintain a knowledge graph for a long-running roleplay. Read the new transcript and output ONLY a JSON object, no commentary.';
  const prompt = `Update the story knowledge graph using the NEW TRANSCRIPT below.

Main participants: ${userName || 'User'} and ${charName || 'Character'}.

EXISTING NODES (reuse these exact names when the same entity appears; do not create duplicates):
${existing}

RULES
- Nodes are named entities worth remembering: characters, places, objects, factions, events, promises, secrets, open plot threads.
- "text" must be a self-contained 1-3 sentence description that makes sense without the transcript (who/what/where/when, why it matters, current state). When updating an existing node, return its FULL revised text, merging old facts with new ones.
- "aliases" are other names or nicknames used in the story.
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
