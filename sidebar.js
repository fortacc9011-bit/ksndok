(function () {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebarToggle');
  if (!sidebar || !toggle) return;

  const KEY = 'fgr_sidebar_collapsed';
  if (localStorage.getItem(KEY) === '1') sidebar.classList.add('collapsed');

  toggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    localStorage.setItem(KEY, sidebar.classList.contains('collapsed') ? '1' : '0');
  });
})();
