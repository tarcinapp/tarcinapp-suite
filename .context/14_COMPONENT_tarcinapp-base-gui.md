# 14_COMPONENT_tarcinapp-base-gui.md

## Component Identity

**Repository:** `tarcinapp-base-gui`  
**Technology:** React 18.3.1 · Vite 5.3.4 · Tailwind CSS 3.4.6 · React Router DOM 6.26.0  
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

[`src/utils/oasParser.js`](../../tarcinapp-base-gui/src/utils/oasParser.js) is the core of the application. On setup/load, it:

1. Fetches `GET /openapi.json` from the configured Gateway, with the user's Bearer token and `Cache-Control: no-cache` / `cache: 'no-store'`.
2. Parses the spec to derive a `navItems` array and a raw `tagMap` lookup:

   - **Sidebar navigation**: one entry per OAS **tag** that owns a root collection endpoint (path with no `{param}` segments, `GET`, not ending in `/count`). Tags are sorted by `x-base-record-type` in the order: `entity → list → relation → entity-reaction → list-reaction`. Each tag becomes a URL slug via `slugify()` (lowercase, spaces→dashes, strip non-alphanumeric): tag `Books` → route `/r/books`.
   - **Data grid columns** (`deriveColumns()`): derived at render-time from the actual response data keys. System fields (`_id`, `_name`, `_kind`, `_visibility`, `_createdBy`, `_createdDateTime`, `_updatedDateTime`) are ordered first; custom fields follow alphabetically. `_validFromDateTime` and `_validUntilDateTime` are excluded from columns — they are shown as a row status indicator instead.
   - **GET response schema** (`getCollectionItemSchema()`): resolves the `200` response schema from the collection `GET`, following `array → items → $ref`. Exposes `itemSchemaProps` (all property definitions) and `availableFields` (all property names).
   - **POST body schema** (`getPostBodySchema()`): resolves the POST `requestBody → content['application/json'] → schema`, following `$ref`. Used to build create forms.
   - **Available actions**: `collectionMethods` (GET/POST/PATCH) and `itemMethods` (GET/PATCH/PUT/DELETE) are derived by scanning every operation tagged to each resource. Create/Edit/Delete buttons are rendered only when the corresponding methods appear.
   - **Traversal links** (`traversalSubResource()`): paths matching `/{param}/subResource` are collected per tag. Each becomes a child nav item at `/r/{tagSlug}/{subResource}`.

3. Also derives per-endpoint query parameter capabilities:
   - `hasSearch` (via `?s=` or `filter[where]` deep-object)
   - `hasPagination` (via native `?limit=`/`?skip=` or `filter[limit]`/`filter[skip]`)
   - `hasSet` (via `set` deep-object parameter)
   - `setSchemaProps` (per-key `{ isObject }` metadata for object-typed set values like `owners`, `viewers`, `audience`)
   - `hasFilterFields` / `hasFilterOrder` / `hasFieldset` / `hasFields`
   - `qEnumValues` (named query enum from `?q=` parameter)
   - `fieldsetEnumValues` (fieldset enum from `?fieldset=` parameter)
   - `hasValidityDates` (`_validFromDateTime` or `_validUntilDateTime` in schema)

---

## OAS Extensions Consumed by the GUI

The GUI reads the following `x-` extensions from the OAS spec at parse time:

### `x-base-record-type` (tag-level)

**Primary grouping mechanism.** Set on each tag definition in `spec.tags[*]`.

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

The GUI reads it from two locations for compatibility with different OAS serializers:
- `tagDef.extensions['x-base-record-type']` (standard extension map)
- `tagDef['x-base-record-type']` (flat property on the tag object)

Accepted values and their normalized forms:

| Raw OAS value | Normalized internal value |
|:---|:---|
| `entity` | `entity` |
| `list` | `list` |
| `relation` | `relation` |
| `entityReaction` or `entity-reaction` | `entity-reaction` |
| `listReaction` or `list-reaction` | `list-reaction` |

The normalized value determines the sort order in the sidebar and the structural group label. If the extension is absent, `oasParser.js` falls back to scanning the collection path string for known plural segment names (`entities`, `lists`, `relations`, `entity-reactions`, `list-reactions`). **Deployments that rename resource type path segments must set this extension**, or resources will appear in the sidebar without correct group ordering.

### No other `x-` extensions are currently consumed

The GUI does not currently read `x-kind-name`, `x-hierarchy-alias`, `x-query-parameters`, or any other custom extensions. All query capabilities, field lists, and traversal paths are derived purely from standard OAS path/operation/schema constructs.

---

## OAS as Security Boundary

The Gateway does not generate a generic public OAS spec. It generates a **personalized spec per caller**, shaped by the caller's identity, roles, and active OPA policies:

- Fields the caller **may not read** are physically removed from GET response schemas → the GUI does not render them as columns.
- Fields the caller **may not write** are physically removed from POST/PATCH schemas → the GUI does not include them in forms.
- Routes the caller **may not access** are absent from the spec entirely → the GUI renders no Create/Edit/Delete button for those operations.

**The GUI implements zero client-side access control logic.** It renders exactly what the spec describes. Changing a user's role or updating an OPA policy is immediately reflected in the UI on the next spec fetch — no frontend changes needed.

### Runtime Authorization Errors

Some policy decisions can only be evaluated at request time (e.g., "may not set `_validFromDateTime` to a past date"). When the gateway rejects such a request, the GUI catches the HTTP error response, extracts `body.error.message` or `body.message`, and displays it in a **Toast notification**. If error details (`body.error.details[]`) are present, they are listed below the main message.

---

## Two Deployment Modes

### 1. Generic mode (no domain projection)
Gateway exposes generic resource types directly. OAS contains paths like `/entities`, `/lists`, `/entity-reactions`. Sidebar shows five entries: Entities, Lists, Relations, Entity reactions, List reactions.

### 2. Domain projection active
Gateway overlays a business domain. OAS contains kind-alias paths like `/entities/books`, `/lists/shelves`. Sidebar shows domain-specific entries: Books, Shelves, Authors, etc. The `x-base-record-type` tag extension determines which structural group (entity/list/etc.) each entry belongs to for sidebar ordering.

---

## Data Fetching and State Management

### `AppContext.jsx`

[`src/context/AppContext.jsx`](../../tarcinapp-base-gui/src/context/AppContext.jsx) holds all global application state via React Context (`AppProvider`/`useApp()`):

| State field | Type | Description |
|:---|:---|:---|
| `endpoint` | `string \| null` | Gateway base URL (no trailing slash) |
| `token` | `string \| null` | Bearer token |
| `bypassCache` | `boolean` | When `true` (default), every data request sends `Cache-Control: no-cache` + `Pragma: no-cache` to force the gateway to bypass Redis cache. When `false`, sends `Cache-Control: public` (inert as a request directive, so gateway serves from cache). |
| `oasSpec` | `object \| null` | Parsed OpenAPI spec object |
| `oasStatus` | `'idle' \| 'loading' \| 'success' \| 'error'` | Spec fetch lifecycle state |
| `oasError` | `string \| null` | Error message if spec fetch failed |
| `isReady` | `boolean` | `true` when `oasStatus === 'success' && oasSpec !== null` |
| `serverOptions` | `{url, description}[]` | Parsed from `spec.servers[]` |

**Persistence:** `endpoint`, `token`, and `bypassCache` are persisted to `localStorage` under key `tarcinapp_config` as a JSON object. Environment variables `TAPP_API_ENDPOINT` / `TAPP_API_TOKEN` override stored config and are not re-persisted.

**Spec fetch:** `fetchOasSpec()` calls `GET {endpoint}/openapi.json` with `Cache-Control: no-cache` and the Bearer token. There is no automatic retry or polling — the spec is fetched once on connect. Users can re-fetch via the `retry()` callback (exposed through context) or by reconnecting.

**Offline / file upload:** `connectWithUploadedSpec({ spec, endpoint, token })` accepts a pre-parsed spec object. The endpoint is resolved from: provided value → stored value → `spec.servers[0].url`. This path bypasses the network entirely.

### `useResourceList.js`

[`src/hooks/useResourceList.js`](../../tarcinapp-base-gui/src/hooks/useResourceList.js) is a generic data-fetching hook:

```js
const { data, loading, error, refresh } = useResourceList(fetcher)
```

- `fetcher` is an async function passed by the caller (typically a closure over API client + URL).
- Uses a `requestSeqRef` counter to discard stale responses from superseded fetches (race-condition safe).
- **No polling.** Data is fetched once on mount (when `fetcher` identity changes), and manually on demand via `refresh()`.
- Returns `{ data: any[], loading: boolean, error: string | null, refresh: () => void }`.

### `apiClient.js`

[`src/services/apiClient.js`](../../tarcinapp-base-gui/src/services/apiClient.js) provides:

- `apiFetch(baseUrl, path, token, options)` — low-level fetch. Always `cache: 'no-store'`. Throws on network errors and non-2xx responses. Parses JSON responses; returns `null` for 204.
- `apiFetchWithMeta(...)` — same but also returns `{ data, headers, status, requestHeaders }`.
- `useApiClient()` hook — returns bound `{ get, getWithMeta, post, patch, put, del }` helpers using the current `endpoint` and `token` from context.

**Bypass-cache flag:** The `bypassCache` flag from `AppContext` controls the `Cache-Control` header sent on GET requests: `no-cache` (bypass) or `public` (allow cache). Only `get` and `getWithMeta` use this header; `post`, `patch`, `put`, `del` do not.

---

## How Forms Are Built

### Create Form (ResourcePage)

The create form in [`ResourcePage.jsx`](../../tarcinapp-base-gui/src/components/dynamic/ResourcePage.jsx) is built by:

1. Calling `getPostBodySchema(spec, collectionPath)` to get the POST request body schema.
2. Filtering to writable fields: `Object.entries(schema.properties).filter(([, prop]) => !prop.readOnly)`.
3. Each field descriptor has: `{ name, type, format, enum, required, description }`.
4. Fields are split into two sections:
   - **Primary**: `_name` (first, if present) + all non-managed fields (no leading `_`).
   - **Managed** (collapsible section): all `_`-prefixed fields except `_name`.

Field types and their rendered controls (`renderCreateField()`):

| OAS schema type/format | UI control |
|:---|:---|
| `boolean` | Toggle button showing `true` / `false` |
| `string` with `enum` | `<select>` dropdown |
| `integer` | `<input type="number" step="1">` |
| `number` | `<input type="number" step="any">` |
| `array` | Tag-input chip widget (Enter or comma to add, Backspace to delete last) |
| `object` | `<textarea rows=3>` expecting valid JSON string |
| `string` with `format: date-time` | `<input type="datetime-local">` |
| `string` (default) | `<input type="text">` |

**Required fields** are detected from `postSchema.required[]`. They are flagged in the field descriptor (`required: true`) and visually marked with `*` in the form label; the form submission does not block on client-side required validation — that is enforced by the gateway.

**Payload building** (`buildPayloadFromForm()`): boolean values are coerced to `true`/`false`; integer/number values are parsed via `parseInt`/`parseFloat`; empty strings and `null` values are omitted (not sent); arrays are passed as-is if non-empty; objects are parsed from JSON string.

### Edit Form (ItemEditModal)

[`src/components/ui/ItemEditModal.jsx`](../../tarcinapp-base-gui/src/components/ui/ItemEditModal.jsx) provides inline field editing via PATCH:

- Fetches the fresh record on mount via `GET {itemPath}`.
- Field edit is triggered by hovering a row and clicking the pencil icon.
- `FieldEditor` renders based on `schema?.type` and `schema?.format` from `navItem.itemSchemaProps`:

| Schema type/format | Editor |
|:---|:---|
| `boolean` | Three-button toggle: `true` / `false` / `null` (when `nullable`) |
| `_visibility` field with `['public','protected','private']` enum | Specialized segmented button (public/protected/private) |
| Other `enum` | `<select>` dropdown |
| `format: date-time` | `<input type="datetime-local">` |
| `integer` / `number` | `<input type="number">` |
| `array` | Chip list with add-item input (Enter key to commit) |
| `string` (default) | `<input type="text">` |

- Edits are **staged** in `pendingEdits` state. Multiple fields can be staged before submitting.
- A `Save N changes` bar appears when there are pending edits. Saving issues a single `PATCH {itemPath}` with the pending edits as the body, then re-fetches the record.
- Per-field **revert** is supported (restores the original server value).
- The form re-reads `navItem.itemMethods` to show/hide the Save and Delete buttons: `patch` in `itemMethods` → edit enabled; `delete` in `itemMethods` → Delete button shown.

---

## Column Type Rendering

[`DataGrid.jsx`](../../tarcinapp-base-gui/src/components/ui/DataGrid.jsx) has a `MANAGED_FIELDS_META` registry that declares `{ label, desc, type }` for every known `_`-prefixed field. The `type` property controls how each value is rendered in both compact (grid cell) and expanded (panel) views.

### Compact cell rendering (`renderCompactValue`)

| Field / Type | Rendering |
|:---|:---|
| `null` / `undefined` | Em dash `—` (muted gray) |
| `_visibility` | Colored text: `public` = emerald, `protected` = amber, `private` = rose |
| `_recordType` | Violet text |
| `type: array` | First 3 items comma-joined, `+N` overflow indicator (sky blue monospace) |
| `type: datetime` | Relative time (`5m ago`, `3d ago`) with absolute timestamp on hover (violet monospace) |
| `type: object` | `{…}` with full JSON on hover (emerald monospace) |
| `type: number` | Sky blue monospace |
| `string` (long > 32 chars) | Truncated: first 14 + `…` + last 8 chars, full value on hover |
| `string` (short) | Gray monospace |

### Expanded panel rendering (`ManagedFieldValue`)

| Field / Type | Rendering |
|:---|:---|
| `null` | Italic `null` (light gray) |
| `type: array` | Empty → italic `empty array`; otherwise chip badges (gray background, monospace) |
| `type: datetime` | Relative time with absolute ISO timestamp as title attribute |
| `type: object` | Formatted JSON `<pre>` block with monospace font |
| `type: number` | Sky blue monospace |
| `_visibility` | Colored badge chip: emerald / amber / rose |
| `_recordType` | Violet badge chip |
| `string` | Gray monospace, full value |

### Row status indicator

`_validFromDateTime` and `_validUntilDateTime` are **excluded from data grid columns** but drive a color-coded row status indicator (`computeRowStatus()`):

| Status | Condition | Shadow color |
|:---|:---|:---|
| `active` | `_validFromDateTime` is past AND (`_validUntilDateTime` is null OR in the future) | `#10b981` (emerald) |
| `pending` | `_validFromDateTime` is null or in the future | `#fbbf24` (amber) |
| `expired` | `_validUntilDateTime` is in the past | `#f43f5e` (rose) |

### `tapp://` URI rendering

Values that are `tapp://` URIs (format: `tapp://{hostname}/{recordType}/{recordId}`) are detected by `isTappUri()` / `isResolvableValue()`. These are rendered as interactive **TappRefChip** badges that show the record type label (`Entity`, `List`, `Entity Reaction`, `List Reaction`) and support inline record resolution (fetching and displaying the referenced record inline).

### Access control fields (`_ownerUsers`, `_ownerGroups`, `_viewerUsers`, `_viewerGroups`)

These are classified as `ACCESS_FIELDS` and rendered as array chips in the expanded panel. Each item in the array is shown as a separate monospace chip. `_ownerUsersCount`, `_ownerGroupsCount`, `_viewerUsersCount`, `_viewerGroupsCount` are rendered as numbers (sky blue monospace).

### System field display order in expanded panel

```
_id → _name → _slug → _kind → _visibility → _version → _recordType →
_entityId → _listId →
_createdBy → _createdDateTime → _lastUpdatedDateTime → _lastUpdatedBy →
_validFromDateTime → _validUntilDateTime →
_ownerUsers → _ownerGroups → _ownerUsersCount → _ownerGroupsCount →
_viewerUsers → _viewerGroups → _viewerUsersCount → _viewerGroupsCount →
_parentsCount → _idempotencyKey →
_fromMetadata → _toMetadata → _relationMetadata
```

---

## Pages (OAS-Driven)

| Component | Route | Description |
|:---|:---|:---|
| `ResourcePage` | `/r/:tagSlug` | Paginated data grid for a collection. Status/visibility filters (`set[]` deep-object), `_name` search, fieldset selector, named query dropdown, field retrieval/display controls, sort controls, visual WHERE filter builder, custom query params panel, query info panel (request/response headers, duration), cURL export, inline create modal, inline delete with confirmation. |
| `ItemPage` | `/r/:tagSlug/item/:itemId` | Single-item detail view. Inline field editing via PATCH (all schema-declared fields). Delete with confirmation. |
| `TraversalPage` | `/r/:tagSlug/:subResource` | Sub-resource view. Resolves traversal path templates from the spec (e.g., `/books/{id}/chapters`). |
| `DashboardPage` | `/` | Overview with resource stat cards derived from count endpoints. |
| `SetupScreen` | _(shown when no spec loaded)_ | Enter Gateway URL + Bearer token to connect live, or drag-and-drop a local OAS JSON file for offline use. |

---

## SetupScreen — Connection and Offline Mode

[`src/components/setup/SetupScreen.jsx`](../../tarcinapp-base-gui/src/components/setup/SetupScreen.jsx) is shown when no spec is loaded (`!isReady`).

### Live connection mode
The user provides:
- **Endpoint mode**: `local` (pre-fills `http://127.0.0.1:8081`) or `custom` (free-text URL).
- **Bearer token** (optional): The setup screen **validates the token client-side** before submitting. It decodes the JWT (base64url decode of the header and payload segments), checks structural validity, and checks `payload.exp` against the current time. If the token is expired or malformed, an error is shown inline and the Connect button is disabled.
- **Username and roles** parsed from the JWT are displayed as a preview so the user can confirm the right identity is being used.

On submit, `AppContext.connect(endpoint, token)` is called, which saves the credentials to `localStorage` and fetches the OAS spec.

### Offline / drag-and-drop mode
The setup screen accepts a **drag-and-drop** of a local `.json` file (or click-to-browse via a hidden `<input type="file">`). The file is read as text, parsed as JSON, and passed to `AppContext.connectWithUploadedSpec({ spec, endpoint, token })`. The GUI then builds the full interface from the local spec without making any network request to fetch the spec.

Use cases for offline mode:
- Previewing or designing a domain projection without a running gateway.
- Sharing a spec snapshot for review or debugging.
- Testing form layouts for a new resource kind before deployment.

When a spec is uploaded, the endpoint is resolved from: (1) the typed URL field, (2) the stored endpoint, (3) `spec.servers[0].url`. Data operations (GET/POST/PATCH/DELETE) will still call the configured endpoint — only the spec itself is local.

---

## Query Parameters and Fieldsets

### Simplified parameters (gateway-added)
The GUI detects which parameters are available per endpoint and uses them:

| Feature | Simplified param | Fallback |
|:---|:---|:---|
| Search | `?s=value` | `filter[where][_name][regexp]=.*value.*` |
| Pagination | `?limit=N&skip=M` | `filter[limit]=N&filter[skip]=M` |
| Sorting | _(no simplified form)_ | `filter[order]=field dir` (multi-sort: indexed `filter[order][0]=...`) |
| Field projection | `?fields=f1,f2` | `filter[fields][f1]=true` / `filter[fields][f1]=false` |
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

### Set parameter (status and visibility filters)
The `set` parameter is a deep-object query param. `setSchemaProps` is derived at parse time from the `set` parameter's schema properties, with each key mapped to `{ isObject: boolean }`. Object-typed set values (e.g., `owners`, `viewers`, `audience`) trigger a secondary input for `userIds`/`groupIds`. Non-object set values (e.g., `actives`, `pendings`, `expireds`, `publics`, `privates`, `protecteds`, `roots`) are boolean flags.

The GUI pre-populates the JWT `sub` claim into owner/viewer user ID inputs when available.

---

## Setup and Configuration

### Persistence
Configuration is stored in `localStorage` under key `tarcinapp_config` as `{ endpoint, token, bypassCache }`.

### Environment variable overrides
| Env var | Description |
|:---|:---|
| `TAPP_API_ENDPOINT` | Override gateway URL at build time |
| `TAPP_API_TOKEN` | Override token at build time |

Environment-provided values take priority over `localStorage` and are not written back to storage.

---

## Project Structure

```
src/
├── App.jsx                        ← Root component, router setup (React Router v6)
├── context/
│   ├── AppContext.jsx              ← Global state: spec, endpoint, token, bypass-cache flag
│   └── ThemeContext.jsx            ← Dark/light theme toggle
├── utils/
│   ├── oasParser.js               ← Parses OAS → navItems, column defs, pagination keys, tapp:// helpers
│   ├── filterExpr.js              ← FilterExpr AST builder (set/status/visibility filters)
│   └── whereFilterExpr.js         ← WHERE clause filter AST builder
├── services/
│   └── apiClient.js               ← Generic fetch-based HTTP client (GET/POST/PATCH/DELETE)
├── hooks/
│   └── useResourceList.js         ← Data-fetching hook with loading/error/refresh state
├── components/
│   ├── dynamic/                   ← OAS-driven pages
│   │   ├── ResourcePage.jsx       ← Collection view (data grid + create/filter/sort/query)
│   │   ├── ItemPage.jsx           ← Single-item detail view
│   │   └── TraversalPage.jsx      ← Sub-resource traversal view
│   ├── layout/                    ← App shell
│   │   ├── AppLayout.jsx
│   │   ├── Sidebar.jsx            ← OAS-tag-driven navigation
│   │   └── TopBar.jsx
│   ├── setup/
│   │   └── SetupScreen.jsx        ← Connection/offline spec screen with JWT validation
│   └── ui/                        ← Shared components
│       ├── DataGrid.jsx           ← Managed-field-aware data grid with row expansion
│       ├── ItemEditModal.jsx      ← Inline PATCH edit modal
│       ├── VisualFilterBuilder.jsx   ← Set/status/visibility filter builder
│       ├── VisualWhereFilterBuilder.jsx ← WHERE clause filter builder
│       ├── StatCard.jsx
│       ├── Badges.jsx
│       ├── Toast.jsx
│       └── ConfirmDialog.jsx
├── data/
│   └── navigation.js              ← Static nav helpers
└── pages/
    └── DashboardPage.jsx          ← Overview with resource stat cards
```

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

A bundled `oas.json` in the repo root serves as the development spec when no live gateway is available (drag-and-drop it into the SetupScreen).

---

## Tech Stack

| Layer | Technology | Exact version |
|:---|:---|:---|
| Framework | React | 18.3.1 |
| DOM binding | React DOM | 18.3.1 |
| Routing | React Router DOM | 6.26.0 |
| Styling | Tailwind CSS | 3.4.6 |
| Build | Vite | 5.3.4 |
| Charts | Recharts | 2.12.7 |
| HTTP | Native `fetch` API | — |
| Type hints | `@types/react` | 18.3.3 |
| CSS processing | PostCSS + Autoprefixer | 8.4.40 / 10.4.19 |

---

## Known Limitations

The following capabilities are **not supported** by the current GUI. When a user or AI agent needs these, direct them to direct API calls, a custom UI, or backend tooling:

| Limitation | Detail |
|:---|:---|
| **No file/binary upload** | The create and edit forms only handle scalar/array/object JSON values. There is no `<input type="file">` or multipart form support. |
| **No complex nested object editing** | Fields of type `object` are edited as a raw JSON textarea. There is no nested form builder for deeply structured sub-schemas. |
| **No real-time / push updates** | `useResourceList` does not poll. There is no WebSocket or SSE integration. Data is only refreshed on user-triggered actions (page navigation, explicit refresh). |
| **No multi-record batch edit** | PATCH operations target one record at a time through `ItemEditModal`. The collection-level `PATCH /collection` (update-all) is not exposed as a bulk edit UI. |
| **No schema-driven validation on create** | Client-side form validation is limited to type coercion (`parseInt`, `parseFloat`, JSON parse for objects). `required` fields are flagged but not blocked. All real validation is enforced by the gateway. |
| **No cross-resource lookups in forms** | Fields like `_listId`, `_entityId`, `_parents` are plain text inputs in the create form. There is no record picker/search dropdown to select related records. |
| **No OAS schema version detection** | The parser assumes OpenAPI 3.x. OpenAPI 2.x (Swagger) specs are not supported. |
| **No spec refresh without reconnect** | The OAS spec is loaded once per session. If the gateway's spec changes (e.g., after a role change or policy update), the user must reconnect to get the updated spec. |
| **No offline data operations** | In drag-and-drop offline mode, the spec is local but all data requests (GET/POST/PATCH/DELETE) still require a live gateway at the configured endpoint. A fully offline/mock data mode does not exist. |
| **No sort persistence across navigation** | Sort order, active filters, and field selections are held in component state and reset when the user navigates away from a `ResourcePage`. |

---

## Related Documents
- `00_SYSTEM_MANIFEST.md §3` — API surface and gateway transformation
- `11_COMPONENT_entity-persistence-gateway.md` — Dynamic OAS generation feature
- `22_CONCEPT_domain-projection.md` — How the gateway builds the domain-specific OAS
- `23_CONCEPT_query-language.md` — Query parameter reference
