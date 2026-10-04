// Full-screen graph viewer/editor. Canvas-rendered so it stays smooth with hundreds of nodes.
import { layoutGraph, norm } from './core.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPE_HUE = { character: 38, place: 150, object: 72, faction: 268, event: 335, thread: 205, thing: 220 };
const hue = (t) => {
  const k = String(t || 'thing').toLowerCase();
  if (k in TYPE_HUE) return TYPE_HUE[k];
  let h = 0;
  for (const c of k) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};
const color = (t, l = 62) => `hsl(${hue(t)} 72% ${l}%)`;
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function openViewer({ getGraph, save, onChange }) {
  if (document.querySelector('.rpg-ov')) return;
  const g = getGraph();

  if (g.nodes.some((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y))) {
    layoutGraph(g.nodes, g.edges, { keep: true });
    save();
  }

  let sel = null;               // selected node id
  let matches = null;           // Set of ids matching the search box
  let byId = new Map();
  let deg = new Map();
  let curConns = [];
  const view = { x: 0, y: 0, k: 1 };
  let cssW = 1, cssH = 1, dpr = 1, raf = 0, anim = 0;

  const root = document.createElement('div');
  root.className = 'rpg-ov';
  root.innerHTML = `
    <div class="rpg-top">
      <div class="rpg-title"><b>Memory graph</b><span class="rpg-count"></span></div>
      <input class="rpg-search" type="search" placeholder="Search nodes… (Enter to jump)" autocomplete="off">
      <div class="rpg-tools">
        <button class="rpg-btn" data-a="zoom-out" title="Zoom out">−</button>
        <button class="rpg-btn" data-a="zoom-in" title="Zoom in">+</button>
        <button class="rpg-btn" data-a="fit">Fit</button>
        <button class="rpg-btn" data-a="relayout" title="Recompute the layout">Re-layout</button>
        <button class="rpg-btn" data-a="add">+ Node</button>
        <button class="rpg-btn rpg-close" data-a="close" title="Close">✕</button>
      </div>
    </div>
    <div class="rpg-body">
      <div class="rpg-stage">
        <canvas class="rpg-canvas"></canvas>
        <div class="rpg-legend"></div>
        <div class="rpg-hint">Tap a node to edit · drag to pan · pinch or scroll to zoom</div>
      </div>
      <aside class="rpg-panel" hidden></aside>
    </div>`;
  document.body.appendChild(root);

  const $ = (s) => root.querySelector(s);
  const stage = $('.rpg-stage');
  const canvas = $('.rpg-canvas');
  const ctx = canvas.getContext('2d');
  const panel = $('.rpg-panel');

  // ---------- data helpers ----------
  function reindex() {
    byId = new Map(g.nodes.map((n) => [n.id, n]));
    deg = new Map(g.nodes.map((n) => [n.id, 0]));
    for (const e of g.edges) {
      deg.set(e.from, (deg.get(e.from) || 0) + 1);
      deg.set(e.to, (deg.get(e.to) || 0) + 1);
    }
    $('.rpg-count').textContent = `${g.nodes.length} nodes · ${g.edges.length} links`;
    const counts = new Map();
    for (const n of g.nodes) counts.set(n.type || 'thing', (counts.get(n.type || 'thing') || 0) + 1);
    $('.rpg-legend').innerHTML = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `<span><i style="background:${color(t)}"></i>${esc(t)} ${c}</span>`)
      .join('');
  }
  const radius = (n) => (5 + Math.min(9, (deg.get(n.id) || 0) * 1.1)) * clamp(Math.sqrt(view.k), 0.6, 1.5);
  const sx = (n) => view.x + n.x * view.k;
  const sy = (n) => view.y + n.y * view.k;

  function commit(msg) {
    save();
    onChange && onChange();
    reindex();
    renderPanel();
    requestDraw();
    if (msg) toastr.success(msg, 'RP Memory Graph');
  }

  // ---------- drawing ----------
  function requestDraw() {
    if (!raf) raf = requestAnimationFrame(draw);
  }

  function draw() {
    raf = 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const gs = 32 * view.k;
    stage.style.backgroundSize = `${gs}px ${gs}px`;
    stage.style.backgroundPosition = `${view.x}px ${view.y}px`;

    const sn = sel ? byId.get(sel) : null;
    const nbr = new Set();
    if (sn) {
      nbr.add(sn.id);
      for (const e of g.edges) {
        if (e.from === sn.id) nbr.add(e.to);
        else if (e.to === sn.id) nbr.add(e.from);
      }
    }
    const dim = (id) => (sn && !nbr.has(id)) || (matches && !matches.has(id));
    const M = 40;
    const on = (x, y) => x > -M && y > -M && x < cssW + M && y < cssH + M;

    // edges
    const hotEdges = [];
    for (const e of g.edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const ax = sx(a), ay = sy(a), bx = sx(b), by = sy(b);
      if (!on(ax, ay) && !on(bx, by)) continue;
      const hot = sn && (e.from === sn.id || e.to === sn.id);
      if (hot) { hotEdges.push([e, ax, ay, bx, by]); continue; }
      ctx.strokeStyle = sn || matches ? 'rgba(140,150,185,.10)' : 'rgba(140,150,185,.30)';
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(170,195,255,.95)';
    ctx.lineWidth = 2;
    for (const [, ax, ay, bx, by] of hotEdges) {
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }

    // nodes
    const vis = [];
    for (const n of g.nodes) {
      const x = sx(n), y = sy(n);
      if (!on(x, y)) continue;
      const r = radius(n);
      vis.push({ n, x, y, r });
      ctx.globalAlpha = dim(n.id) ? 0.28 : 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
      ctx.fillStyle = color(n.type);
      ctx.fill();
      if (n.id === sel) { ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; }
      else if (matches && matches.has(n.id)) { ctx.lineWidth = 2.5; ctx.strokeStyle = '#ffd54a'; }
      else { ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,.45)'; }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // labels (greedy, skip overlaps, selected / neighbours / matches always shown)
    ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const prio = (v) => (v.n.id === sel ? 1e6 : 0) + (sn && nbr.has(v.n.id) ? 1e5 : 0) + (matches && matches.has(v.n.id) ? 1e5 : 0) + (deg.get(v.n.id) || 0);
    vis.sort((a, b) => prio(b) - prio(a));
    const placed = [];
    let shown = 0;
    for (const v of vis) {
      const must = prio(v) >= 1e5;
      if (!must && shown > 220) continue;
      const text = trunc(v.n.name, 26);
      const tw = ctx.measureText(text).width;
      const box = { x: v.x - tw / 2 - 3, y: v.y + v.r + 2, w: tw + 6, h: 16 };
      if (!must && placed.some((p) => box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y)) continue;
      placed.push(box); shown++;
      ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(8,10,18,.9)';
      ctx.strokeText(text, v.x, v.y + v.r + 3);
      ctx.fillStyle = dim(v.n.id) ? 'rgba(220,226,245,.4)' : '#eef1ff';
      ctx.fillText(text, v.x, v.y + v.r + 3);
    }

    // relation labels for the selected node's links
    if (hotEdges.length && hotEdges.length <= 16) {
      ctx.font = '500 11px system-ui, sans-serif';
      for (const [e, ax, ay, bx, by] of hotEdges) {
        const text = trunc(e.relation, 32);
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(8,10,18,.92)';
        ctx.strokeText(text, mx, my - 6);
        ctx.fillStyle = '#b9c8ff';
        ctx.fillText(text, mx, my - 6);
      }
    }
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    cssW = Math.max(1, r.width); cssH = Math.max(1, r.height);
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    requestDraw();
  }

  // ---------- camera ----------
  function animateTo(t, ms = 240) {
    cancelAnimationFrame(anim);
    const from = { ...view }, t0 = performance.now();
    const step = (now) => {
      const p = clamp((now - t0) / ms, 0, 1), e = 1 - Math.pow(1 - p, 3);
      view.x = from.x + (t.x - from.x) * e;
      view.y = from.y + (t.y - from.y) * e;
      view.k = from.k + (t.k - from.k) * e;
      requestDraw();
      if (p < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  function fit(animate = true) {
    if (!g.nodes.length) { Object.assign(view, { x: cssW / 2, y: cssH / 2, k: 1 }); requestDraw(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of g.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const pad = 70, bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
    const k = clamp(Math.min((cssW - pad * 2) / bw, (cssH - pad * 2) / bh), 0.1, 1.4);
    const t = { k, x: cssW / 2 - ((x0 + x1) / 2) * k, y: cssH / 2 - ((y0 + y1) / 2) * k };
    if (animate) animateTo(t); else { Object.assign(view, t); requestDraw(); }
  }

  function zoomAt(px, py, f) {
    const k = clamp(view.k * f, 0.08, 4);
    const wx = (px - view.x) / view.k, wy = (py - view.y) / view.k;
    view.k = k; view.x = px - wx * k; view.y = py - wy * k;
    requestDraw();
  }

  function focusNode(n, k = Math.max(view.k, 1)) {
    animateTo({ k, x: cssW / 2 - n.x * k, y: cssH / 2 - n.y * k });
  }

  // ---------- pointer interaction ----------
  function hit(px, py) {
    for (let i = g.nodes.length - 1; i >= 0; i--) {
      const n = g.nodes[i];
      const r = Math.max(radius(n) + 4, 16);
      const dx = sx(n) - px, dy = sy(n) - py;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }

  const ptrs = new Map();
  let drag = null, pinch = null;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const [px, py] = local(e);
    ptrs.set(e.pointerId, [px, py]);
    cancelAnimationFrame(anim);
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
      drag = null;
    } else {
      drag = { node: hit(px, py), sx: px, sy: py, lx: px, ly: py, moved: false };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const [px, py] = local(e);
    if (!ptrs.has(e.pointerId)) {
      canvas.style.cursor = hit(px, py) ? 'pointer' : 'grab';
      return;
    }
    ptrs.set(e.pointerId, [px, py]);
    if (pinch && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      view.x += mx - pinch.mx; view.y += my - pinch.my;
      if (pinch.d > 0) zoomAt(mx, my, d / pinch.d);
      pinch = { d, mx, my };
      requestDraw();
      return;
    }
    if (!drag) return;
    if (!drag.moved && Math.hypot(px - drag.sx, py - drag.sy) > 5) drag.moved = true;
    if (!drag.moved) return;
    if (drag.node) {
      drag.node.x += (px - drag.lx) / view.k;
      drag.node.y += (py - drag.ly) / view.k;
    } else {
      view.x += px - drag.lx; view.y += py - drag.ly;
    }
    drag.lx = px; drag.ly = py;
    requestDraw();
  });

  const endPtr = (e) => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (!drag || ptrs.size) return;
    const d = drag; drag = null;
    if (!d.moved) select(d.node ? d.node.id : null);
    else if (d.node) save();
  };
  canvas.addEventListener('pointerup', endPtr);
  canvas.addEventListener('pointercancel', endPtr);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [px, py] = local(e);
    zoomAt(px, py, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  canvas.style.touchAction = 'none';

  // ---------- selection + editor panel ----------
  function select(id) {
    sel = id && byId.has(id) ? id : null;
    renderPanel();
    requestDraw();
  }

  function renderPanel() {
    const n = sel && byId.get(sel);
    if (!n) { panel.hidden = true; panel.innerHTML = ''; return; }
    const types = [...new Set(['character', 'place', 'object', 'faction', 'event', 'thread', ...g.nodes.map((x) => x.type || 'thing')])];
    curConns = g.edges.filter((e) => e.from === n.id || e.to === n.id);
    const others = g.nodes.filter((x) => x !== n).sort((a, b) => a.name.localeCompare(b.name));
    const conns = curConns.map((e, i) => {
      const out = e.from === n.id;
      const o = byId.get(out ? e.to : e.from);
      return `<div class="rpg-conn"><span class="rpg-arrow">${out ? '→' : '←'}</span><a data-go="${esc(o && o.id)}">${esc(o && o.name)}</a><span class="rpg-rel">${esc(e.relation)}</span><button class="rpg-x" data-del="${i}" title="Remove link">✕</button></div>`;
    }).join('');
    panel.hidden = false;
    panel.innerHTML = `
      <div class="rpg-ph"><span class="rpg-dot" style="background:${color(n.type)}"></span><b>${esc(n.name)}</b><button class="rpg-x" data-a="deselect" title="Close">✕</button></div>
      <div class="rpg-pb">
        <label>Name<input class="rpg-in" id="rpg-f-name" value="${esc(n.name)}"></label>
        <label>Type<input class="rpg-in" id="rpg-f-type" list="rpg-types" value="${esc(n.type)}"></label>
        <datalist id="rpg-types">${types.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
        <label>Aliases (comma separated)<input class="rpg-in" id="rpg-f-alias" value="${esc((n.aliases || []).join(', '))}"></label>
        <label>Details<textarea class="rpg-in" id="rpg-f-text" rows="8">${esc(n.text)}</textarea></label>
        <div class="rpg-sec">Connections (${curConns.length})</div>
        <div class="rpg-conns">${conns || '<div class="rpg-muted">No connections yet.</div>'}</div>
        <div class="rpg-add">
          <select class="rpg-in" id="rpg-f-target">${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>
          <input class="rpg-in" id="rpg-f-rel" placeholder="relation, e.g. trusts">
          <button class="rpg-btn" data-a="addedge">Add link</button>
        </div>
      </div>
      <div class="rpg-pf"><button class="rpg-btn danger" data-a="delnode">Delete node</button><button class="rpg-btn primary" data-a="savenode">Save</button></div>`;
  }

  panel.addEventListener('click', (e) => {
    const n = sel && byId.get(sel);
    if (!n) return;
    const go = e.target.closest('[data-go]');
    if (go) { const t = byId.get(go.dataset.go); if (t) { select(t.id); focusNode(t); } return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      const edge = curConns[Number(del.dataset.del)];
      g.edges = g.edges.filter((x) => x !== edge);
      commit();
      return;
    }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'deselect') select(null);
    else if (a === 'savenode') {
      const name = panel.querySelector('#rpg-f-name').value.trim();
      if (!name) return toastr.error('Name cannot be empty.');
      if (g.nodes.some((x) => x !== n && norm(x.name) === norm(name))) return toastr.error('Another node already has that name.');
      n.name = name;
      n.type = panel.querySelector('#rpg-f-type').value.trim() || 'thing';
      n.aliases = panel.querySelector('#rpg-f-alias').value.split(',').map((s) => s.trim()).filter(Boolean);
      n.text = panel.querySelector('#rpg-f-text').value.trim();
      n.updatedAt = Date.now();
      commit('Saved.');
    } else if (a === 'delnode') {
      if (!confirm(`Delete "${n.name}" and its links?`)) return;
      g.nodes = g.nodes.filter((x) => x !== n);
      g.edges = g.edges.filter((x) => x.from !== n.id && x.to !== n.id);
      sel = null;
      commit();
    } else if (a === 'addedge') {
      const to = panel.querySelector('#rpg-f-target').value;
      const rel = panel.querySelector('#rpg-f-rel').value.trim();
      if (!to || !rel) return toastr.error('Pick a node and write a relation.');
      if (!g.edges.some((x) => x.from === n.id && x.to === to && norm(x.relation) === norm(rel))) {
        g.edges.push({ from: n.id, to, relation: rel, updatedAt: Date.now() });
      }
      commit();
    }
  });

  // ---------- toolbar ----------
  root.querySelector('.rpg-tools').addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'close') close();
    else if (a === 'zoom-in') zoomAt(cssW / 2, cssH / 2, 1.35);
    else if (a === 'zoom-out') zoomAt(cssW / 2, cssH / 2, 1 / 1.35);
    else if (a === 'fit') fit();
    else if (a === 'relayout') {
      layoutGraph(g.nodes, g.edges, { keep: false });
      save(); fit(false);
    } else if (a === 'add') {
      let name = 'New node', i = 2;
      while (g.nodes.some((x) => norm(x.name) === norm(name))) name = `New node ${i++}`;
      const cx = (cssW / 2 - view.x) / view.k, cy = (cssH / 2 - view.y) / view.k;
      const id = `n-${Date.now().toString(36)}`;
      g.nodes.push({ id, name, type: 'thing', aliases: [], text: '', x: Math.round(cx + (Math.random() - 0.5) * 60), y: Math.round(cy + (Math.random() - 0.5) * 60), createdAt: Date.now(), updatedAt: Date.now() });
      commit();
      select(id);
    }
  });

  const search = $('.rpg-search');
  search.addEventListener('input', () => {
    const q = norm(search.value);
    if (!q) matches = null;
    else {
      matches = new Set(g.nodes.filter((n) => norm([n.name, ...(n.aliases || []), n.text].join(' ')).includes(q)).map((n) => n.id));
    }
    requestDraw();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && matches && matches.size) {
      const first = byId.get([...matches][0]);
      if (first) focusNode(first);
    }
  });

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (sel) select(null); else close();
  };
  document.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(resize);
  ro.observe(stage);

  function close() {
    cancelAnimationFrame(anim);
    cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKey);
    ro.disconnect();
    root.remove();
  }

  reindex();
  resize();
  fit(false);
}
