# 20_CONCEPT_data-model.md

## Overview

Tarcinapp uses a **polymorphic data model**: all business data maps onto five generic record types stored in MongoDB. A single deployment stores books, shelves, reviews, and user follows — all using the same five types, differentiated by the `_kind` field.

This document covers the data model in depth: record types, managed fields, hierarchies, relations, reactions, lifecycle states, the `tapp://` URI scheme, and idempotency.

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

**Hierarchy storage detail:**  
The `_parents` array is stored directly on the child Entity document as an array of `tapp://` URIs (e.g., `["tapp://localhost/entity/abc123"]`). The parent's `_children` array is a reverse-reference: EPS maintains it automatically — when a child record is created with a `_parents` entry, EPS adds the child's ID to the parent's `_children` array. When a child is deleted, EPS removes the child's reference from the parent's `_children` array automatically.

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
- Supports its own `_kind` field (e.g., `"_kind": "book-in-shelf"`), enabling polymorphic join records where different relationship types coexist in the same collection and can be queried or constrained independently

**Key limitations — Relation is the ONLY record type that:**
- Does **NOT** support `_parents` / `_children` hierarchy (Relations are always flat)
- Does **NOT** have `_ownerUsers` / `_ownerGroups` of its own — authorization is derived from the connected list and entity (see *Relation Authorization* below)

**Required fields:**
- `_listId`: UUID of the linked list (stored as a plain UUID string, not a `tapp://` URI)
- `_entityId`: UUID of the linked entity (stored as a plain UUID string, not a `tapp://` URI)

**Authorization note:** Relation authorization is derived from the connected records. Creating a relation requires owning the list AND being able to view the entity. Modifying or deleting a relation requires owning the list. See `21_CONCEPT_security-and-authorization.md §Relation Authorization`.

### 4. EntityReaction
**MongoDB collection:** `entity-reactions`  
**Base endpoint (EPS):** `/entity-reactions`

A user interaction directed at a specific entity.

**Examples:** review, rating, bookmark, like, flag, IoT sensor measurement, status update.

**Required fields:**
- `_entityId`: UUID of the target entity. This is stored as a **plain UUID string**, NOT a `tapp://` URI.

**Unique capabilities:**
- Supports parent/child hierarchy (threaded reactions, e.g., reply to a review). Threaded reactions use the `_parents` array pointing to the parent reaction via `tapp://localhost/entity-reaction/{uuid}`.
- Can receive its own metadata via managed fields

### 5. ListReaction
**MongoDB collection:** `list-reactions`  
**Base endpoint (EPS):** `/list-reactions`

A user interaction directed at a specific list.

**Examples:** list-like, playlist-comment, shelf-flag.

**Required fields:**
- `_listId`: UUID of the target list. This is stored as a **plain UUID string**, NOT a `tapp://` URI.

**Unique capabilities:**
- Supports parent/child hierarchy

---

## Managed Fields

Every record across all five types is automatically decorated with the following system fields. All are underscore-prefixed. See also `00_SYSTEM_MANIFEST.md §4` for the governance rules.

### Category 1: Strictly System-Managed
Set by application logic only. User input is ignored.

| Field | Type | Description |
|:---|:---|:---|
| `_version` | `integer` | Optimistic locking version. Auto-incremented on every single-record `PUT`/`PATCH`. **Not** incremented by bulk `PATCH /entities?where[...]`. On a conflict (stale version submitted), EPS returns `409 Conflict` with code `OPTIMISTIC-LOCKING-CONFLICT`. Callers should re-fetch the record and retry with the current version. |
| `_idempotencyKey` | `string` | Hash for deduplication. Computed from configured idempotency fields (see *Idempotency Key* section). Never returned in responses but queryable. |
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
| `_slug` | `string` | URL-safe identifier derived from `_name`. Auto-generated using a URL-slug algorithm: lowercased, spaces replaced with hyphens, special characters removed (e.g., `"The Great Gatsby!"` → `"the-great-gatsby"`). **Not unique by default** — uniqueness is only enforced if `ENTITY_UNIQUENESS` (or equivalent) is configured to include `_slug`. |
| `_validFromDateTime` | `datetime` | If auto-approve is enabled, set to now. Otherwise left null (pending). |

### Category 4: User-Settable
Can be provided by the caller (subject to field-level policy).

| Field | Type | Description |
|:---|:---|:---|
| `_id` | `string` | UUID. Server-generated. **Immutable.** |
| `_name` | `string` | Display name. Required for Entity and List (minLength: 2). |
| `_validUntilDateTime` | `datetime` | Soft-delete / expiry timestamp. Records past this date are expired. |
| `_viewerUsers` | `string[]` | User IDs with read-only access. Grants READ access only — viewer cannot modify the record. Access is only effective when the record is `active`. |
| `_viewerGroups` | `string[]` | Group IDs with read-only access. Same semantics as `_viewerUsers`. |
| `_parents` | `tapp://[]` | Parent references as `tapp://localhost/{recordType}/{uuid}` URIs. Drives hierarchy. Setting this field also triggers EPS to add the child's reference to the parent's `_children` array. |
| `_children` | `string[]` | Reverse-reference array maintained by EPS. Not settable directly by users. Populated automatically when child records set `_parents`. Cleaned up automatically when child records are deleted. |

### Resource-Specific Fields

| Field | Applies to | Description |
|:---|:---|:---|
| `_listId` | Relation, ListReaction | UUID of the linked list. Required. Stored as plain UUID, not `tapp://`. |
| `_entityId` | Relation, EntityReaction | UUID of the linked entity. Required. Stored as plain UUID, not `tapp://`. |
| `_fromMetadata` | Entity, List (traversal responses) | Snapshot of the relation's list side managed fields. Fetched fresh at query time — not a cached value. |
| `_toMetadata` | Entity, List (traversal responses) | Snapshot of the relation's entity side managed fields. Fetched fresh at query time — not a cached value. |
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

The `_parents` field uses `tapp://` URIs to reference parent records. This scheme is used throughout Tarcinapp for internal record cross-references.

**Format:** `tapp://localhost/{recordType}/{uuid}`

The `{recordType}` segment uses the **singular** form matching EPS's internal model names:

| Record type | URI segment |
|:---|:---|
| Entity | `entity` |
| List | `list` |
| EntityReaction | `entity-reaction` |
| ListReaction | `list-reaction` |

> **Important:** `_listId` and `_entityId` on Relation and Reaction records are **plain UUIDs**, not `tapp://` URIs. Only `_parents` (and arbitrary custom fields when using the Lookup feature) use the `tapp://` scheme.

**Examples:**
- `tapp://localhost/entity/a1b2c3d4-...` — reference to an entity
- `tapp://localhost/list/e5f6g7h8-...` — reference to a list
- `tapp://localhost/entity-reaction/d9e0f1a2-...` — reference to a reaction (e.g., parent in a thread)

**How it works:**
- When a record has `_parents: ["tapp://localhost/entity/abc123"]`, EPS tracks the hierarchy.
- EPS automatically updates the parent's `_children` array when `_parents` is set.
- `_parentsCount` is computed from the `_parents` array length and cached for efficient filtering.

**Lookups:** Any field (not just `_parents`) can hold a `tapp://` URI. The `filter[lookup]` query parameter resolves these references at query time. If the caller is not authorized to see the referenced record (authorization check fails), EPS returns `null` for that field in the response rather than raising an error. Lookup resolution is subject to the same authorization rules as direct record access.

**Lookup constraints:** The `ENTITY_LOOKUP_CONSTRAINT` environment variable (and its per-type siblings) can validate that `tapp://` URIs in a given field point to the correct record type and `_kind` at create/replace time. Violations return `422` with codes `ENTITY-INVALID-LOOKUP-REFERENCE` or `ENTITY-INVALID-LOOKUP-KIND`.

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

When the child is deleted, EPS automatically removes it from the parent's `_children` array.

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
| `public` | All authenticated users — **but only when the record is `active`**. |

**Set filter names:**
- `sets[publics]` — public records
- `sets[protecteds]` — protected records
- `sets[privates]` — private records

### Key visibility nuances

**`public` + `pending` combination:**  
A record that is `_visibility: public` but still in `pending` state (i.e., `_validFromDateTime` is null or in the future) is **NOT accessible to the general public**. Public visibility only takes effect when the record is `active`. A pending record is only visible to its owner and admin/editor roles, regardless of its `_visibility` setting. This is enforced by OPA policies and is a common source of confusion.

**`_viewerUsers` and `_viewerGroups`:**  
These fields grant **READ-ONLY** access to specific users or groups who are not owners. Viewers can see the record but cannot modify it. Viewer access is only effective when the record is `active` — viewers cannot see `pending` or `expired` records.

The gateway automatically injects the appropriate `sets` filters for each request based on the caller's identity and OPA policies, ensuring callers never see records they should not access — even if they construct queries that would theoretically match them.

The full visibility × activeness matrix is documented in `21_CONCEPT_security-and-authorization.md §Ownership and Visibility Interaction Matrix`.

---

## List-Entity Relations: Detail

When an entity is added to a list via `POST /lists/{listId}/entities`, EPS creates a `list-entity-relation` record behind the scenes. This record:
- Has `_listId` and `_entityId` set automatically
- Can carry any additional custom metadata you pass in the request body
- Is accessible directly at `/relations/{id}` or via traversal at `/lists/{listId}/entities`

**Traversal response metadata:**  
When querying `GET /lists/{listId}/entities`, each result object includes:
- `_fromMetadata`: a snapshot of the **list's** managed fields (e.g., `_id`, `_name`, `_kind`, `_visibility` of the list)
- `_toMetadata`: a snapshot of the **entity's** managed fields

These are denormalized snapshots fetched **fresh at query time** — they are not cached values stored in the relation document. They are populated by EPS during query resolution.

**Adding metadata to an existing relation:**  
The join record ID returned from the traversal or relation endpoints can be used to patch arbitrary metadata onto the relationship:
```json
PATCH /relations/{joinId}
{ "addedNote": "Must read before volume 2", "position": 3 }
```
This updates the relation record without affecting the linked list or entity.

**Relation authorization reminder:**  
Relations have no `_ownerUsers`. Authorization is derived from the list (must own to create/modify/delete) and the entity (must be able to view to create). See `21_CONCEPT_security-and-authorization.md §Relation Authorization`.

---

## Idempotency Key

EPS supports configurable idempotency to prevent duplicate records on retried requests.

### How it works

1. At record creation time, EPS computes an `_idempotencyKey` — a hash of the values of a configured set of fields on the incoming record.
2. If an existing record in the same collection already has the same `_idempotencyKey`, EPS treats the request as a duplicate and **returns the existing record** with HTTP `200 OK` instead of creating a new one (`201 Created`).
3. The `_idempotencyKey` field is never returned in API responses but is available for direct `filter[where]` querying.

### Configuration

Idempotency fields are configured per record type, with optional per-kind overrides:

```bash
IDEMPOTENCY_ENTITY=               # e.g.: kind,name,createdBy
IDEMPOTENCY_ENTITY_FOR_BOOK=      # override for _kind=book
IDEMPOTENCY_LIST=
IDEMPOTENCY_LIST_ENTITY_REL=
IDEMPOTENCY_ENTITY_REACTION=
IDEMPOTENCY_LIST_REACTION=
```

> **Important:** Idempotency field names are specified **without** the underscore prefix and **before** managed field population. Use `name` (not `_name`), `kind` (not `_kind`), `createdBy` (not `_createdBy`). This is because the hash is computed before slug generation and other auto-fill steps run.

### Known limitation

If the earlier idempotent record was created as `_visibility: private` by a different user, a later caller may receive a `200 OK` indicating a duplicate was detected, yet be unable to read or act on that record (it is private and owned by someone else). This is a documented design gap in the idempotency system.

---

## Related Documents
- `00_SYSTEM_MANIFEST.md §4` — Managed fields table (concise version)
- `10_COMPONENT_entity-persistence-service.md` — Configuration: allowed kinds, uniqueness, record limits, idempotency env vars
- `21_CONCEPT_security-and-authorization.md` — How visibility and ownership drive access control; the full visibility × activeness matrix
- `23_CONCEPT_query-language.md` — Filtering by managed fields, sets, and lookup resolution
