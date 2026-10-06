(function () {
  const prefetched = new Set();

  function prefetch(href) {
    if (!href || prefetched.has(href)) return;
    try {
      const u = new URL(href, window.location.href);
      if (u.origin !== window.location.origin) return;
      if (u.pathname === window.location.pathname) return;
    } catch (e) {
      return;
    }
    prefetched.add(href);
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = href;
    document.head.appendChild(link);
  }

  function bind(el) {
    if (!el || !el.href) return;
    const go = () => prefetch(el.href);
    el.addEventListener("mouseenter", go, { passive: true });
    el.addEventListener("focus", go, { passive: true });
  }

  document
    .querySelectorAll(".sidebar-nav a[href], .sidebar-footer a.nav-item[href], .sidebar-footer a.sidebar-user[href]")
    .forEach(bind);
})();
