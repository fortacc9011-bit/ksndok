// Tiny shared helpers used across the authed UI. Loaded once (from app_base.html
// and admin/base.html) before any page-specific script, exposed as window.FGR so
// each module can alias what it needs instead of redefining these.
window.FGR = (function () {
  // CSRF token from the cookie (CSRF_COOKIE_HTTPONLY is False) — set as the
  // X-CSRFToken header on fetch() POST/PUT/DELETE requests.
  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.content && meta.content !== 'NOTPROVIDED') return meta.content;
    const inp = document.querySelector('input[name=csrfmiddlewaretoken]');
    return inp ? inp.value : '';
  }

  // Escape a string for safe insertion into innerHTML.
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Copy text to the clipboard. Uses the async Clipboard API in secure contexts
  // (HTTPS / localhost) and falls back to a hidden <textarea> + execCommand for
  // plain HTTP, where navigator.clipboard is undefined. Returns a Promise.
  function copyText(text) {
    text = String(text);
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(() => execCopy(text));
    }
    return execCopy(text);
  }
  function execCopy(text) {
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  // Wire a copy button: on click, copy `text()` (string or fn) and briefly show a
  // "copied" state by swapping the button's label element text. `opts.label` is
  // the element whose textContent changes (defaults to the button itself); pass an
  // `okClass` to toggle a class during the confirmation window.
  function bindCopy(btn, text, opts) {
    opts = opts || {};
    const labelEl = opts.label || btn;
    const idle = opts.idleText !== undefined ? opts.idleText : labelEl.textContent;
    const okText = opts.okText || 'Copied!';
    btn.addEventListener('click', () => {
      copyText(typeof text === 'function' ? text() : text).then(() => {
        labelEl.textContent = okText;
        if (opts.okClass) btn.classList.add(opts.okClass);
        setTimeout(() => {
          labelEl.textContent = idle;
          if (opts.okClass) btn.classList.remove(opts.okClass);
        }, opts.timeout || 1500);
      }).catch(() => {});
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // dumpStore — large-capacity client storage for Dump Analyzer dumps.
  //
  // Dumps used to live in localStorage (key 'fgr_dumps'), which caps at ~5 MB
  // per origin — users uploading several/large dumps hit "Storage full". This
  // moves dumps to IndexedDB (hundreds of MB → GB quota) while keeping a
  // synchronous in-memory cache so existing call sites don't have to become
  // async for reads. Call ready() once at startup, then use the sync getters.
  //
  // Legacy localStorage dumps are migrated into IndexedDB on first load.
  // Selected-dump id and chat history stay in localStorage (tiny).
  const dumpStore = (function () {
    const DB_NAME = 'fgr', STORE = 'dumps', VERSION = 1, LS_KEY = 'fgr_dumps';
    const hasIDB = typeof indexedDB !== 'undefined';
    let cache = [];        // in-memory mirror, newest first
    let dbP = null;        // cached open-DB promise
    let readyP = null;

    function openDB() {
      if (dbP) return dbP;
      dbP = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbP;
    }
    function store(db, mode) { return db.transaction(STORE, mode).objectStore(STORE); }
    function sortNewest(list) { list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); }
    function persistLS() { try { localStorage.setItem(LS_KEY, JSON.stringify(cache)); } catch (e) { /* quota — IDB is primary */ } }

    async function load() {
      if (!hasIDB) {                                   // very old browser: stay on localStorage
        try { cache = JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch (e) { cache = []; }
        sortNewest(cache);
        return;
      }
      const db = await openDB();
      cache = await new Promise((resolve) => {
        const out = [];
        const req = store(db, 'readonly').openCursor();
        req.onsuccess = (e) => { const c = e.target.result; if (c) { out.push(c.value); c.continue(); } else resolve(out); };
        req.onerror = () => resolve([]);
      });
      // One-time migration of any dumps still sitting in localStorage.
      if (!cache.length) {
        let legacy = [];
        try { legacy = JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch (e) { legacy = []; }
        if (legacy.length) {
          await new Promise((resolve) => {
            const os = store(db, 'readwrite');
            legacy.forEach((d) => os.put(d));
            os.transaction.oncomplete = resolve;
            os.transaction.onerror = resolve;
          });
          cache = legacy.slice();
          try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
        }
      }
      sortNewest(cache);
    }

    function ready() { if (!readyP) readyP = load().catch(() => { cache = cache || []; }); return readyP; }
    function getAll() { return cache.slice(); }
    function get(id) { return cache.find((d) => d.id === id) || null; }

    async function put(dump) {                          // add (newest first) or update in place
      const i = cache.findIndex((d) => d.id === dump.id);
      if (i >= 0) cache[i] = dump; else cache.unshift(dump);
      if (!hasIDB) { persistLS(); return; }
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const req = store(db, 'readwrite').put(dump);
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
      });
    }

    async function remove(id) {
      cache = cache.filter((d) => d.id !== id);
      if (!hasIDB) { persistLS(); return; }
      const db = await openDB();
      await new Promise((resolve) => {
        const req = store(db, 'readwrite').delete(id);
        req.onsuccess = resolve; req.onerror = resolve;
      });
    }

    return { ready, getAll, get, put, remove };
  })();

  const NOTIFY_ICONS = {
    success:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
    warning:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 4.5l8.5 15H3.5L12 4.5z"/><path d="M12 10v4M12 17h.01"/></svg>',
    info:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  };

  function ensureNotifyStack() {
    let stack = document.getElementById('fgrNotifyStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'fgrNotifyStack';
      stack.className = 'fgr-notify-stack';
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    return stack;
  }

  function notify(message, type, duration) {
    const text = String(message || '').trim();
    if (!text) return;
    const kind = type || 'info';
    const ms = duration || (kind === 'error' ? 10000 : 6000);
    const stack = ensureNotifyStack();
    const el = document.createElement('div');
    el.className = 'fgr-notify fgr-notify--' + kind;
    el.setAttribute('role', 'status');

    const row = document.createElement('div');
    row.className = 'fgr-notify__row';

    const icon = document.createElement('span');
    icon.className = 'fgr-notify__icon';
    icon.innerHTML = NOTIFY_ICONS[kind] || NOTIFY_ICONS.info;

    const body = document.createElement('p');
    body.className = 'fgr-notify__text';
    body.textContent = text;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'fgr-notify__close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '\u00d7';

    row.appendChild(icon);
    row.appendChild(body);
    row.appendChild(closeBtn);

    const progress = document.createElement('div');
    progress.className = 'fgr-notify__progress';
    progress.style.animationDuration = ms + 'ms';

    el.appendChild(row);
    el.appendChild(progress);
    stack.appendChild(el);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      el.classList.remove('fgr-notify--in');
      el.classList.add('fgr-notify--out');
      setTimeout(() => el.remove(), 340);
    };

    closeBtn.addEventListener('click', close);
    requestAnimationFrame(() => el.classList.add('fgr-notify--in'));
    setTimeout(close, ms);
  }

  let _djangoMessagesFlushed = false;
  function flushDjangoMessages() {
    if (_djangoMessagesFlushed) return;
    const root = document.getElementById('fgrDjangoMessages');
    if (!root) return;
    _djangoMessagesFlushed = true;
    root.querySelectorAll('[data-fgr-msg]').forEach((node) => {
      const tags = (node.getAttribute('data-tags') || '').split(/\s+/);
      let type = 'info';
      if (tags.includes('error')) type = 'error';
      else if (tags.includes('success')) type = 'success';
      else if (tags.includes('warning')) type = 'warning';
      notify(node.textContent.trim(), type);
    });
    root.remove();
  }

  return {
    csrfToken,
    esc,
    copyText,
    bindCopy,
    dumpStore,
    notify,
    flushDjangoMessages,
  };
})();
