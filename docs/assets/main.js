/* Tarcinapp Suite Docs — main.js */
(function () {
  /* ── Theme Toggle ─────────────────────────────────────────────────────── */
  const html = document.documentElement;
  const btn  = document.getElementById('themeToggle');
  const THEME_KEY = 'tarcin_theme';

  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initial = saved || (prefersDark ? 'dark' : 'light');
  html.setAttribute('data-theme', initial);

  if (btn) {
    btn.addEventListener('click', () => {
      const current = html.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      localStorage.setItem(THEME_KEY, next);
    });
  }

  /* ── Active nav link ──────────────────────────────────────────────────── */
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === path || (path === '' && href === 'index.html')) {
      a.closest('li')?.classList.add('active');
    }
  });

  /* ── Sidebar active link ──────────────────────────────────────────────── */
  const hash = window.location.hash;
  if (hash) {
    document.querySelectorAll('.doc-sidebar a').forEach(a => {
      if (a.getAttribute('href') === hash) a.classList.add('active');
    });
  }

  /* ── Smooth scroll + sidebar highlight ───────────────────────────────── */
  document.querySelectorAll('.doc-sidebar a[href^="#"]').forEach(a => {
    a.addEventListener('click', () => {
      document.querySelectorAll('.doc-sidebar a').forEach(x => x.classList.remove('active'));
      a.classList.add('active');
    });
  });

  /* ── IntersectionObserver for section headings ────────────────────────── */
  const headings = document.querySelectorAll('.doc-content h2[id], .doc-content h3[id]');
  if (headings.length) {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          document.querySelectorAll('.doc-sidebar a').forEach(a => {
            a.classList.toggle('active', a.getAttribute('href') === '#' + id);
          });
        }
      });
    }, { rootMargin: '-20% 0px -70% 0px' });
    headings.forEach(h => obs.observe(h));
  }
})();
