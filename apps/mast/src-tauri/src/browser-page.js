(() => {
  const generation = [...crypto.getRandomValues(new Uint32Array(4))].join("-");
  let snapshot = 0;
  const refs = new Map();
  const logs = [], errors = [];
  const push = (buffer, entry) => { buffer.push(entry); if (buffer.length > 100) buffer.shift(); };
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      push(logs, {level, text: args.map(a => { try { return String(a); } catch { return '[unprintable]'; } }).join(' ').slice(0, 2000)});
      original(...args);
    };
  }
  addEventListener('error', e => push(errors, {message: String(e.message).slice(0, 2000)}));
  addEventListener('unhandledrejection', e => push(errors, {message: String(e.reason).slice(0, 2000)}));
  const fail = (error, message) => ({error, message});
  const element = ref => refs.get(ref);
  Object.defineProperty(window, '__mastBrowser', {value: {run(action, args = {}) {
    if (action === 'snapshot') {
      refs.clear(); snapshot++;
      const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role],[tabindex]')].filter(e => e.getClientRects().length).slice(0, 400).map((e, i) => {
        const ref = `${generation}:${snapshot}:${i}`; refs.set(ref, e);
        return {ref, tag: e.tagName.toLowerCase(), role: e.getAttribute('role'), text: (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || '').slice(0, 300), type: e.getAttribute('type')};
      });
      return {url: location.href, title: document.title, text: document.body?.innerText.slice(0, 40000) || '', elements};
    }
    if (action === 'console') return {entries: logs.slice()};
    if (action === 'errors') return {entries: errors.slice()};
    if (action === 'wait') return {ready: args.text ? (document.body?.innerText || '').includes(args.text) : document.readyState === 'complete'};
    if (action === 'scroll') { scrollBy(0, Math.max(-10000, Math.min(10000, Number(args.y) || 0))); return {ok: true}; }
    const e = element(args.ref);
    if (!e || !e.isConnected) return fail('stale_ref', 'Take a new snapshot and use its element ref');
    if (action === 'click') { e.click(); return {ok: true}; }
    if (action === 'fill') {
      if (!(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement)) return fail('invalid_params', 'Element is not a text input');
      e.focus();
      const proto = e instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, String(args.text ?? ''));
      e.dispatchEvent(new Event('input', {bubbles: true})); e.dispatchEvent(new Event('change', {bubbles: true}));
      return {ok: true};
    }
    if (action === 'press') { e.focus(); return {focused: true}; }
    return fail('invalid_params', 'Unknown action');
  }}, configurable: false});
})();
