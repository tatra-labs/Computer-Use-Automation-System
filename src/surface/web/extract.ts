/**
 * In-page perception. Runs inside each frame and returns a semantic description
 * of what a human would see: roles, accessible names, and — critically for
 * legacy surfaces — *captions inferred from layout*.
 *
 * Why not CSS selectors: the target app (like the real ones) regenerates element
 * ids on every render, so anything id/class-derived is dead on arrival. Why not
 * Playwright's ARIA snapshot: legacy markup produces empty accessible names
 * (no <label for>, no aria-*), and a name-less control is unaddressable. The
 * caption a human reads is in the table cell to the left or the column header
 * above, so that is what we compute.
 *
 * This is deliberately the same information a desktop accessibility provider
 * exposes (UIA ControlType / Name / BoundingRectangle / TreeWalker), which is
 * why the artifact schema above this layer needs no changes to target one.
 */

export interface RawControl {
  idx: number;
  role: string;
  name: string;
  labels: string[];
  value?: string;
  description?: string;
  container: string[];
  enabled: boolean;
  bbox: { x: number; y: number; w: number; h: number };
  tag: string;
  attrName?: string;
  type?: string;
}

export interface RawFrame {
  controls: RawControl[];
  text: string;
  title: string;
  url: string;
}

/**
 * Serialized into the page by Playwright, so it must be entirely self-contained:
 * no imports, no closure over module scope.
 */
export function extractFrame(limit: number): RawFrame {
  const MAXTXT = 140;

  const clean = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();
  const own = (el: Element): string => clean((el as HTMLElement).innerText ?? el.textContent ?? '');

  /** Text of an element, ignoring nested interactive content. */
  const caption = (el: Element | null | undefined): string => {
    if (!el) return '';
    const t = own(el);
    return t.length <= MAXTXT ? t : '';
  };

  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };

  const ROLE_BY_TAG: Record<string, string> = {
    A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox',
    TD: 'cell', TH: 'columnheader', TR: 'row', OPTION: 'option',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'password') return 'password';
      return 'textbox';
    }
    if (tag === 'A' && !(el as HTMLAnchorElement).getAttribute('href')) return 'text';
    return ROLE_BY_TAG[tag] ?? 'text';
  };

  /** Simplified accessible-name computation (the parts legacy apps actually use). */
  const accName = (el: Element): string => {
    const byIds = el.getAttribute('aria-labelledby');
    if (byIds) {
      const t = byIds.split(/\s+/).map((id) => caption(document.getElementById(id))).filter(Boolean).join(' ');
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const inp = el as HTMLInputElement;
      const t = (inp.type || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return clean(inp.value);
      if (inp.id) {
        const lab = document.querySelector(`label[for="${inp.id.replace(/"/g, '\\"')}"]`);
        if (lab) return caption(lab);
      }
      const wrap = el.closest('label');
      if (wrap) return caption(wrap);
      return '';
    }
    if (tag === 'SELECT' || tag === 'TEXTAREA') {
      const wrap = el.closest('label');
      if (wrap) return caption(wrap);
      return '';
    }
    const t = caption(el);
    if (t) return t;
    return clean(el.getAttribute('title') ?? '');
  };

  const cellIndex = (cell: Element): number => {
    const tr = cell.closest('tr');
    if (!tr) return -1;
    return Array.prototype.indexOf.call(tr.children, cell);
  };

  const columnHeader = (cell: Element): string => {
    const table = cell.closest('table');
    const tr = cell.closest('tr');
    if (!table || !tr) return '';
    const i = cellIndex(cell);
    if (i < 0) return '';
    const rows = Array.from(table.querySelectorAll('tr'));
    for (const r of rows) {
      if (r === tr) break;
      const hs = r.children;
      const h = hs[i];
      if (h && (h.tagName === 'TH' || hs.length === tr.children.length)) {
        const t = caption(h);
        if (t) return t;
      }
    }
    return '';
  };

  /**
   * The legacy label pattern: `<td>CAPTION:</td><td><input></td>`. There is no
   * markup association at all — only geometry — so we read leftward, then up.
   */
  const inferLabels = (el: Element): string[] => {
    const out: string[] = [];
    const push = (s: string) => { const c = clean(s); if (c && c.length <= MAXTXT && !out.includes(c)) out.push(c); };

    if ((el as HTMLElement).id) {
      const lab = document.querySelector(`label[for="${(el as HTMLElement).id.replace(/"/g, '\\"')}"]`);
      if (lab) push(caption(lab));
    }
    const wrap = el.closest('label');
    if (wrap) push(caption(wrap));

    const cell = el.tagName === 'TD' || el.tagName === 'TH' ? el : el.closest('td,th');
    if (cell) {
      // caption cell(s) to the left, nearest first
      let prev = cell.previousElementSibling;
      let hops = 0;
      while (prev && hops < 3) {
        const t = caption(prev);
        if (t) { push(t); break; }
        prev = prev.previousElementSibling;
        hops++;
      }
      push(columnHeader(cell));
      // in a grid row, the other short cells identify the row
      const tr = cell.closest('tr');
      if (tr) {
        for (const sib of Array.from(tr.children)) {
          if (sib === cell) continue;
          const t = caption(sib);
          if (t && t.length <= 40) push(t);
        }
      }
    }

    // text immediately preceding the control in the same parent
    let node = el.previousSibling;
    let guard = 0;
    while (node && guard++ < 4) {
      if (node.nodeType === 3) push(node.textContent ?? '');
      else if (node.nodeType === 1) push(caption(node as Element));
      if (out.length > 0) break;
      node = node.previousSibling;
    }

    const ph = el.getAttribute('placeholder');
    if (ph) push(ph);
    const ti = el.getAttribute('title');
    if (ti) push(ti);

    return out.slice(0, 5);
  };

  /** Enclosing region captions: table caption, fieldset legend, nearest heading. */
  const containerCaptions = (el: Element): string[] => {
    const out: string[] = [];
    const push = (s: string) => { const c = clean(s); if (c && c.length <= MAXTXT && !out.includes(c)) out.push(c); };
    let cur: Element | null = el;
    let hops = 0;
    while (cur && hops++ < 12) {
      if (cur.tagName === 'TABLE') {
        push(caption(cur.querySelector('caption')));
        // legacy apps title a table with a bold line just above it
        let p: ChildNode | null = cur.previousSibling;
        let g = 0;
        while (p && g++ < 4) {
          if (p.nodeType === 1 && /^(B|STRONG|H[1-6]|FONT|DIV|P)$/.test((p as Element).tagName)) { push(caption(p as Element)); break; }
          if (p.nodeType === 3 && clean(p.textContent ?? '')) { push(p.textContent ?? ''); break; }
          p = p.previousSibling;
        }
      }
      if (cur.tagName === 'FIELDSET') push(caption(cur.querySelector('legend')));
      if (cur.tagName === 'FORM') {
        const act = cur.getAttribute('action');
        if (act) push('form:' + act);
      }
      cur = cur.parentElement;
    }
    const h = document.querySelector('h1,h2,h3');
    if (h) push(caption(h));
    if (document.title) push(document.title);
    return out.slice(0, 4);
  };

  const INTERACTIVE = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]';
  const STATEFUL = 'td,th,h1,h2,h3,h4,h5,h6,[role=alert],.err';

  const nodes: Element[] = [];
  const controls: RawControl[] = [];

  const collect = (el: Element) => {
    if (controls.length >= limit) return;
    if (el.tagName === 'INPUT' && ((el as HTMLInputElement).type || '').toLowerCase() === 'hidden') return;
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    const role = roleOf(el);
    const name = accName(el);
    const labels = inferLabels(el);
    // A control with neither a name nor any inferred caption and no value is
    // not addressable; reporting it only adds noise and ambiguity.
    const val = 'value' in el ? String((el as HTMLInputElement).value ?? '') : '';
    if (!name && labels.length === 0 && !val) return;

    const idx = nodes.length;
    nodes.push(el);
    const inp = el as HTMLInputElement;
    controls.push({
      idx,
      role,
      name,
      labels,
      value: val || undefined,
      description: clean(el.getAttribute('aria-description') ?? el.getAttribute('title') ?? '') || undefined,
      container: containerCaptions(el),
      enabled: !(el as HTMLButtonElement).disabled,
      bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      tag: el.tagName.toLowerCase(),
      attrName: inp.name || undefined,
      type: inp.type || undefined,
    });
  };

  for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) collect(el);
  for (const el of Array.from(document.querySelectorAll(STATEFUL))) {
    // skip containers whose text is just their interactive children
    if (el.querySelector(INTERACTIVE)) continue;
    collect(el);
  }

  (window as unknown as { __hs?: { nodes: Element[] } }).__hs = { nodes };

  return {
    controls,
    text: clean(document.body ? (document.body as HTMLElement).innerText : '').slice(0, 20_000),
    title: document.title,
    url: location.href,
  };
}
