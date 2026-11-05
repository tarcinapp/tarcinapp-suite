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
```

With domain projection configured, the same operations become:
```
GET /books
POST /books  (no _kind needed)
```

The client doesn't know about `_kind`, `filter[where]`, or LoopBack syntax. They see a clean, domain-native REST API.

---

## How It Works: Kind Alias Paths

Domain projection is configured via `app.kindAliasPaths` in the gateway:

```yaml
app:
  kindAliasPaths:
    - alias: books       ← the URL path segment (/books)
      name: book         ← the _kind value to inject/filter
      schema: '...'      ← optional JSON Schema for validation
```

Or via environment variables:
```bash
APP_KINDALIASPATHS_0_ALIAS=books
APP_KINDALIASPATHS_0_NAME=book
APP_KINDALIASPATHS_0_SCHEMA={"$schema":"...","type":"object",...}
```

When a request arrives at `/api/v1/books`, the gateway:
1. Resolves `books` → `_kind=book` via `KindResolution`
2. Rewrites the path to the generic EPS endpoint
3. Applies kind-specific middleware (schema validation, rate limits, timeouts)

---

## Four Transformation Steps

### Step 1: Path Rewriting
Gateway rewrites the incoming path before proxying:
```
/api/v1/books  →  /entities
/api/v1/books/{id}  →  /entities/{id}
/api/v1/books/{id}/chapters  →  /entities/{id}/children  (with kind filter)
```

### Step 2: `_kind` Injection into Request Body
For POST, PUT, PATCH — Gateway adds `_kind` to the payload:
```json
// Client sends:
POST /books
{ "_name": "War and Peace" }

// Gateway sends to EPS:
POST /entities
{ "_name": "War and Peace", "_kind": "book" }
```
Filter: `PlaceKindNameIntoPayload`

### Step 3: `_kind` Query Filter for GET
For GET — Gateway adds `_kind` to the query parameters:
```
GET /books?limit=10
→ GET /entities?filter[where][_kind]=book&filter[limit]=10
```
Filter: `ConvertKindAliasToKindQuery`

### Step 4: Hierarchy Alias Resolution
For domain hierarchy routes (`/{kind}/{id}/{hierarchyAlias}`), the Gateway resolves the alias:
```
GET /books/{id}/chapters
→ GET /entities/{id}/children?filter[where][_kind]=chapter
```
The `hierarchyAlias` → `_kind` mapping is configured alongside the kind alias:
```yaml
app.kindAliasPaths[0].alias=books
app.kindAliasPaths[0].name=book
app.kindAliasPaths[0].hierarchyAlias=chapters
app.kindAliasPaths[0].hierarchyName=chapter
```
Filter: `HierarchyKindAliasResolver`

---

## Per-Kind Configuration

Beyond path aliasing, each kind alias can have independent settings:

```yaml
app:
  kindAliasPaths:
    - alias: books
      name: book
      schema: |
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "type": "object",
          "properties": {
            "author": { "type": "string" },
            "isbn": { "type": "string" },
            "pages": { "type": "integer" }
          },
          "required": ["author"]
        }
      maxRequestSize: 5KB
      rateLimiter:
        replenishRate: 5
        burstCapacity: 10
      timeout: 30000
```

Environment variable format:
```bash
APP_KINDALIASPATHS_0_ALIAS=books
APP_KINDALIASPATHS_0_NAME=book
APP_KINDALIASPATHS_0_MAXREQUESTSIZE=5KB
APP_KINDALIASPATHS_0_RATELIMITER_REPLENISHRATE=5
APP_KINDALIASPATHS_0_RATELIMITER_BURSTCAPACITY=10
```

---

## JSON Schema Validation Per Kind

When a `schema` is configured for a kind, the gateway validates POST and PUT request bodies against it using JSON Schema draft 2020-12.

For PATCH, only the fields present in the patch body are validated (partial validation — `required` at root level is not enforced for PATCH).

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

Managed fields (`_name`, `_visibility`, etc.) are always validated by the system — you don't need to include them in the schema.

---

## Dynamic OpenAPI Generation (Domain View)

When domain projection is active, the gateway generates an OpenAPI spec that reflects the domain surface, not the generic one:

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

### Domain Schema in OAS
For kind aliases with a configured `schema`, the OAS includes the domain schema in request body definitions. The response schema is inferred from the backend EPS contract plus the domain schema fields.

### Role-Based Schema Pruning
The OAS spec is personalized per caller. Forbidden fields are **physically removed** from schemas:
- A `visitor` calling `GET /openapi.json` will not see `_visibility` in the Books GET response schema
- A `member` calling the same endpoint will not see `_ownerUsers` in the Books POST request schema

This makes the OAS spec the **single source of truth for what the caller can do** — which is exactly how `tarcinapp-base-gui` uses it.

---

## Route Toggles and Domain-Only Exposure

By default, the gateway exposes both:
- Generic routes: `GET /api/v1/entities`, `POST /api/v1/entities`, etc.
- Kind alias routes: `GET /api/v1/books`, `POST /api/v1/books`, etc.

To expose **only** the domain surface (clean domain-native API), disable the generic routes:

```yaml
app:
  routes:
    tags:
      disabled: generic
```

Or environment variable:
```bash
APP_ROUTES_TAGS_DISABLED=generic
```

This disables all 65 Base Generic routes, leaving only Kind Alias routes and utility routes active. The OAS spec will only contain domain paths.

Individual routes can also be disabled by route ID:
```bash
APP_ROUTES_DISABLED=updateAllEntities,updateAllLists
```

→ See [`.context/75-FEATURE-ROUTE-TOGGLES.md`](../../entity-persistence-gateway/.context/75-FEATURE-ROUTE-TOGGLES.md) for the full tag taxonomy.

---

## Multi-Kind Example: Books Application

A books domain might configure:

```bash
# Books (entities)
APP_KINDALIASPATHS_0_ALIAS=books
APP_KINDALIASPATHS_0_NAME=book
APP_KINDALIASPATHS_0_HIERARCHYALIAS=chapters
APP_KINDALIASPATHS_0_HIERARCHYNAME=chapter

# Shelves (lists)
APP_KINDALIASPATHS_1_ALIAS=shelves
APP_KINDALIASPATHS_1_NAME=shelf

# Reviews (entity reactions through books)
APP_KINDALIASPATHS_2_ALIAS=reviews
APP_KINDALIASPATHS_2_NAME=review
```

This creates the following API surface:
```
GET  /api/v1/books                    ← list all books
POST /api/v1/books                    ← create a book
GET  /api/v1/books/{id}               ← get a book
GET  /api/v1/books/{id}/chapters      ← get sub-chapters (hierarchy)
GET  /api/v1/shelves                  ← list all shelves
GET  /api/v1/shelves/{id}/books       ← books in a shelf (traversal)
GET  /api/v1/books/{id}/reactions/reviews ← reviews for a book (traversal)
POST /api/v1/books/{id}/reactions/reviews ← add a review
```

All managed by the gateway configuration alone — no EPS code changes, no schema migrations.

---

## Relation Kind Aliases

Relations (ListEntityRelation) can also have kind aliases for the relation endpoint and for traversal:

```bash
# Book-Shelf relation
APP_KINDALIASPATHS_3_ALIAS=book-shelf-memberships
APP_KINDALIASPATHS_3_NAME=book-shelf-membership
```

Traversal endpoints for kind aliases:
```
GET /api/v1/shelves/{id}/entities/books     ← entities (books) in a shelf
GET /api/v1/books/{id}/lists/shelves        ← shelves containing a book
```

---

## Related Documents
- `11_COMPONENT_entity-persistence-gateway.md` — Filter chain details for Kind Aliasing
- `14_COMPONENT_tarcinapp-base-gui.md` — How the GUI uses `x-base-record-type` and domain OAS
- `40_EXAMPLE_books-app.md` — Complete end-to-end books domain configuration
- `41_EXAMPLE_adding-a-new-kind.md` — Step-by-step guide to adding a new kind
