# 41_EXAMPLE_adding-a-new-kind.md

## Overview

This guide shows how to add a new business object type (`_kind`) to an existing Tarcinapp deployment without writing any code. The example uses the books application from `40_EXAMPLE_books-app.md` as the starting point and adds a new **publisher** entity kind.

---

## When You Need This

Use this guide whenever you need to:
- Introduce a new domain object (e.g., `publisher`, `tag`, `campaign`, `subscription`)
- Add a new list type (e.g., `reading-list`, `wishlist`)
- Add a new reaction type (e.g., `bookmark`, `flag`)

---

## The Checklist

**For each new `_kind`, you need to:**

1. ☐ Decide which record type it maps to (entity, list, relation, entity-reaction, list-reaction)
2. ☐ Add it to the EPS allowed kinds list
3. ☐ Add a kind alias in the gateway config
4. ☐ (Optional) Add a JSON schema for validation
5. ☐ (Optional) Add uniqueness rules in EPS
6. ☐ (Optional) Add record limits in EPS
7. ☐ (Optional) Add saved queries in the gateway
8. ☐ (Optional) Add field sets in the gateway
9. ☐ Restart the gateway (config change)
10. ☐ No EPS restart needed (most EPS config changes need restart, except MongoDB-level)
11. ☐ Test the new endpoint

---

## Example: Adding `publisher` (Entity)

**Goal:** Expose `GET/POST /api/v1/publishers`, with a schema requiring a `country` field.

### Step 1: Update EPS — allowed kinds

Add `publisher` to `ENTITY_KINDS`:

```bash
# Before:
ENTITY_KINDS=book,chapter,author

# After:
ENTITY_KINDS=book,chapter,author,publisher
```

If you want uniqueness on publisher names (globally unique names):
```bash
# Append a new uniqueness rule (comma-separated):
ENTITY_UNIQUENESS='where[_kind]=${_kind}&where[_slug]=${_slug}&where[_createdBy]=${_createdBy},where[_kind]=publisher&where[_slug]=${_slug}'
```

Restart EPS to pick up the new allowed kinds.

### Step 2: Update the gateway — kind alias

Add the kind alias environment variables:

```bash
# Find the next available index (existing: 0=books, 1=shelves, 2=authors, 3=reviews, 4=ratings)
APP_KINDALIASPATHS_5_ALIAS=publishers
APP_KINDALIASPATHS_5_NAME=publisher
APP_KINDALIASPATHS_5_SCHEMA={"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"country":{"type":"string","minLength":2},"founded":{"type":"integer","minimum":1400}},"required":["country"]}
```

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

**Goal:** Allow users to bookmark books (`POST /api/v1/books/{id}/reactions/bookmarks`).

### EPS changes

```bash
ENTITY_REACTION_KINDS=review,rating,like,bookmark

# One bookmark per user per book
ENTITY_REACTION_UNIQUENESS='where[_kind]=bookmark&where[_entityId]=${_entityId}&sets[owners][userIds]=${_createdBy}'
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

# List my bookmarks (across all books)
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8081/api/v1/bookmarks?q=my"
```

---

## Hierarchy Alias Example: Adding `chapters` to `authors`

Authors might have a biography structure with chapters. Add a hierarchy alias:

```bash
APP_KINDALIASPATHS_2_ALIAS=authors
APP_KINDALIASPATHS_2_NAME=author
APP_KINDALIASPATHS_2_HIERARCHYALIAS=bio-chapters
APP_KINDALIASPATHS_2_HIERARCHYNAME=bio-chapter
```

This makes the endpoint `GET/POST /api/v1/authors/{id}/bio-chapters` available.

---

## Complete Env Var Checklist

For each new kind, these are all the variables you might need:

| Variable | Required | Notes |
|:---|:---|:---|
| `ENTITY_KINDS` (or LIST/REACTION variant) | **Yes** | Add the new `_kind` value |
| `APP_KINDALIASPATHS_N_ALIAS` | **Yes** | URL path segment |
| `APP_KINDALIASPATHS_N_NAME` | **Yes** | `_kind` value |
| `APP_KINDALIASPATHS_N_SCHEMA` | No | JSON Schema for validation |
| `APP_KINDALIASPATHS_N_HIERARCHYALIAS` | No | Domain hierarchy route alias |
| `APP_KINDALIASPATHS_N_HIERARCHYNAME` | No | `_kind` for hierarchy children |
| `ENTITY_UNIQUENESS` (or variant) | No | Uniqueness constraints |
| `ENTITY_RECORD_LIMITS` (or variant) | No | Max records per user/global |
| `AUTOAPPROVE_ENTITY` (or variant) | No | Default is `false` |
| `VISIBILITY_ENTITY` (or variant) | No | Default is `private` |
| `APP_KINDALIASPATHS_N_RATELIMITER_*` | No | Rate limiting |
| `APP_KINDALIASPATHS_N_MAXREQUESTSIZE` | No | Payload size limit |
| `APP_QUERIES_*` | No | Saved queries for the new kind |
| `APP_FIELDSETS_*` | No | Named field sets for the new kind |

---

## What Requires a Restart

| Change | EPS restart | Gateway restart |
|:---|:---|:---|
| Add new allowed kind | Yes | No |
| Add uniqueness rule | Yes | No |
| Add record limit | Yes | No |
| Change auto-approve | Yes | No |
| Add kind alias | No | **Yes** |
| Add JSON schema | No | **Yes** |
| Add rate limiter | No | **Yes** |
| Add saved query | No | **Yes** |
| Add fieldset | No | **Yes** |

---

## Related Documents
- `22_CONCEPT_domain-projection.md` — How kind aliasing works
- `40_EXAMPLE_books-app.md` — Full books app as the starting point
- `31_OPS_configuration-reference.md` — All EPS and gateway config variables
