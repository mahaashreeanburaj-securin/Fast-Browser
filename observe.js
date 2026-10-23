// Adapted from browser-use/jev-ultrafast (MIT, (c) 2026 Browser Use) — see THIRD_PARTY_NOTICES.md
// In-page engine. Evaluated as `(source)(arg)`; arg.op picks observe | check | target | ref | wait.
(arg) => {
  if (!document.body) return null;
  const fb = window.__fb ||= { ids: new WeakMap(), nodes: new Map(), next: 1 };
  const identity = e => {
    if (!fb.ids.has(e)) fb.ids.set(e, fb.next++);
    const id = fb.ids.get(e); fb.nodes.set(id, e); return id;
  };
  for (const [id, e] of fb.nodes) if (!e.isConnected) fb.nodes.delete(id);
  const clip = (s, n = 100) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const secret = e => e.tagName === 'INPUT' && ['password', 'file', 'hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  // Document order, descending into open shadow roots right after their host.
  const walk = (root, fn) => {
    for (const e of root.querySelectorAll('*')) { fn(e); if (e.shadowRoot) walk(e.shadowRoot, fn); }
  };
  const deep = sel => { const out = []; walk(document, e => { if (e.matches(sel)) out.push(e); }); return out; };
  const byId = (e, id) => e.getRootNode().getElementById?.(id) || document.getElementById(id);
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => name(byId(e, id), seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels || [])].map(l => name(l, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName === 'INPUT' ? (e.getAttribute('placeholder') || e.getAttribute('name') || '') : kids(e).map(n => n.nodeType === 3 ? n.textContent :
        n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  // A slot shows its assigned light-DOM content; its own children are only the fallback.
  const kids = e => {
    const assigned = e.tagName === 'SLOT' ? e.assignedNodes({ flatten: true }) : [];
    return assigned.length ? assigned : [...e.childNodes];
  };
  const label = e => clip(name(e));
  const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio',
    'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map(r => '[role="' + r + '"]').join(',');
  const role = e => {
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type;
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  const pageKey = () => [performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    deep('input,textarea,select').filter(e => !secret(e))
      .map(e => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly])];
  let viewText = null;
  const viewportText = () => {
    if (viewText !== null) return viewText;
    const words = [];
    let length = 0;
    const range = document.createRange();
    const readText = root => {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = tw.nextNode()) && length < 6000) {
        if (node.nodeType === 1) { if (node.shadowRoot) readText(node.shadowRoot); continue; }
        const value = node.textContent.trim(), parent = node.parentElement;
        if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
        range.selectNodeContents(node); const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
          words.push(value); length += value.length;
        }
      }
    };
    readText(document.body);
    return viewText = words.join('\n').slice(0, 6000);
  };
  // Enclosing form/dialog/row text; at page level the visible viewport text, so offscreen changes don't count.
  const context = e => {
    const scope = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    if (!scope || scope === document.body || scope === document.documentElement) return viewportText();
    return scope.innerText?.slice(0, 6000) || '';
  };
  const guard = e => {
    if (!e?.isConnected || !visible(e)) return null;
    return [identity(e), role(e), label(e), secret(e) ? null : e.value ?? null, e.checked ?? null,
      e.selectedIndex ?? null, e.readOnly ?? null, e.matches(':disabled'), e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'), e.getAttribute('aria-checked'), e.getAttribute('aria-selected'),
      e.getAttribute('href'), context(e),
      e.tagName === 'SELECT' ? [...e.options].map(o => [o.value, o.label, o.disabled]) : null];
  };
  // Hit-test in the element's own tree; walk the flat tree so slotted light-DOM content counts as inside.
  const hit = (e, x, y) => {
    const root = e.getRootNode();
    const top = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
    for (let n = top; n; n = n.assignedSlot || n.parentNode || n.host) if (n === e) return true;
    // Slotted bare text hit-tests as its host; accept only when that text, rendered inside e, is under the point.
    let up = e;
    while (up && up !== top) up = up.parentNode || up.host;
    if (!top || !up) return false;
    const range = document.createRange();
    return [...e.querySelectorAll('slot')].some(s => s.assignedNodes({ flatten: true }).some(n => {
      if (n.nodeType !== 3) return false;
      range.selectNodeContents(n);
      return [...range.getClientRects()].some(b => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
    }));
  };
  const ownTextIsValue = e => e.tagName !== 'INPUT' && e.tagName !== 'TEXTAREA' &&
    (e.isContentEditable || ['textbox', 'searchbox', 'combobox'].includes(e.getAttribute('role'))) &&
    !e.hasAttribute('aria-label') && !e.hasAttribute('aria-labelledby');

  if (arg.op === 'check') return { pk: JSON.stringify(pageKey()), g: JSON.stringify(guard(fb.nodes.get(arg.node))) };

  if (arg.op === 'ref') {
    const e = fb.nodes.get(arg.node);
    if (!e?.isConnected) return null;
    if ((role(e) || e.getAttribute('role') || e.tagName.toLowerCase()) !== arg.role) return null;
    // An editable element's own text is its value, and value changes are allowed.
    return ownTextIsValue(e) || label(e) === arg.name ? e : null;
  }

  if (arg.op === 'target') {
    const e = fb.nodes.get(arg.node);
    if (!e?.isConnected) return { stale: 'target is gone' };
    if (e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]')) return { stale: 'target is disabled' };
    if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return { stale: 'target is hidden' };
    if (arg.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return { stale: 'target is read-only' };
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { stale: 'target is outside the viewport' };
    if (!hit(e, x, y)) return { stale: 'target is covered by another element' };
    if (arg.kind === 'select') {
      if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === arg.value &&
          !o.disabled && !o.closest('optgroup[disabled]'))) return { stale: 'option is gone' };
      e.value = arg.value;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return { x, y, selected: e.value === arg.value };
    }
    return { x, y };
  }

  if (arg.op === 'wait') return new Promise(resolve => {
    const field = fb.nodes.get(arg.node);
    const autocomplete = arg.kind === 'fill' && field?.getAttribute('role') === 'combobox';
    let frames = 0, stopped = false;
    const finish = () => { stopped = true; resolve(true); };
    setTimeout(finish, autocomplete ? 200 : 50);
    const ready = () => {
      if (stopped) return;
      const ids = (field?.getAttribute('aria-controls') || field?.getAttribute('aria-owns') || '')
        .split(/\s+/).filter(Boolean);
      const roots = ids.length ? ids.map(id => byId(field, id)).filter(Boolean) : [document];
      const options = roots.flatMap(root => [...root.querySelectorAll('[role="option"]')]);
      if (++frames >= 2 && (!autocomplete || options.some(e => {
        const r = e.getBoundingClientRect();
        return r.width && r.height && r.bottom > 0 && r.top < innerHeight &&
          e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }))) finish();
      else requestAnimationFrame(ready);
    };
    requestAnimationFrame(ready);
  });

  if (arg.scope === 'page') {
    const limit = arg.limit ?? 150, items = [];
    for (const e of deep('a,' + selector)) {
      if (items.length >= limit) break;
      if (e.tagName === 'INPUT' && e.type === 'hidden') continue;
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height || !e.checkVisibility({ checkVisibilityCSS: true })) continue;
      const tag = e.tagName.toLowerCase(), attrRole = e.getAttribute('role') || '', type = e.getAttribute('type') || '';
      const desc = tag === 'a' ? 'link'
        : (tag === 'button' || attrRole === 'button') ? 'button'
        : (tag === 'input' || tag === 'textarea') ? `${tag}${type ? '[' + type + ']' : ''}`
        : tag === 'select' ? 'select' : (attrRole || tag);
      const nm = label(e);
      items.push({
        node: identity(e), role: role(e) || attrRole || tag, name: nm, desc,
        label: nm || clip(e.getAttribute('name')),
        val: !secret(e) && 'value' in e && typeof e.value === 'string' ? clip(e.value, 30) : '',
        href: tag === 'a' ? (e.href || '').slice(0, 120) : '',
        chk: (e.type === 'checkbox' || e.type === 'radio') ? e.checked : null,
      });
    }
    return items;
  }

  const elems = [], options = [];
  for (const e of deep(selector)) {
    if (secret(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, rname = role(e);
    if (!rname || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base = { node: identity(e), role: rname, label: label(e) || rname,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    for (const key of ['checked', 'selected', 'expanded']) {
      const value = e.getAttribute('aria-' + key);
      if (value !== null) base[key] = value;
    }
    if (['checkbox', 'radio'].includes(e.type)) base.checked = String(e.checked);
    if (e.tagName === 'SELECT') {
      const current = [...e.selectedOptions].map(o => o.label).join(', ');
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        options.push({ ...base, kind: 'select', value: o.value, current_value: current,
          label: clip(base.label + ' → ' + o.label) });
    } else {
      const editable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
        (['textbox', 'searchbox', 'spinbutton'].includes(rname) ||
          (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
      const value = clip('value' in e && typeof e.value === 'string' ? e.value :
        e.isContentEditable || rname === 'combobox' ? e.innerText : '', 1000);
      elems.push({ ...base, kind: editable ? 'fill' : 'click', value });
      if (editable) elems.push({ ...base, kind: 'click', value, label: clip('Open ' + base.label) });
    }
  }
  // Native select options go last so one long dropdown cannot crowd out the buttons.
  const actions = elems.concat(options);

  const text = viewportText(), height = document.documentElement.scrollHeight;
  const page_key = pageKey(), guards = {};
  for (const a of actions) if (!(a.node in guards)) guards[a.node] = JSON.stringify(guard(fb.nodes.get(a.node)));
  // Meaning and identity only; geometry is re-resolved and hit-tested just before input.
  const semantics = actions.map(({ rect, ...a }) => a);
  const marker = JSON.stringify([performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight,
    document.title, text, semantics, page_key[6]]);
  const omitted = Math.max(0, actions.length - 250);
  actions.splice(250);
  actions.forEach((a, i) => a.id = 'e' + (i + 1));
  if (scrollY + innerHeight < height - 2) actions.push({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 });
  if (scrollY > 0) actions.push({ id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -560 });
  actions.push({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });
  return { url: location.href, title: document.title, w: innerWidth, h: innerHeight, text,
    scroll: { y: scrollY, height }, actions, marker, page_key: JSON.stringify(page_key), guards, omitted };
}
