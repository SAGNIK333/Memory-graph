// Modal that shows exactly what a summary will send. Resolves true (send) or false (cancel/close).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tok = (n) => `≈ ${Math.max(1, Math.round(n / 4)).toLocaleString()} tokens`;

export function showPreview(plan, { confirm = true } = {}) {
  return new Promise((resolve) => {
    if (document.querySelector('.rpg-pv')) { resolve(false); return; }
    const parts = plan.parts || [];
    let cur = 0;
    let tab = 'req';

    const root = document.createElement('div');
    root.className = 'rpg-pv';
    root.innerHTML = `
      <div class="rpg-pv-card">
        <div class="rpg-pv-head"><b>${esc(plan.title)}</b><button class="rpg-btn" data-a="cancel" title="Close">✕</button></div>
        <div class="rpg-pv-info">${(plan.lines || []).map((l) => `<div>${esc(l)}</div>`).join('')}${plan.note ? `<div class="rpg-pv-note">${esc(plan.note)}</div>` : ''}</div>
        <div class="rpg-pv-bar">
          <select class="rpg-in rpg-pv-part">${parts.map((p, i) => `<option value="${i}">${esc(p.label)} · chat messages ${p.first}–${p.last} · ${tok(p.chars)}</option>`).join('')}</select>
          <div class="rpg-pv-tabs"><button data-tab="req" class="on">Exact request</button><button data-tab="msgs">Chat history</button></div>
        </div>
        <div class="rpg-pv-body"></div>
        <div class="rpg-pv-foot">
          ${confirm ? '<button class="rpg-btn" data-a="cancel">Cancel</button>' : ''}
          <button class="rpg-btn" data-a="copy">Copy request</button>
          ${confirm ? `<button class="rpg-btn primary" data-a="send">Send ${parts.length} part${parts.length === 1 ? '' : 's'}</button>` : '<button class="rpg-btn primary" data-a="cancel">Close</button>'}
        </div>
      </div>`;
    document.body.appendChild(root);
    const body = root.querySelector('.rpg-pv-body');

    function render() {
      const p = parts[cur];
      if (!p) { body.innerHTML = '<div class="rpg-muted">Nothing to show.</div>'; return; }
      if (tab === 'req') {
        body.innerHTML = `
          <div class="rpg-pv-sec">System message <span>${p.system.length.toLocaleString()} chars · ${tok(p.system.length)}</span></div>
          <textarea class="rpg-in rpg-pv-ta" readonly rows="6">${esc(p.system)}</textarea>
          <div class="rpg-pv-sec">User message (graph context + chat history) <span>${p.prompt.length.toLocaleString()} chars · ${tok(p.prompt.length)}</span></div>
          <textarea class="rpg-in rpg-pv-ta tall" readonly rows="16">${esc(p.prompt)}</textarea>`;
      } else {
        body.innerHTML = `<div class="rpg-pv-sec">${p.count} message${p.count === 1 ? '' : 's'} in this part <span>chat positions ${p.first}–${p.last}</span></div>` +
          p.messages.map((m) => `<div class="rpg-pv-msg"><i>#${m.n}</i><span>${esc(m.text)}</span></div>`).join('');
      }
    }

    function close(result) {
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      resolve(result);
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } };
    document.addEventListener('keydown', onKey, true);

    root.addEventListener('click', async (e) => {
      if (e.target === root) return close(false);
      const t = e.target.closest('[data-tab]');
      if (t) {
        tab = t.dataset.tab;
        root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b === t));
        return render();
      }
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'cancel') close(false);
      else if (a === 'send') close(true);
      else if (a === 'copy') {
        const p = parts[cur];
        if (!p) return;
        const text = `[SYSTEM]\n${p.system}\n\n[USER]\n${p.prompt}`;
        try { await navigator.clipboard.writeText(text); } catch {
          const ta = root.querySelector('.rpg-pv-ta');
          if (ta) { ta.select(); try { document.execCommand('copy'); } catch { /* ignore */ } }
        }
        if (typeof toastr !== 'undefined') toastr.success('Request copied.');
      }
    });
    root.querySelector('.rpg-pv-part').addEventListener('change', (e) => { cur = Number(e.target.value) || 0; render(); });
    render();
  });
}
