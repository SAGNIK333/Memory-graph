import { emptyGraph, extractJson, mergeUpdate, retrieve, formatBlock, buildExtractionPrompt, layout, cosine, norm } from './core.js';
import assert from 'node:assert';
const g = emptyGraph();
const reply = 'Sure!\n```json\n{"nodes":[{"name":"Moonpetal","type":"object","aliases":["the blue flower"],"text":"A pale blue flower Xiaoling gave Rachit at the lake in chapter 3; it blooms only at night."},{"name":"Ning Xiaoling","type":"character","text":"Sect disciple, cautious."}],"edges":[{"from":"Ning Xiaoling","to":"Moonpetal","relation":"gave",},]}\n```';
const j = extractJson(reply);
assert(j, 'json parsed');
let st = mergeUpdate(g, j);
assert.equal(g.nodes.length, 2); assert.equal(g.edges.length, 1);
// update merges, no duplicates, alias resolves
st = mergeUpdate(g, { nodes: [{ name: 'the blue flower', text: 'Moonpetal, now pressed in a book.' }], edges: [{ from: 'Ning Xiaoling', to: 'Moonpetal', relation: 'gave', replace: true }] });
assert.equal(g.nodes.length, 2); assert.match(g.nodes[0].text, /pressed/); assert.equal(g.edges.length, 1);
// stub node from edge
mergeUpdate(g, { edges: [{ from: 'Moonpetal', to: 'Lake', relation: 'found at' }] });
assert.equal(g.nodes.length, 3);
// retrieval by name, alias, plural, keyword
const q = (t) => retrieve(g, { query: t }).picked.map((p) => p.node.name);
assert.deepEqual(q('hey you remember this moonpetal??'), ['Moonpetal']);
assert(q('what about the blue flower?').includes('Moonpetal'));
assert.deepEqual(q('Let us go eat some noodles'), []);
const res = retrieve(g, { query: 'remember the moonpetal?' });
console.log(formatBlock(g, res));
// vector path
const nv = new Map(g.nodes.map((n, i) => [n.id, i === 0 ? [1, 0] : [0, 1]]));
const r2 = retrieve(g, { query: 'zzz', qVec: [0.9, 0.1], nodeVecs: nv, vecFloor: 0.35 });
assert.equal(r2.picked[0].node.id, g.nodes[0].id);
// layout + prompt
const pos = layout(g.nodes, g.edges); assert.equal(pos.size, 3);
for (const p of pos.values()) assert(Number.isFinite(p.x) && Number.isFinite(p.y));
assert(buildExtractionPrompt(g, 'A: hi', 'Rachit', 'Xiaoling').prompt.includes('Moonpetal'));
console.log('ALL OK');
