# Tarcinapp Suite — Documentation

This folder contains the **HTML documentation site** for the Tarcinapp Suite.

## Structure

```
docs/
├── index.html           ← Homepage (hero, value props, architecture preview, components strip)
├── architecture.html    ← Six-layer architecture, request flow, topology diagrams
├── concepts.html        ← Data model, security, domain projection, orchestration, query language
├── components.html      ← Per-component reference (EPS, gateway, policies, orchestrator, GUI)
├── resources.html       ← Resources landing page
├── getting-started.html ← Local dev setup guide (Docker Compose, EPS, gateway, GUI)
├── examples.html        ← Books app walkthrough, adding a new kind, custom logic patterns
├── configuration.html   ← All env vars and config keys for every component
└── assets/
    ├── style.css        ← Design system (Inter + JetBrains Mono, light/dark mode)
    └── main.js          ← Theme toggle, sidebar scroll spy, active nav highlighting
```

## Viewing

Open `index.html` directly in a browser — no build step required. All pages are self-contained HTML files with a shared CSS/JS asset layer.

> **Note:** Google Fonts are loaded from a CDN. Use offline mode or substitute system fonts if working without internet access.

## Evolving with the Suite

This documentation folder is designed to grow with the suite. As new components are built and released:

1. Add new pages to the relevant section (components, examples, etc.)
2. Update the navigation links in each page's `<nav>` and footer
3. Update the component status badges in `components.html` and `index.html`
4. Add new examples to `examples.html` as patterns emerge

All SVG diagrams are inline — they can be edited directly in the HTML without external tooling.
