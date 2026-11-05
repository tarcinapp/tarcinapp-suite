# 14_COMPONENT_tarcinapp-base-gui.md

## Component Identity

**Repository:** `tarcinapp-base-gui`  
**Technology:** React 18 · Vite 5 · Tailwind CSS v3 · React Router v6  
**Layer:** I — Client & Entrance  
**Dev server port:** `5173`  
**Source of truth for its own docs:** [`tarcinapp-base-gui/context/5-REPO-CONTEXT.md`](../../tarcinapp-base-gui/context/5-REPO-CONTEXT.md)

---

## What It Is

`tarcinapp-base-gui` is a **domain-agnostic admin and explorer UI** for any Tarcinapp deployment. It has no hardcoded knowledge of any business domain. Instead, on first load, it fetches the **OpenAPI spec** from the connected Gateway and builds the entire interface from it:

- Navigation structure (sidebar entries)
- Page routes
- Data grid columns
- Create/edit form fields
- Available actions (which buttons to show)
- Traversal links (sub-resource navigation)

The same codebase, unmodified, can serve as the UI for a books app, a product catalog, a CRM, or any other domain that Tarcinapp has been configured for. Swapping the connected Gateway URL changes what the UI renders. The code stays the same.

---

## Central Mechanism: OAS-Driven UI Generation

`src/utils/oasParser.js` is the core of the application. On setup/load, it:

1. Fetches `GET /openapi.json` (or `GET /openapi.yaml`) from the configured Gateway, with the user's Bearer token.
2. Parses the spec to derive:
   - **Sidebar navigation**: one entry per OAS **tag**. Tags are grouped by `x-base-record-type` extension (entity, list, relation, entity-reaction, list-reaction). Each tag becomes a URL slug (e.g., tag `Books` → route `/r/books`).
   - **Data grid columns**: from the 200-response schema of each collection `GET` operation.
   - **Form fields**: from the POST (`New{Kind}`) and PATCH (`Patch{Kind}`) request body schemas.
   - **Available actions**: Create / Edit / Delete buttons are rendered only when the corresponding HTTP methods appear in the spec for that resource.
   - **Traversal links**: sub-resource paths like `/books/{id}/chapters` are discovered and surfaced as navigation within item views.

---

## OAS as Security Boundary

The Gateway does not generate a generic public OAS spec. It generates a **personalized spec per caller**, shaped by the caller's identity, roles, and active OPA policies:

- Fields the caller **may not read** are physically removed from GET response schemas → the GUI does not render them as columns.
- Fields the caller **may not write** are physically removed from POST/PATCH schemas → the GUI does not include them in forms.
- Routes the caller **may not access** are absent from the spec entirely → the GUI renders no Create/Edit/Delete button for those operations.

**The GUI implements zero client-side access control logic.** It renders exactly what the spec describes. Changing a user's role or updating an OPA policy is immediately reflected in the UI on the next spec fetch — no frontend changes needed.

---

## Two Deployment Modes

### 1. Generic mode (no domain projection)
Gateway exposes generic resource types directly. OAS contains paths like `/entities`, `/lists`, `/entity-reactions`. Sidebar shows five entries: Entities, Lists, Relations, Entity reactions, List reactions.

### 2. Domain projection active
Gateway overlays a business domain. OAS contains kind-alias paths like `/entities/books`, `/lists/shelves`. Sidebar shows domain-specific entries: Books, Shelves, Authors, etc. The `x-base-record-type` tag extension determines which structural group (entity/list/etc.) each entry belongs to for sidebar ordering.

---

## `x-base-record-type` Extension

This is the key OAS extension that allows the GUI to work in domain-projected mode. It is set on each tag definition in the Gateway config:

```yaml
# In entity-persistence-gateway application-routes.yaml
springdoc:
  tags:
    - name: Books
      x-base-record-type: entity
    - name: Shelves
      x-base-record-type: list
    - name: Book-Shelf Relations
      x-base-record-type: relation
    - name: Book Reviews
      x-base-record-type: entity-reaction
```

The GUI reads `spec.tags[*]['x-base-record-type']` to determine the structural type. If missing, it falls back to scanning the collection path string for standard segment names (`entities`, `lists`, etc.). Deployments that rename resource type path segments **must** set this extension.

---

## Pages (OAS-Driven)

| Component | Route | Description |
|:---|:---|:---|
| `ResourcePage` | `/r/:tagSlug` | Paginated data grid for a collection. Status/visibility filters, `_name` search, fieldset selector, query info panel, cURL export, inline create and delete. |
| `ItemPage` | `/r/:tagSlug/item/:itemId` | Single-item detail view. Inline field editing via PATCH. Delete with confirmation. |
| `TraversalPage` | `/r/:tagSlug/:subResource` | Sub-resource view. Resolves traversal path templates from the spec (e.g., `/books/{id}/chapters`). |
| `DashboardPage` | `/` | Overview with resource stat cards derived from count endpoints. |
| `SetupScreen` | _(shown when no spec loaded)_ | Enter Gateway URL + Bearer token, or drag-and-drop a local OAS JSON file. |

---

## Project Structure

```
src/
├── App.jsx                        ← Root component, router setup (React Router v6)
├── context/AppContext.jsx          ← Global state: spec, endpoint, token, bypass-cache flag
├── utils/oasParser.js             ← Parses OAS → navItems, column defs, pagination keys
├── services/apiClient.js          ← Generic fetch-based HTTP client (GET/POST/PATCH/DELETE)
├── hooks/useResourceList.js       ← Data-fetching hook with loading/error/refresh state
├── components/
│   ├── dynamic/                   ← OAS-driven pages
│   │   ├── ResourcePage.jsx       ← Collection view (data grid)
│   │   ├── ItemPage.jsx           ← Single-item detail view
│   │   └── TraversalPage.jsx      ← Sub-resource traversal view
│   ├── layout/                    ← App shell
│   │   ├── AppLayout.jsx
│   │   ├── Sidebar.jsx            ← OAS-tag-driven navigation
│   │   └── TopBar.jsx
│   ├── setup/                     ← Connection/setup screen
│   └── ui/                        ← Shared components
│       ├── DataGrid.jsx
│       ├── Badges.jsx
│       ├── Toast.jsx
│       └── ConfirmDialog.jsx
└── pages/
    └── DashboardPage.jsx
```

---

## Query Parameters and Fieldsets

### Simplified parameters (gateway-added)
The GUI detects which parameters are available per endpoint and uses them:

| Feature | Simplified param | Fallback |
|:---|:---|:---|
| Search | `?s=value` | `filter[where][_name][regexp]=.*value.*` |
| Pagination | `?limit=N&skip=M` | `filter[limit]=N&filter[skip]=M` |
| Field projection | `?fields=f1,f2` | `filter[fields][f1]=true...` |
| Named query | `?q=name` | _(no fallback)_ |
| Fieldset | `?fieldset=name` | _(no fallback)_ |
| Status filter | `set[actives]=true`, etc. | _(native to backend)_ |
| Visibility filter | `set[publics]=true`, etc. | _(native to backend)_ |

If a parameter is not declared in the spec for a given endpoint, the corresponding UI control is not rendered.

### Fieldset dropdown
Rendered only when the spec declares a `fieldset` param with an `enum` schema. The dropdown is populated exclusively from the enum values in the spec — the GUI adds nothing to them.

Common gateway-default fieldset values:
- `show-all` — all fields
- `show-managed-all` — only managed fields
- `hide-managed-all` — only application-defined fields
- `hide-managed-except-id` — strip managed except `_id`
- `hide-managed-except-id-kind-name` — strip managed except `_id`, `_kind`, `_name`

---

## Setup and Configuration

### SetupScreen
Shown when no spec is loaded. User provides:
- Gateway API endpoint URL (e.g., `http://localhost:8081`)
- Optional Bearer token

Or drag-and-drop a local `oas.json` file for offline/spec-only mode (useful for design and testing without a running gateway).

### Persistence
Configuration is stored in `localStorage` under key `tarcinapp_config`.

### Environment variable overrides
| Env var | Description |
|:---|:---|
| `TAPP_API_ENDPOINT` | Override gateway URL at build time |
| `TAPP_API_TOKEN` | Override token at build time |

---

## Development

```bash
cd tarcinapp-base-gui
npm install
npm run dev       # Vite dev server at http://localhost:5173
npm run build     # Production build
npm run preview   # Preview production build
```

In local development, the GUI connects directly to `entity-persistence-gateway` at `http://localhost:8081`, bypassing Nginx and Keycloak.

A bundled `oas.json` and `oas.yml` in the repo root serve as the development spec when no live gateway is available.

---

## Tech Stack

| Layer | Technology |
|:---|:---|
| Framework | React 18 |
| Routing | React Router v6 |
| Styling | Tailwind CSS v3 |
| Build | Vite 5 |
| Charts | Recharts 2 |
| HTTP | Native `fetch` API |

---

## Related Documents
- `00_SYSTEM_MANIFEST.md §3` — API surface and gateway transformation
- `11_COMPONENT_entity-persistence-gateway.md` — Dynamic OAS generation feature
- `22_CONCEPT_domain-projection.md` — How the gateway builds the domain-specific OAS
- `23_CONCEPT_query-language.md` — Query parameter reference
