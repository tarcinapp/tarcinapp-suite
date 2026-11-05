# 41_EXAMPLE_adding-a-new-kind.md

## Overview

This guide shows how to add a new business object type (`_kind`) to an existing Tarcinapp deployment using only configuration changes — no application code required. The example uses the books application from `40_EXAMPLE_books-app.md` as the starting point and adds several new kind types. If the new kind eventually needs custom business logic (validation rules, data enrichment, side effects), that is handled separately in the Orchestration Layer — see `42_EXAMPLE_custom-business-logic.md`.

---

## When You Need This

Use this guide whenever you need to:
- Introduce a new domain object (e.g., `publisher`, `tag`, `campaign`, `subscription`)
- Add a new list type (e.g., `reading-list`, `wishlist`)
- Add a new reaction type (e.g., `bookmark`, `flag`)

---

## The Checklist

**For each new `_kind`, you need to:**

1. ☐ **Decide the record TYPE precisely** — which MongoDB collection does this land in?
   - **Entity** (`ENTITY_KINDS`) — standalone domain objects (books, authors, publishers)
   - **List** (`LIST_KINDS`) — containers that hold entities via relations (shelves, wishlists)
   - **Reaction** (`ENTITY_REACTION_KINDS` or `LIST_REACTION_KINDS`) — user responses attached to a record (reviews, bookmarks, flags)
   - **Relation** (`LIST_ENTITY_REL_KINDS`) — the link record between a list and an entity (book-in-shelf)
2. ☐ **Consider if you need hierarchy (parent/child).** Only Entities support `_parentId` / children traversal. Relations and Reactions do **not** support parent/child hierarchy.
3. ☐ **Consider if the new kind needs traversal access** (e.g., `GET /books/{id}/reactions/reviews`). For entity reactions, traversal routes are built-in for kind-alias routes — configure `through.reactions` on the entity alias. List–entity traversal works similarly via `through.entities` on the list alias.
4. ☐ **Consider if you need a hierarchy alias** (e.g., `/books/{id}/chapters` instead of `/books/{id}/children`). Configure `APP_KINDALIASPATHS_N_HIERARCHYALIAS` and `APP_KINDALIASPATHS_N_HIERARCHYNAME`.
5. ☐ Add the new `_kind` value to the appropriate EPS allowed-kinds env var
6. ☐ Add a kind alias in the gateway config (`APP_KINDALIASPATHS_N_*`)
7. ☐ (Optional) Add a JSON schema for request validation
8. ☐ (Optional) Add uniqueness rules in EPS
9. ☐ (Optional) Add record limits in EPS
10. ☐ (Optional) Add saved queries in the gateway
11. ☐ (Optional) Add field sets in the gateway
12. ☐ Restart EPS if you changed an EPS env var
13. ☐ Restart the gateway (all gateway config changes require restart)
14. ☐ Test the new endpoint

---

## Example: Adding `publisher` (Entity)

**Goal:** Expose `GET/POST /api/v1/publishers`, with a schema requiring a `country` field, with globally-unique publisher names.

### Step 1: Update EPS — allowed kinds

Add `publisher` to `ENTITY_KINDS`:

```bash
# Before:
ENTITY_KINDS=book,chapter,author

# After:
ENTITY_KINDS=book,chapter,author,publisher
```

**Uniqueness — globally unique publisher names:**

The default books uniqueness rule scopes by `_kind`, `_slug`, **and** `_createdBy` — meaning two different users can create a publisher with the same name. For publisher names to be globally unique across all users, add a second rule that does **NOT** include `_createdBy`:

```bash
# Rule 1 (existing): no duplicate book/chapter/author slugs per user
# Rule 2 (new): publisher names are globally unique (across all users)
ENTITY_UNIQUENESS='where[_kind]=${_kind}&where[_slug]=${_slug}&where[_createdBy]=${_createdBy},where[_kind]=publisher&where[_slug]=${_slug}'
```

The comma separates rules. The system checks each rule independently — a new record is rejected if it would violate **any** one of the listed rules.

> **Important:** Changing `ENTITY_UNIQUENESS` requires an EPS restart but does **not** retroactively validate existing records. Records created before this constraint was added are not affected — only new creates and updates are checked going forward.

Restart EPS to pick up the new allowed kinds and uniqueness rules.

### Step 2: Update the gateway — kind alias

Add the kind alias environment variables:

```bash
# Find the next available index (existing: 0=books, 1=shelves, 2=authors, 3=reviews, 4=ratings)
APP_KINDALIASPATHS_5_ALIAS=publishers
APP_KINDALIASPATHS_5_NAME=publisher
APP_KINDALIASPATHS_5_SCHEMA={"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"country":{"type":"string","minLength":2},"founded":{"type":"integer","minimum":1400}},"required":["country"]}
```

### Step 2.5: Link publishers to books

Publishers and books are separate records. To associate a publisher with a book, add a `publisherId` field to the **books** schema and store the publisher's URI there:

**Update the books schema** to include the `publisherId` field:

```bash
APP_KINDALIASPATHS_0_SCHEMA={"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"author":{"type":"string","minLength":1},"isbn":{"type":"string","pattern":"^[0-9-]{10,17}$"},"genre":{"type":"string"},"pages":{"type":"integer","minimum":1},"publisherId":{"type":"string"}},"required":["author"]}
```

**When creating a book**, include the publisher's Tarcinapp URI in `publisherId`:

```bash
curl -X POST http://localhost:8081/api/v1/books \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "War and Peace",
    "author": "Leo Tolstoy",
    "publisherId": "tapp://localhost/entity/publisher-uuid-here"
  }'
```

**When fetching books**, use the `filter[lookup]` parameter to resolve the publisher record inline:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/books?filter[lookup][0][prop]=publisherId"
```

The EPS will resolve the URI and embed the publisher document under a `publisherId_resolved` (or configured) key in each book record.

### Step 3: (Optional) Rate limiting for publishers

```bash
APP_KINDALIASPATHS_5_RATELIMITER_REPLENISHRATE=3
APP_KINDALIASPATHS_5_RATELIMITER_BURSTCAPACITY=5
```

### Step 4: Restart the gateway

The gateway must be restarted for new `kindAliasPaths` entries to take effect (Spring Boot loads configuration at startup).

```bash
# Docker Compose
docker-compose restart gateway

# Kubernetes
kubectl rollout restart deployment/entity-persistence-gateway -n tarcinapp
```

### Step 5: Test

```bash
# Create a publisher
curl -X POST http://localhost:8081/api/v1/publishers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"_name": "Penguin Books", "country": "UK", "founded": 1935}'

# List publishers
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8081/api/v1/publishers

# Verify schema validation rejects missing required field
curl -X POST http://localhost:8081/api/v1/publishers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"_name": "No Country Publisher"}'
# Expected: 422 ValidationError — country is required
```

### Step 5.5: Test JSON Schema type rejection

The schema enforces `country` as a string. Passing the wrong type triggers a field-level error:

```bash
curl -X POST http://localhost:8081/api/v1/publishers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"_name": "Bad Publisher", "country": 123}'
# country should be a string, not an integer
# Expected: 422 with field error details, e.g.:
# { "error": "VALIDATION-ERROR", "details": [{ "field": "/country", "message": "... must be string" }] }
```

### Step 6: Verify in the GUI

Open `tarcinapp-base-gui`. After the gateway restarts, refresh the OAS spec (or reconnect). A new **Publishers** entry should appear in the sidebar. The create form will show `_name`, `country`, and `founded` fields.

---

## Example: Adding `wishlist` (List)

**Goal:** Expose `GET/POST /api/v1/wishlists`.

### EPS changes

```bash
# Add to list kinds
LIST_KINDS=shelf,library,wishlist

# Auto-approve wishlists immediately
AUTOAPPROVE_LIST=true    # already set — wishlists inherit this
```

**Note on content:** Wishlists (as a list record type) can hold **any** entity kind — not just books. This is by design: the list–entity relation is generic. If you want to restrict wishlists to books only, you can add a JSON schema with a documentation note, but this cannot be enforced at the EPS level. Enforcing kind-specific membership would require an orchestrator PreProcessor that rejects relations linking non-book entities to wishlists.

**Enforce a per-user wishlist limit:**

```bash
# Maximum 5 wishlists per user
LIST_RECORD_LIMITS='[{"scope":"where[_kind]=wishlist","limit":5}]'
```

The `scope` is a query string scoped to the current user (`_createdBy` is always injected). A sixth `POST /wishlists` will be rejected with a limit-exceeded error.

### Gateway changes

```bash
APP_KINDALIASPATHS_6_ALIAS=wishlists
APP_KINDALIASPATHS_6_NAME=wishlist
```

### Test: add a book to a wishlist

The traversal endpoint is auto-generated — no extra config needed:
```bash
# Create a wishlist
curl -X POST http://localhost:8081/api/v1/wishlists \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"_name": "Books to read in 2025"}'

# Add a book to the wishlist
curl -X POST "http://localhost:8081/api/v1/wishlists/wishlist-uuid.../entities/books" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"priority": "high"}'
```

---

## Example: Adding `bookmark` (Entity Reaction)

**Goal:** Allow users to bookmark books (`POST /api/v1/books/{id}/reactions/bookmarks`), with a maximum of one bookmark per user per book.

### EPS changes

```bash
ENTITY_REACTION_KINDS=review,rating,like,bookmark

# One bookmark per user per book — uniqueness scoped by entity AND owner
ENTITY_REACTION_UNIQUENESS='where[_kind]=bookmark&where[_entityId]=${_entityId}&sets[owners][userIds]=${_createdBy}'
```

**How the uniqueness scope works:**
- `where[_kind]=bookmark` — scoped to bookmark records only
- `where[_entityId]=${_entityId}` — scoped to the specific book being bookmarked
- `sets[owners][userIds]=${_createdBy}` — scoped to records where the creating user is in the owners set

Together, these ensure each user can have at most one bookmark per book. The `sets[owners]` clause is the correct syntax for per-owner scoping in EPS uniqueness rules.

**Bookmark-as-toggle pattern:**

Once a bookmark exists, a second `POST` to the same endpoint returns `409 Conflict` with error code `UNIQUENESS-VIOLATION`. You can use this for toggle-like behavior in a client:

```
POST /books/{id}/reactions/bookmarks
  → 201 Created     → bookmark did not exist, now created
  → 409 Conflict    → bookmark already exists; fetch it and DELETE to unbookmark
```

### Gateway changes

```bash
APP_KINDALIASPATHS_7_ALIAS=bookmarks
APP_KINDALIASPATHS_7_NAME=bookmark
```

### Test

```bash
# Bookmark a book
curl -X POST "http://localhost:8081/api/v1/books/book-uuid.../reactions/bookmarks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"note": "Read for the reading club"}'

# Try to bookmark the same book again — should get 409
curl -X POST "http://localhost:8081/api/v1/books/book-uuid.../reactions/bookmarks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: 409 Conflict — UNIQUENESS-VIOLATION

# List my bookmarks (across all books)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/bookmarks?q=my"
```

---

## Hierarchy Alias Example: Adding `bio-chapters` to `authors`

Authors might have a biography structure with chapters. Add a hierarchy alias to expose domain-specific child routes:

```bash
APP_KINDALIASPATHS_2_ALIAS=authors
APP_KINDALIASPATHS_2_NAME=author
APP_KINDALIASPATHS_2_HIERARCHYALIAS=bio-chapters
APP_KINDALIASPATHS_2_HIERARCHYNAME=bio-chapter
```

**Routes created by the hierarchy alias:**

This creates 2 additional routes on the `authors` kind-alias controller (beyond the standard CRUD):

| Route | Description |
|:---|:---|
| `GET /api/v1/authors/{id}/bio-chapters` | List all bio-chapter children of a given author |
| `POST /api/v1/authors/{id}/bio-chapters` | Create a new bio-chapter child under this author |

**What `POST /authors/{id}/bio-chapters` does:**

The gateway intercepts the request and:
1. Injects `_kind=bio-chapter` into the request body (via `PlaceKindNameIntoPayload`)
2. Sets `_parentId` to the author's `{id}`
3. Proxies the request to `POST /entities/{id}/children` on EPS

The resulting record is an entity with `_kind=bio-chapter` and `_parentId=<author-id>`. It can be retrieved from either the hierarchy route (`/authors/{id}/bio-chapters`) or the flat route (`/api/v1/bio-chapters` if a top-level alias for that kind is also configured).

**Note:** Hierarchy is only supported for **Entity** kinds. You cannot configure `HIERARCHYALIAS` on a List, Reaction, or Relation alias.

---

## Relation Kind Aliases

Relations (ListEntityRelation records — the link between a list and an entity) can also have their own kind aliases. This is useful when the relation record itself carries domain-specific data.

**Example: `book-in-shelf` relation with its own alias**

In the books app, adding a book to a shelf creates a `book-in-shelf` relation record. To expose these records at a domain URL:

```bash
# EPS — already configured in the books app:
LIST_ENTITY_REL_KINDS=book-in-shelf

# Gateway — add a kind alias for the relation kind
APP_KINDALIASPATHS_8_ALIAS=book-shelf-links
APP_KINDALIASPATHS_8_NAME=book-shelf-link
```

**Routes this creates:**

```
GET    /api/v1/relations/book-shelf-links          → list all book-shelf link records
POST   /api/v1/relations/book-shelf-links          → create a book-shelf link directly
GET    /api/v1/relations/book-shelf-links/{id}     → get a specific link record
PATCH  /api/v1/relations/book-shelf-links/{id}     → update a link record
DELETE /api/v1/relations/book-shelf-links/{id}     → remove a link
```

**When to use a relation kind alias:**

Use this when the relation record carries meaningful domain fields (e.g., `addedNote`, `priority`, `ordinalIndex`) and you need to query or manage those records independently of the shelf or book traversal routes. Without a relation kind alias, you can still create and delete these links via the shelf traversal route (`POST /shelves/{id}/entities/books`), but you cannot list or query them by kind.

---

## Complete Env Var Checklist

For each new kind, these are all the variables you might need:

| Variable | Required | Notes |
|:---|:---|:---|
| `ENTITY_KINDS` (or LIST/REACTION/RELATION variant) | **Yes** | Add the new `_kind` value |
| `APP_KINDALIASPATHS_N_ALIAS` | **Yes** | URL path segment |
| `APP_KINDALIASPATHS_N_NAME` | **Yes** | `_kind` value |
| `APP_KINDALIASPATHS_N_SCHEMA` | No | JSON Schema for request validation |
| `APP_KINDALIASPATHS_N_HIERARCHYALIAS` | No | Domain hierarchy route alias (entities only) |
| `APP_KINDALIASPATHS_N_HIERARCHYNAME` | No | `_kind` for hierarchy children (entities only) |
| `ENTITY_UNIQUENESS` (or variant) | No | Uniqueness constraints |
| `ENTITY_RECORD_LIMITS` (or variant) | No | Max records per user/global |
| `AUTOAPPROVE_ENTITY` (or variant) | No | Default is `false` |
| `VISIBILITY_ENTITY` (or variant) | No | Default is `private` |
| `APP_KINDALIASPATHS_N_RATELIMITER_REPLENISHRATE` | No | Rate limiting — replenish rate |
| `APP_KINDALIASPATHS_N_RATELIMITER_BURSTCAPACITY` | No | Rate limiting — burst capacity |
| `APP_KINDALIASPATHS_N_MAXREQUESTSIZE` | No | Payload size limit |
| `APP_QUERIES_*` | No | Saved queries for the new kind |
| `APP_FIELDSETS_*` | No | Named field sets for the new kind |

---

## What Requires a Restart

> **Hot-reload constraint:** Nothing in Tarcinapp is hot-reloadable at runtime. Both EPS and the gateway read all configuration at startup. Any environment variable change requires a process restart to take effect. There is no live-reload or SIGHUP mechanism.

| Change | EPS restart | Gateway restart |
|:---|:---|:---|
| Add new allowed kind | **Yes** | No |
| Add uniqueness rule | **Yes** | No |
| Add record limit | **Yes** | No |
| Change auto-approve | **Yes** | No |
| Change visibility default | **Yes** | No |
| Add kind alias | No | **Yes** |
| Add JSON schema | No | **Yes** |
| Add rate limiter | No | **Yes** |
| Add saved query | No | **Yes** |
| Add fieldset | No | **Yes** |
| Add hierarchy alias | No | **Yes** |

**Note on uniqueness changes and existing data:** Changing `ENTITY_UNIQUENESS` (or any `*_UNIQUENESS` variable) requires an EPS restart but does **not** migrate or validate existing records retroactively. Records created before the constraint was added are not affected. Only new creates and updates (PUT/PATCH) are evaluated against the updated rules.

---

## Common Mistakes

### 1. Forgetting to add the kind to EPS `ENTITY_KINDS`

If you configure a gateway alias but omit the `_kind` value from EPS's allowed list, every `POST` to the new endpoint returns:

```
422 Unprocessable Entity — INVALID-KIND
```

**Fix:** Add the kind to the correct EPS env var (`ENTITY_KINDS`, `LIST_KINDS`, `ENTITY_REACTION_KINDS`, or `LIST_ENTITY_REL_KINDS`) and restart EPS.

### 2. Configuring a kind alias in the gateway but forgetting to restart

New `APP_KINDALIASPATHS_N_*` entries are read at Spring Boot startup. If you add them and do not restart the gateway, the new routes simply do not exist and every request to them returns `404 Not Found` — not a configuration error, just a missing route.

**Fix:** `docker-compose restart gateway` or `kubectl rollout restart deployment/entity-persistence-gateway`.

### 3. Setting the wrong index number on `APP_KINDALIASPATHS_N_`

All variables for a single alias **must share the same index N**. If you accidentally reuse an index, the later variable overwrites the earlier one for that key:

```bash
# Bug: two aliases both use index 5 — the second overwrites the first
APP_KINDALIASPATHS_5_ALIAS=publishers
APP_KINDALIASPATHS_5_NAME=publisher
APP_KINDALIASPATHS_5_ALIAS=tags       # ← overwrites publishers!
APP_KINDALIASPATHS_5_NAME=tag         # ← overwrites publisher!
```

**Fix:** Use a unique, sequential index for each alias. Before adding a new alias, check all existing `APP_KINDALIASPATHS_*_ALIAS` values to find the next available index.

### 4. Redundant `required` on managed fields in JSON Schema

Tarcinapp managed fields (e.g., `_name`, `_kind`, `_createdBy`) are handled and validated by the system before your schema runs. Listing them in the `required` array of your JSON Schema is **redundant but harmless** — it will not cause errors, but it adds no protection either.

```bash
# Redundant — _name is already a managed field; the system enforces it separately
APP_KINDALIASPATHS_5_SCHEMA={"required":["_name","country"]}

# Correct — only list your own custom required fields
APP_KINDALIASPATHS_5_SCHEMA={"required":["country"]}
```

---

## Related Documents
- `22_CONCEPT_domain-projection.md` — How kind aliasing works in depth (filter chain, OAS generation, traversal)
- `40_EXAMPLE_books-app.md` — Full books app as the starting point
- `31_OPS_configuration-reference.md` — All EPS and gateway config variables
