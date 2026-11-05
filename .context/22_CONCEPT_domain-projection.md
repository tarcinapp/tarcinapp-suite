# 22_CONCEPT_domain-projection.md

## Overview

Domain projection is the mechanism by which the Gateway transforms the generic Tarcinapp API (`/entities`, `/lists`, etc.) into a domain-specific API (`/books`, `/shelves`, `/book-reviews`, etc.) — entirely through configuration, without writing any backend code.

A single Tarcinapp deployment can simultaneously expose both a generic surface and a domain-specific surface, or lock down to domain-only by toggling the generic routes off.

---

## The Problem It Solves

Without domain projection, your API looks like:
```
GET /entities?filter[where][_kind]=book
POST /entities  (with {"_kind":"book", ...} in the body)
GET /entities/{id}/children?filter[where][_kind]=chapter
GET /lists/{id}/entities?filter[where][_kind]=book
```

With domain projection configured, the same operations become:
```
GET /books
POST /books  (no _kind needed)
GET /books/{id}/chapters
GET /shelves/{id}/books
```

The client doesn't know about `_kind`, `filter[where]`, or LoopBack syntax. They see a clean, domain-native REST API.

---

## How It Works: Kind Alias Paths

### Basic Configuration

Domain projection is configured via `app.oas.controllers.<type>.aliases` in the gateway:

```yaml
app:
  oas:
    controllers:
      entities:
        aliases:
          - alias: books       # ← the URL path segment (/entities/books)
            kind: book         # ← the _kind value to inject/filter
            schema: '...'      # ← optional JSON Schema for validation
```

Or via environment variables (properties format):
```properties
app.oas.controllers.entities.aliases[0].alias=books
app.oas.controllers.entities.aliases[0].kind=book
app.oas.controllers.entities.aliases[0].schema={"$schema":"...","type":"object",...}
```

### Record Type Routing

The gateway supports aliases for all five record types. **The record type is determined by which controller the alias is registered with** — not from any flag on the alias itself. The alias is configured under `app.oas.controllers.<controllerKey>.aliases`, and the controller key determines the backend path:

| Controller key | Backend base path | Use Case |
|---|---|---|
| `entities` | `/entities` | Primary domain objects (Products, Orders, Books) |
| `lists` | `/lists` | Collections and groupings (Shelves, Categories, Playlists) |
| `relations` | `/relations` | Directed links between records (Assignments, Follows) |
| `entityReactions` | `/entity-reactions` | User interactions on entities (Likes, Reviews) |
| `listReactions` | `/list-reactions` | User interactions on lists (Comments, Ratings) |

When a request arrives at `/api/v1/entities/books`, the gateway knows to route it to the `entities` controller because the `books` alias was declared under `controllers.entities`. It then:

1. Resolves `books` → `_kind=book` via `KindResolution` filter
2. Rewrites the path to the generic EPS endpoint (`/entities`)
3. Injects or filters by `_kind=book` depending on the HTTP method
4. Applies kind-specific middleware (schema validation, rate limits, timeouts)

### URL Path Structure

Kind alias paths are placed **under** the controller base path, not at the root. The default structure is:

```
/api/v1/entities/books      ← entity alias "books"
/api/v1/lists/shelves       ← list alias "shelves"
/api/v1/relations/memberships ← relation alias "memberships"
```

This can be customized via `app.inbound.controllerBasePaths`. For example, setting `entities: items` moves all entity aliases to `/api/v1/items/books`, `/api/v1/items/orders`, etc.

---

## Four Transformation Steps

### Step 1: Path Rewriting

The gateway rewrites the incoming kind-alias path to the generic EPS endpoint before proxying. This is done at the route level via static `RewritePath` configuration:

**Collection routes:**
```
GET  /api/v1/entities/books        →  GET  /entities
POST /api/v1/entities/books        →  POST /entities
```

**Single-item routes:**
```
GET    /api/v1/entities/books/{id} →  GET    /entities/{id}
PATCH  /api/v1/entities/books/{id} →  PATCH  /entities/{id}
PUT    /api/v1/entities/books/{id} →  PUT    /entities/{id}
DELETE /api/v1/entities/books/{id} →  DELETE /entities/{id}
```

The `{id}` path variable is preserved verbatim. EPS handles it as a standard record ID — the gateway adds no additional kind filter for single-item GET/PATCH/DELETE since the record's `_kind` was set at creation time and is enforced by EPS.

**Count routes:**
```
GET /api/v1/entities/books/count   →  GET /entities/count?filter[where][_kind]=book
```

Count routes are treated as collection-style GET operations and receive the `_kind` query injection (Step 3) just like regular collection GETs.

### Step 2: `_kind` Injection into Request Body

For **POST** (create), **PUT** (replace), and **PATCH** (partial update) — the `PlaceKindNameIntoPayload` filter adds `_kind` to the payload before forwarding to EPS:

```json
// Client sends:
POST /entities/books
{ "_name": "War and Peace", "author": "Tolstoy" }

// Gateway sends to EPS:
POST /entities
{ "_name": "War and Peace", "author": "Tolstoy", "_kind": "book" }
```

**For `PUT` (replace), this is critical:** A PUT replaces the entire record. If the client accidentally omits `_kind`, the record in the database would lose its kind classification. `PlaceKindNameIntoPayload` always injects the `_kind` derived from the route alias, preventing the caller from accidentally replacing to a different kind or removing the kind entirely.

This filter only applies on kind-alias routes — generic routes like `PUT /entities/{id}` do not have it, so callers on the generic surface must supply `_kind` themselves.

### Step 3: `_kind` Query Filter for GET

For **GET** collection requests and **count** requests — the `ConvertKindAliasToKindQuery` filter appends the `_kind` filter to the query string:

```
GET /entities/books?limit=10
→ GET /entities?filter[where][_kind]=book&filter[limit]=10

GET /entities/books/count?filter[where][author]=Tolstoy
→ GET /entities/count?filter[where][_kind]=book&filter[where][author]=Tolstoy
```

If the caller has already supplied a `filter[where]`, the `_kind` constraint is merged in safely (the existing where clauses are preserved, not overwritten).

### Step 4: Hierarchy Alias Resolution

For domain hierarchy routes (`/books/{id}/chapters`), the `HierarchyKindAliasResolver` filter resolves the hierarchy alias to a generic accessor and injects the child kind filter:

```
GET  /entities/books/{id}/chapters
  →  GET  /entities/{id}/children?filter[where][_kind]=chapter

POST /entities/books/{id}/chapters
  →  POST /entities/{id}/children
     (body receives _kind=chapter via PlaceKindNameIntoPayload)
```

The `hierarchyAlias` → child `_kind` mapping is configured in the `children` array of the parent alias:

```yaml
app:
  oas:
    controllers:
      entities:
        aliases:
          - alias: books
            kind: book
            children:
              - alias: chapters
                kind: chapter
```

The URL segment used as the hierarchy accessor defaults to `children` / `parents` but can be customized via `app.inbound.controllerBasePaths.defaultChildrenAccessor`.

### Step 5: Through-Route Alias Resolution (Cross-Controller Traversal)

For cross-controller traversal (e.g., accessing books inside a shelf, or reviews for a book), the `ThroughKindAliasResolver` filter handles the mapping. This is distinct from hierarchical aliases — "through" means a different controller type, not a parent-child tree within the same controller.

```
GET /lists/shelves/{id}/entities/books
  →  GET /lists/{id}/entities?filter[where][_kind]=book

POST /entities/books/{id}/reactions/reviews
  →  POST /entities/{id}/reactions
     (body receives _kind=review via PlaceKindNameIntoPayload)

GET /entities/books/{id}/reactions/reviews
  →  GET /entities/{id}/reactions?filter[where][_kind]=review
```

Path rewriting for through routes is handled statically by `RewritePath` at the route level. `ThroughKindAliasResolver` is responsible only for:
1. Looking up the through alias (`books`, `reviews`) in the parent alias's `through` config
2. Injecting `_kind` into the query (GET) or body (POST/PUT/PATCH)
3. Setting the correct schema key for subsequent validation

---

## Include Alias Projection

When using LoopBack's `filter[include]` to eager-load related records, domain projection extends to include clauses as well. This allows clients to use domain aliases in include relations instead of generic relation names.

### Request Phase: `ConvertDomainIncludeAliasToGenericRelation`

When a client requests an include with a domain alias name, the gateway rewrites it to the generic backend relation plus a `_kind` scope filter.

**Before (client request):**
```
GET /lists/shelves/{id}?filter[include][0][relation]=books
```

**After (gateway rewrites to EPS):**
```
GET /lists/{id}?filter[include][0][relation]=_entities&filter[include][0][scope][where][_kind]=book
```

If the include scope already has a `where` clause, the gateway merges safely using `and` to avoid overwriting caller constraints:
```
// Client:
filter[include][0][relation]=books&filter[include][0][scope][where][author]=Tolstoy

// Gateway rewrites to:
filter[include][0][relation]=_entities
  &filter[include][0][scope][where][and][0][_kind]=book
  &filter[include][0][scope][where][and][1][author]=Tolstoy
```

### Response Phase: `ProjectDomainIncludeAliasInResponse`

After EPS returns the response, the gateway renames the embedded `_entities` field back to the alias the client requested.

**EPS response:**
```json
{
  "_id": "shelf-abc",
  "_name": "My Favorites",
  "_entities": [
    { "_id": "book-1", "_kind": "book", "_name": "War and Peace" },
    { "_id": "book-2", "_kind": "book", "_name": "Anna Karenina" }
  ]
}
```

**Gateway returns to client:**
```json
{
  "_id": "shelf-abc",
  "_name": "My Favorites",
  "books": [
    { "_id": "book-1", "_kind": "book", "_name": "War and Peace" },
    { "_id": "book-2", "_kind": "book", "_name": "Anna Karenina" }
  ]
}
```

**Filter chain ordering:** Request normalization (`ConvertDomainIncludeAliasToGenericRelation`) runs before query scoping filters (like `AddSetsToQuery`) so that downstream filters operate on the normalized generic query format. Response projection (`ProjectDomainIncludeAliasInResponse`) runs in the response modifier stage before final field filtering.

---

## Per-Kind Configuration

Beyond path aliasing, each kind alias can have independent settings for validation, rate limiting, request size, and timeout:

```yaml
app:
  oas:
    controllers:
      entities:
        aliases:
          - alias: books
            kind: book
            description: Book catalog management
            singular: book         # Optional explicit singular (for irregular plurals)
            schema: |
              {
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "properties": {
                  "author": { "type": "string" },
                  "isbn":   { "type": "string" },
                  "genre":  { "type": "string" },
                  "pages":  { "type": "integer" }
                },
                "required": ["author"]
              }
            maxRequestSize: 5KB
            rateLimiter:
              replenishRate: 5
              burstCapacity: 10
            timeout: 30000
```

### `throughRecords` — Cross-Controller Access from This Kind

The `through` key defines which records of a *different type* can be accessed via traversal through this kind alias. Each sub-key corresponds to a through-relationship direction:

```yaml
- alias: books
  kind: book
  through:
    reactions:                       # Access entity-reactions through books
      - alias: reviews
        kind: review
        description: Reader reviews for a book
        schema: |
          {"type":"object","properties":{"rating":{"type":"integer","minimum":1,"maximum":5},"comment":{"type":"string"}},"required":["rating"]}
        routes:
          createReactionByEntityId:   # Per-route schema override (highest priority)
            schema: |
              {"type":"object","properties":{"rating":{"type":"integer","minimum":1,"maximum":5},"comment":{"type":"string"}},"required":["rating","comment"]}
    lists:                           # Access lists that contain this entity (GET only)
      - alias: shelves
        kind: bookshelf
        description: Bookshelves that contain this book
```

For lists aliases, the `through` key can contain `entities` and `reactions` sub-keys:

```yaml
- alias: shelves
  kind: bookshelf
  through:
    entities:                        # Access entities within this list (full CRUD)
      - alias: books
        kind: book
    reactions:                       # Access list-reactions on this list
      - alias: shelf-comments
        kind: shelf-comment
```

**Available through sub-keys by controller:**

| Controller | `through` sub-key | Supported operations |
|---|---|---|
| `entities` | `reactions` | POST, GET, PATCH, DELETE |
| `entities` | `lists` | GET only |
| `lists` | `entities` | POST, GET, PATCH, DELETE |
| `lists` | `reactions` | POST, GET, PATCH, DELETE |

### `hierarchyAlias` and `hierarchyName` (child hierarchy configuration)

To expose parent-child hierarchy as domain routes, use the `children` array:

```yaml
- alias: books
  kind: book
  children:
    - alias: chapters          # → /entities/books/{id}/chapters
      kind: chapter
      description: Chapters within a book
      schema: |
        {"type":"object","properties":{"_name":{"type":"string"},"pageCount":{"type":"integer"}}}
      routes:
        createEntityChild:     # Hierarchy-route schema (most specific)
          schema: |
            {"type":"object","properties":{"_name":{"type":"string"},"chapterNumber":{"type":"integer","minimum":1}},"required":["_name","chapterNumber"]}
```

This creates the following paths:
```
GET    /entities/books/{id}/chapters      → GET  /entities/{id}/children?filter[where][_kind]=chapter
POST   /entities/books/{id}/chapters      → POST /entities/{id}/children  (body gets _kind=chapter)
GET    /entities/books/{id}/parents       → GET  /entities/{id}/parents
```

The URL segment `chapters` replaces the generic `/children`. The `parents` accessor is always generated alongside children (if the child kind can also traverse upward).

---

## JSON Schema Validation Per Kind

When a `schema` is configured for a kind, the gateway validates POST and PUT request bodies against it using JSON Schema draft 2020-12.

For PATCH, only the fields present in the patch body are validated (partial validation — `required` at root level is not enforced for PATCH).

Schema resolution uses a **priority cascade** — most specific wins:

1. **Through-route schema** — `through.<type>[].routes.<routeId>.schema`
2. **Through-level schema** — `through.<type>[].schema`
3. **Hierarchy-route schema** — `children[].routes.<routeId>.schema`
4. **Hierarchy-level schema** — `children[].schema`
5. **Route-level schema** — `aliases[].routes.<routeId>.schema`
6. **Kind-level schema** — `aliases[].schema`

**Validation failure response (422):**
```json
{
  "error": {
    "name": "ValidationError",
    "status": 422,
    "message": "The request is not valid.",
    "details": [
      {
        "code": "1029",
        "field": "$.author",
        "message": "$.author: string found, integer expected"
      }
    ]
  }
}
```

Managed fields (`_name`, `_visibility`, etc.) are always validated by the system — you don't need to include them in the schema. The gateway merges managed-field constraints with your domain schema at runtime.

---

## Dynamic OpenAPI Generation (Domain View)

When domain projection is active, the gateway generates an OpenAPI spec that reflects the domain surface, not the generic one. The spec is produced dynamically at request time by fetching the backend EPS spec and transforming it.

### Domain-Only Spec When Generic Routes Are Disabled

When `APP_ROUTES_TAGS_DISABLED=generic` (or equivalent YAML), all 65 base generic routes are suppressed. The generated OAS spec will then contain **only** the domain kind-alias paths. A client fetching `/openapi.json` will see:

```
GET  /entities/books        (not GET /entities)
POST /entities/books        (not POST /entities)
GET  /entities/books/{id}   (not GET /entities/{id})
...
```

There is no trace of the raw `/entities` surface in the spec — the domain view is the only view.

### Operation ID Rewriting

The OAS generator automatically rewrites operation IDs from generic names to domain-specific names by singularizing the alias:

| Generic operationId | Domain operationId (alias=books) |
|---|---|
| `createEntity` | `createBook` |
| `findEntities` | `findBooks` |
| `findEntityById` | `findBookById` |
| `updateEntityById` | `updateBookById` |
| `replaceEntityById` | `replaceBookById` |
| `deleteEntityById` | `deleteBookById` |
| `countEntities` | `countBooks` |

Singularization uses a heuristic (e.g. `books` → `book`, `categories` → `category`). For irregular plurals (e.g. `heroes` → `heroe` would be wrong), configure `singular: hero` explicitly on the alias.

### Schema Merging in OAS Responses

The OAS response schema for domain endpoints is a **merge** of the base managed-fields schema with the kind-specific domain schema. This means `GET /entities/books` in the spec shows all managed fields (`_id`, `_name`, `_kind`, `_visibility`, `_ownerUsers`, `_createdAt`, etc.) **plus** your domain-specific fields (`author`, `isbn`, `genre`, `pages`).

Three schema variants are generated per kind to match the operation semantics:

| Schema variant | Used by | `required` fields behavior |
|---|---|---|
| `{Alias}` (e.g. `Books`) | GET response, PUT request/response | Managed + user-config required fields merged |
| `New{Alias}` (e.g. `NewBooks`) | POST request | Base required fields dropped (gateway provides defaults); user-config required fields (`author`) preserved |
| `Patch{Alias}` (e.g. `PatchBooks`) | PATCH request | All required removed — every field optional for partial update |

### Tag Renaming

Each kind alias becomes an OAS **tag** instead of the generic resource type:
- `Books` (not `Entities`)
- `Shelves` (not `Lists`)
- `Book Reviews` (not `Entity reactions`)

### `x-base-record-type` Extension

The generated OAS includes a custom extension on each tag that tells the GUI which structural type it maps to:
```json
{
  "tags": [
    {
      "name": "Books",
      "x-base-record-type": "entity"
    },
    {
      "name": "Shelves",
      "x-base-record-type": "list"
    }
  ]
}
```

### Role-Based Schema Pruning

The OAS spec is personalized per caller. OPA policies determine which fields each caller cannot see, create, or modify. Forbidden fields are **physically removed** from schemas:
- A `visitor` calling `GET /openapi.json` will not see `_visibility` in the Books GET response schema
- A `member` calling the same endpoint will not see `_ownerUsers` in the Books POST request schema

This makes the OAS spec the **single source of truth for what the caller can do** — which is exactly how `tarcinapp-base-gui` uses it.

### Caching

The generated OAS is cached at two levels: an in-process Caffeine cache (L1, ~100 entries, sub-millisecond) and a distributed Redis cache (L2, 15-minute TTL by default). Cache keys are deterministic hashes of the caller's permission-affecting JWT claims. Users with identical permission sets share a cached spec. After a config change, wait for TTL expiry or flush the Redis cache to see the updated spec.

---

## Route Toggles and Domain-Only Exposure

By default, the gateway exposes both:
- Generic routes: `GET /api/v1/entities`, `POST /api/v1/entities`, etc.
- Kind alias routes: `GET /api/v1/entities/books`, `POST /api/v1/entities/books`, etc.

### Route Tag Taxonomy

Routes are tagged along multiple dimensions. The most important tags for domain-projection control:

| Tag | Routes affected | Count |
|---|---|---|
| `generic` | All base generic routes (no kind-alias path resolution) | 65 |
| `kind-alias` | All kind-alias routes | 73 |
| `write` | POST, PUT, PATCH operations that modify data | 64 |
| `destructive` | DELETE operations | 16 |
| `read-only` | GET operations that don't modify data | 59 |
| `bulk` | Bulk update-all operations | 10 |
| `by-id` | Single-record operations requiring an ID | 40 |
| `through` | Cross-controller traversal routes | 26 |
| `hierarchical` | Parent-child hierarchy routes | 32 |

Tags are configured in `app.toggles.tags.off` (blacklist) or `app.toggles.tags.on` (whitelist). See [`75-FEATURE-ROUTE-TOGGLES.md`](../../entity-persistence-gateway/.context/75-FEATURE-ROUTE-TOGGLES.md) for evaluation order and precedence rules.

### Useful Toggle Combinations

| Goal | Configuration |
|---|---|
| **Domain-only API** (hide generic surface) | `tags.off: [generic]` |
| **Read-only public API** (no writes, any surface) | `tags.off: [write, destructive]` |
| **Domain-only read-only** | `tags.off: [generic, write, destructive]` |
| **No delete ever** | `tags.off: [destructive]` |
| **No bulk operations** | `tags.off: [bulk]` |
| **Disable entire relations controller** | `controllers.off: [relations]` |
| **Whitelist specific routes only** | `routes.on: [findEntitiesByKindAlias, findEntityByIdByKindAlias]` |
| **Disable delete for kind-alias only** | `routes.off: [deleteEntityByIdByKindAlias]` |

### Disabling the Generic Surface

To expose **only** the domain surface (clean domain-native API):

```yaml
app:
  toggles:
    tags:
      off:
        - generic
```

Or environment variable:
```bash
APP_TOGGLES_TAGS_OFF_0=generic
```

This disables all 65 Base Generic routes, leaving only Kind Alias routes and utility routes active. The OAS spec will only contain domain paths.

Individual routes can also be disabled by route ID:
```yaml
app:
  toggles:
    routes:
      off:
        - updateAllEntities
        - updateAllLists
```

---

## Multi-Kind Example: Books Application

A books domain might configure:

```yaml
app:
  oas:
    controllers:
      entities:
        aliases:
          - alias: books
            kind: book
            schema: |
              {"type":"object","properties":{"_name":{"type":"string"},"author":{"type":"string"},"isbn":{"type":"string"}},"required":["_name"]}
            children:
              - alias: chapters
                kind: chapter
            through:
              reactions:
                - alias: reviews
                  kind: review
              lists:
                - alias: shelves
                  kind: bookshelf
      lists:
        aliases:
          - alias: shelves
            kind: bookshelf
            through:
              entities:
                - alias: books
                  kind: book
      entityReactions:
        aliases:
          - alias: reviews
            kind: review
```

This creates the following API surface:
```
GET  /api/v1/entities/books                          ← list all books
POST /api/v1/entities/books                          ← create a book
GET  /api/v1/entities/books/{id}                     ← get a book
PATCH /api/v1/entities/books/{id}                    ← update a book
GET  /api/v1/entities/books/{id}/chapters            ← get sub-chapters (hierarchy)
POST /api/v1/entities/books/{id}/chapters            ← create a chapter
GET  /api/v1/entities/books/{id}/reactions/reviews   ← reviews for a book
POST /api/v1/entities/books/{id}/reactions/reviews   ← add a review
GET  /api/v1/entities/books/{id}/lists/shelves       ← shelves containing a book (GET only)
GET  /api/v1/lists/shelves                           ← list all shelves
POST /api/v1/lists/shelves                           ← create a shelf
GET  /api/v1/lists/shelves/{id}/entities/books       ← books in a shelf
```

All managed by the gateway configuration alone — no EPS code changes, no schema migrations.

---

## Relation Kind Aliases

Relations (ListEntityRelation) can also have kind aliases:

```yaml
app:
  oas:
    controllers:
      relations:
        aliases:
          - alias: book-shelf-memberships
            kind: book-shelf-membership
```

This exposes:
```
GET  /api/v1/relations/book-shelf-memberships
POST /api/v1/relations/book-shelf-memberships
GET  /api/v1/relations/book-shelf-memberships/{id}
...
```

---

## Troubleshooting Domain Projection

| Symptom | Likely Cause | Resolution |
|---|---|---|
| **404 on `/entities/books`** | Alias not configured, or gateway not restarted after config change | Verify `app.oas.controllers.entities.aliases[0].alias=books` exists in config; restart/reload the gateway |
| **422 ValidationError on POST** | Request body doesn't match the kind's JSON Schema | Check the schema by inspecting the OAS `POST /entities/books` request body definition — the error `details[].field` shows the failing path |
| **Wrong `_kind` in database** (records stored as wrong kind) | `PlaceKindNameIntoPayload` not applying | Confirm the request is hitting a kind-alias route (e.g. `POST /entities/books`), not a generic route (`POST /entities`) — generic routes do not inject `_kind` automatically |
| **OAS doesn't show domain paths** | Generic routes not disabled, or OAS cache is serving a stale spec | Set `tags.off: [generic]` to suppress the generic surface; flush the Redis OAS cache (`app.oas.orchestrator.cache.ttl`) or wait for TTL expiry (default 15 min) |
| **Operation IDs still say `createEntity`** | Alias not configured in `app-oas.yml`, OAS is using the raw backend spec | Ensure the alias is under the correct controller in `app-oas.yml`; the OAS generator rewrites IDs only for configured aliases |
| **Include alias not projected in response** | `ConvertDomainIncludeAliasToGenericRelation` filter not matching | Confirm the include relation name matches a configured alias under the correct controller; the alias must appear in the `through.entities` or `through.reactions` config of the parent alias |
| **`PUT /entities/books/{id}` changes the `_kind`** | `PlaceKindNameIntoPayload` filter not present — indicates the route is being hit as a generic route | Confirm the URL includes the alias segment (`/entities/books/{id}`) not just the generic base (`/entities/{id}`) |
| **Hierarchy path missing from OAS** | `children` not configured on the alias | Add `children: [{alias: chapters, kind: chapter}]` to the alias YAML |

---

## Related Documents
- [`11_COMPONENT_entity-persistence-gateway.md`](11_COMPONENT_entity-persistence-gateway.md) — Filter chain details for Kind Aliasing
- [`14_COMPONENT_tarcinapp-base-gui.md`](14_COMPONENT_tarcinapp-base-gui.md) — How the GUI uses `x-base-record-type` and domain OAS
- [`40_EXAMPLE_books-app.md`](40_EXAMPLE_books-app.md) — Complete end-to-end books domain configuration
- [`41_EXAMPLE_adding-a-new-kind.md`](41_EXAMPLE_adding-a-new-kind.md) — Step-by-step guide to adding a new kind
- [`entity-persistence-gateway/.context/70-FEATURE-DOMAIN-PROJECTION.md`](../../entity-persistence-gateway/.context/70-FEATURE-DOMAIN-PROJECTION.md) — Authoritative EPG feature reference (configuration schema, route IDs, runtime behavior)
- [`entity-persistence-gateway/.context/75-FEATURE-ROUTE-TOGGLES.md`](../../entity-persistence-gateway/.context/75-FEATURE-ROUTE-TOGGLES.md) — Full route tag taxonomy and toggle precedence rules
- [`entity-persistence-gateway/.context/90-FEATURE-DYNAMIC-OAS-GENERATION.md`](../../entity-persistence-gateway/.context/90-FEATURE-DYNAMIC-OAS-GENERATION.md) — Dynamic OAS generation, caching, and permission-aware schema pruning
