# 20_CONCEPT_data-model.md

## Overview

Tarcinapp uses a **polymorphic data model**: all business data maps onto five generic record types stored in MongoDB. A single deployment stores books, shelves, reviews, and user follows — all using the same five types, differentiated by the `_kind` field.

This document covers the data model in depth: record types, managed fields, hierarchies, relations, reactions, lifecycle states, and the `tapp://` URI scheme.

---

## The Five Record Types

### 1. Entity
**MongoDB collection:** `entities`  
**Base endpoint (EPS):** `/entities`

The primary domain object. Everything that is a "thing" in your domain is an entity.

**Examples:** book, product, article, user profile, IoT device, notification, campaign, configuration object.

**Unique capabilities:**
- Supports parent/child hierarchy (`_parents` / `_children`)
- Can belong to multiple lists (via ListEntityRelation)
- Can receive entity reactions
- Can reference other records via `tapp://` URIs

### 2. List
**MongoDB collection:** `lists`  
**Base endpoint (EPS):** `/lists`

A grouping or collection of entities. Lists organize entities into meaningful sets.

**Examples:** bookshelf, playlist, wishlist, shopping cart, saved search, campaign group.

**Unique capabilities:**
- Supports parent/child hierarchy
- Can contain many entities (via ListEntityRelation — many-to-many)
- Can receive list reactions
- Lists themselves can be organized into a hierarchy (e.g., top-level genre → sub-genre)

### 3. Relation (ListEntityRelation)
**MongoDB collection:** `list-entity-relations`  
**Base endpoint (EPS):** `/relations`

The join record between a list and an entity. Represents "entity X is in list Y."

**Examples:** book-in-shelf, product-in-category, item-in-cart, post-in-topic.

**Unique capabilities:**
- Can carry arbitrary custom metadata about the association (e.g., `addedAt`, `position`, `pinnedBy`)
- Responses for traversal queries include `_fromMetadata` (list context) and `_toMetadata` (entity context)
- **Flat**: no parent/child hierarchy

**Required fields:**
- `_listId`: ID of the linked list
- `_entityId`: ID of the linked entity

**Authorization note:** Relation authorization is derived from the connected records. Creating a relation requires owning the list AND being able to view the entity.

### 4. EntityReaction
**MongoDB collection:** `entity-reactions`  
**Base endpoint (EPS):** `/entity-reactions`

A user interaction directed at a specific entity.

**Examples:** review, rating, bookmark, like, flag, IoT sensor measurement, status update.

**Required fields:**
- `_entityId`: ID of the target entity

**Unique capabilities:**
- Supports parent/child hierarchy (threaded reactions, e.g., reply to a review)
- Can receive its own metadata via managed fields

### 5. ListReaction
**MongoDB collection:** `list-reactions`  
**Base endpoint (EPS):** `/list-reactions`

A user interaction directed at a specific list.

**Examples:** list-like, playlist-comment, shelf-flag.

**Required fields:**
- `_listId`: ID of the target list

**Unique capabilities:**
- Supports parent/child hierarchy

---

## Managed Fields

Every record across all five types is automatically decorated with the following system fields. All are underscore-prefixed. See also `00_SYSTEM_MANIFEST.md §4` for the governance rules.

### Category 1: Strictly System-Managed
Set by application logic only. User input is ignored.

| Field | Type | Description |
|:---|:---|:---|
| `_version` | `integer` | Optimistic locking version. Auto-incremented on every update. |
| `_idempotencyKey` | `string` | Hash for deduplication. Never returned in responses but queryable. |
| `_parentsCount` | `integer` | Cached count of `_parents` array. Never in responses but filterable: `filter[where][_parentsCount]=0` finds root items. |
| `_ownerUsersCount` | `integer` | Cached count of `_ownerUsers`. Filterable. |
| `_ownerGroupsCount` | `integer` | Cached count of `_ownerGroups`. Filterable. |
| `_viewerUsersCount` | `integer` | Cached count of `_viewerUsers`. Filterable. |
| `_viewerGroupsCount` | `integer` | Cached count of `_viewerGroups`. Filterable. |
| `_recordType` | `string` | Virtual field (`entity`, `list`, etc.). Not persisted. Always masked. Used internally by gateway for field masking on included records. |

### Category 2: Gateway-Managed
Injected from JWT at request time. Admin-modifiable via OPA policy exceptions.

| Field | Type | Description |
|:---|:---|:---|
| `_createdBy` | `string` | JWT `sub` of the creator. Set at creation. |
| `_createdDateTime` | `datetime` | ISO 8601 timestamp of creation. Set at creation. |
| `_lastUpdatedBy` | `string` | JWT `sub` of the last modifier. Set on every write. |
| `_lastUpdatedDateTime` | `datetime` | ISO 8601 timestamp of last write. Set on every write. |
| `_validFromDateTime` | `datetime` | Approval gate / lifecycle start. Auto-filled by EPS if missing (if auto-approve enabled). |
| `_ownerUsers` | `string[]` | User IDs with ownership. Injected at creation from JWT `sub`. |
| `_ownerGroups` | `string[]` | Group IDs with ownership. |

### Category 3: Auto-Filled if Empty
Applied by EPS or Gateway when the caller omits them.

| Field | Type | Description |
|:---|:---|:---|
| `_kind` | `string` | Record subtype/variant. Injected by the gateway for Kind Alias routes. **Immutable after creation.** |
| `_visibility` | `enum` | `"public"`, `"protected"`, or `"private"`. Default is configured per deployment. |
| `_slug` | `string` | URL-safe identifier derived from `_name`. Auto-generated. |
| `_validFromDateTime` | `datetime` | If auto-approve is enabled, set to now. Otherwise left null (pending). |

### Category 4: User-Settable
Can be provided by the caller (subject to field-level policy).

| Field | Type | Description |
|:---|:---|:---|
| `_id` | `string` | UUID. Server-generated. **Immutable.** |
| `_name` | `string` | Display name. Required for Entity and List (minLength: 2). |
| `_validUntilDateTime` | `datetime` | Soft-delete / expiry timestamp. Records past this date are expired. |
| `_viewerUsers` | `string[]` | User IDs with read-only access. |
| `_viewerGroups` | `string[]` | Group IDs with read-only access. |
| `_parents` | `string[]` | Parent references as `tapp://localhost/{type}/{uuid}` URIs. Drives hierarchy. |

### Resource-Specific Fields

| Field | Applies to | Description |
|:---|:---|:---|
| `_listId` | Relation, ListReaction | ID of the linked list. Required. |
| `_entityId` | Relation, EntityReaction | ID of the linked entity. Required. |
| `_fromMetadata` | Entity, List (traversal responses) | Metadata from the relation's list side. |
| `_toMetadata` | Entity, List (traversal responses) | Metadata from the relation's entity side. |
| `_relationMetadata` | Entity, List (traversal responses) | The full join record metadata when returned via traversal. |

---

## The `_kind` Discriminator

`_kind` is the field that differentiates records within the same MongoDB collection. It is:
- **Injected by the gateway** for Kind Alias routes (e.g., calling `POST /entities/books` injects `"_kind":"book"`)
- **Immutable after creation** — changing `_kind` throws `422 IMMUTABLE-ENTITY-KIND`
- **Used by the gateway** to apply kind-specific configurations (schema, rate limits, fieldsets)
- **Used by EPS** to enforce allowed kinds and apply record limits

If `_kind` is not provided and not injected by the gateway, EPS fills it with the model name (`entity`, `list`, `list-entity-relation`, `list-reaction`, `entity-reaction`).

---

## The `tapp://` URI Scheme

The `_parents` field uses `tapp://` URIs to reference parent records. This scheme is used throughout Tarcinapp for internal record references.

**Format:** `tapp://localhost/{recordType}/{uuid}`

**Examples:**
- `tapp://localhost/entity/a1b2c3d4-...` — reference to an entity
- `tapp://localhost/list/e5f6g7h8-...` — reference to a list

**How it works:**
- When a record has `_parents: ["tapp://localhost/entity/abc123"]`, EPS tracks the hierarchy.
- EPS automatically updates the parent's `_children` array when `_parents` is set.
- `_parentsCount` is computed from the `_parents` array length and cached for efficient filtering.

**Lookups:** Any field (not just `_parents`) can hold a `tapp://` URI. The `filter[lookup]` query parameter resolves these references at query time.

---

## Hierarchies

Entities, Lists, EntityReactions, and ListReactions all support parent-child trees. Relations do not.

### How to set up hierarchy
On a child record, set `_parents` to an array containing the parent's `tapp://` URI:
```json
POST /entities
{
  "_name": "Chapter 1",
  "_kind": "chapter",
  "_parents": ["tapp://localhost/entity/book-uuid-here"]
}
```

EPS automatically:
1. Stores `_parents` on the child.
2. Adds the child's ID to `_children` on the parent.
3. Sets `_parentsCount = 1` on the child.

### Querying hierarchy
```
GET /entities/{bookId}/children         ← direct children
GET /entities/{chapterId}/parents       ← direct parents
GET /entities?filter[where][_parentsCount]=0  ← root-level items only
```

### Hierarchy API endpoints

| Operation | Path |
|:---|:---|
| Find children | `GET /{type}/{id}/children` |
| Create child | `POST /{type}/{id}/children` |
| Find parents | `GET /{type}/{id}/parents` |

---

## Record Lifecycle State Machine

Every record has a **status** based on `_validFromDateTime` and `_validUntilDateTime`:

```
          _validFromDateTime = null or in future
              ┌─────────────────────────┐
              │         PENDING          │
              └─────────────┬───────────┘
                            │  _validFromDateTime set to past
                            ▼
              ┌─────────────────────────┐
              │          ACTIVE          │  (_validUntilDateTime null or in future)
              └─────────────┬───────────┘
                            │  _validUntilDateTime set to past
                            ▼
              ┌─────────────────────────┐
              │         EXPIRED          │
              └─────────────────────────┘
```

**Set filter names:**
- `sets[actives]` — active records
- `sets[pendings]` — pending records (awaiting approval)
- `sets[expireds]` — expired records (soft-deleted)

**Access rules by state:**
- `pending`: only the direct owner and admin/editor roles
- `active`: standard access per visibility rules
- `expired`: admin/editor owners only; member owners are denied access to their own expired records

### Soft deletion
To soft-delete a record, set `_validUntilDateTime` to a past datetime:
```json
PATCH /entities/{id}
{ "_validUntilDateTime": "2024-01-01T00:00:00Z" }
```
The record is not physically deleted. It moves to `expired` state. It can be queried by admins with `sets[expireds]`.

### Scheduled publishing
To schedule future publishing, set `_validFromDateTime` to a future datetime at creation:
```json
POST /entities
{ "_name": "Coming soon article", "_validFromDateTime": "2025-06-01T00:00:00Z" }
```
Requires the `tarcinapp.fields.entities._validFromDateTime.create` role (members are forbidden from setting this field by default).

---

## Visibility

Three visibility levels control who can see a record:

| Value | Access |
|:---|:---|
| `private` | Only `_ownerUsers`, `_viewerUsers`, and admin/editor. Group ownership is disabled. |
| `protected` | Direct owners, `_ownerGroups` members, `_viewerUsers`, `_viewerGroups`, and appropriate roles. |
| `public` | All authenticated users (when record is `active`). |

**Set filter names:**
- `sets[publics]` — public records
- `sets[protecteds]` — protected records
- `sets[privates]` — private records

The gateway automatically injects the appropriate `sets` filters for each request based on the caller's identity and OPA policies, ensuring callers never see records they should not access — even if they construct queries that would theoretically match them.

---

## List-Entity Relations: Detail

When an entity is added to a list via `POST /lists/{listId}/entities`, EPS creates a `list-entity-relation` record behind the scenes. This record:
- Has `_listId` and `_entityId` set automatically
- Can carry any additional custom metadata you pass in the request body
- Is accessible directly at `/relations/{id}` or via traversal at `/lists/{listId}/entities`

Traversal responses include `_fromMetadata` (list's metadata) and `_toMetadata` (entity's metadata) on each result record, so you can see both sides of the relationship without additional requests.

---

## Related Documents
- `00_SYSTEM_MANIFEST.md §4` — Managed fields table (concise version)
- `10_COMPONENT_entity-persistence-service.md` — Configuration: allowed kinds, uniqueness, record limits
- `21_CONCEPT_security-and-authorization.md` — How visibility and ownership drive access control
- `23_CONCEPT_query-language.md` — Filtering by managed fields, sets, and lookup resolution
