# 10_COMPONENT_entity-persistence-service.md

## Component Identity

**Repository:** `entity-persistence-service`  
**Technology:** Node.js · LoopBack 4 · MongoDB  
**Layer:** V — Data, Search & Storage  
**Default port:** `3000`  
**Source of truth for its own docs:** [`entity-persistence-service/README.md`](../../entity-persistence-service/README.md) and [`openapi.json`](../../entity-persistence-service/openapi.json)

---

## What It Is

`entity-persistence-service` is the **generic, business-logic-free REST backend** that stores and retrieves all data in the Tarcinapp suite. It is intentionally dumb by design: it performs no authentication, no authorization, no field masking, and no ownership enforcement. All of that lives in the Gateway and OPA layers above it.

It is built on [LoopBack 4](https://loopback.io) and exposes a rich, well-structured REST API over MongoDB. When a request reaches this service, it has already been authenticated, authorized, and transformed by the Gateway. The service's job is to persist the result.

> **IMPORTANT:** Never expose this service directly to the internet. Always place the `entity-persistence-gateway` in front of it. Querying EPS directly will return all records regardless of visibility, ownership, or role.

---

## Data Model Overview

All data lives in five MongoDB collections, each mapped to a generic record type:

| Collection | Record type | Typical use |
|:---|:---|:---|
| `entities` | Entity | Primary domain objects (products, posts, profiles, devices) |
| `lists` | List | Grouping/collection objects (playlists, carts, folders) |
| `list-entity-relations` | ListEntityRelation (Relation) | Many-to-many link between a list and an entity |
| `entity-reactions` | EntityReaction | User interaction on an entity (like, review, measurement) |
| `list-reactions` | ListReaction | User interaction on a list (like, comment, flag) |

Every record is decorated with **managed fields** (underscore-prefixed). See `00_SYSTEM_MANIFEST.md §4` for the canonical managed field table.

### Key architectural decisions
- **Schema-less by default**: each record can hold arbitrary JSON alongside its managed fields.
- **`_kind` discriminator**: all records within a collection are differentiated by the `_kind` field. The gateway uses this to project domain endpoints (e.g., `_kind=book` → `/books`).
- **Hierarchies**: Entities, Lists, EntityReactions, and ListReactions all support `_parents` / `_children` trees. Relations do not.
- **`tapp://` URI references**: any field value can be a `tapp://localhost/{recordType}/{uuid}` URI, which the service resolves at query time through the Lookup mechanism.

---

## Controller Reference (67 endpoints)

### EntityController — 11 routes
| Method | Path | Description |
|:---|:---|:---|
| `POST` | `/entities` | Create entity |
| `GET` | `/entities` | Find entities (with filter) |
| `PATCH` | `/entities` | Update all matching entities |
| `GET` | `/entities/count` | Count matching entities |
| `GET` | `/entities/{id}` | Find by ID |
| `PUT` | `/entities/{id}` | Replace by ID |
| `PATCH` | `/entities/{id}` | Update by ID |
| `DELETE` | `/entities/{id}` | Delete by ID |
| `GET` | `/entities/{id}/parents` | Get parent entities |
| `GET` | `/entities/{id}/children` | Get child entities |
| `POST` | `/entities/{id}/children` | Create a child entity |

### ListController — 11 routes
Same pattern as EntityController, under `/lists`.

### ListEntityRelController (Relations) — 8 routes
`POST /relations`, `GET /relations`, `PATCH /relations`, `GET /relations/count`, `GET /relations/{id}`, `PUT /relations/{id}`, `PATCH /relations/{id}`, `DELETE /relations/{id}`. **No hierarchy routes** — relations are flat.

### EntitiesThroughListController — 4 routes
| Method | Path | Description |
|:---|:---|:---|
| `GET` | `/lists/{id}/entities` | Find entities in a list |
| `POST` | `/lists/{id}/entities` | Add entity to list (creates a Relation record) |
| `PATCH` | `/lists/{id}/entities` | Update all entities in a list |
| `DELETE` | `/lists/{id}/entities` | Remove entities from list |

### ListsThroughEntitiesController — 1 route
| Method | Path | Description |
|:---|:---|:---|
| `GET` | `/entities/{id}/lists` | Find lists containing an entity |

### EntityReactionController — 11 routes
Same pattern as EntityController, under `/entity-reactions`. Supports hierarchy.

### ReactionsThroughEntityController — 4 routes
`GET/POST/PATCH/DELETE /entities/{id}/reactions`

### ListReactionController — 11 routes
Same pattern, under `/list-reactions`. Supports hierarchy.

### ReactionsThroughListsController — 4 routes
`GET/POST/PATCH/DELETE /lists/{id}/reactions`

### PingController — 1 route
`GET /ping` — Health check. Returns `200 OK`.

---

## Configuration (Environment Variables)

### Database
| Env var | Default | Description |
|:---|:---|:---|
| `DB_HOST` | `localhost` | MongoDB host |
| `DB_PORT` | `27017` | MongoDB port |
| `DB_DATABASE` | `tarcinapp` | Database name |
| `DB_USER` | _(none)_ | MongoDB user |
| `DB_PASS` | _(none)_ | MongoDB password |

If no database is configured, the service auto-starts an **in-memory MongoDB** instance (for development/testing only).

### Allowed Kinds
Restrict which `_kind` values are accepted per record type:

```bash
APP_ALLOWED_KINDS_ENTITIES=book,product,article
APP_ALLOWED_KINDS_LISTS=bookshelf,playlist
APP_ALLOWED_KINDS_RELATIONS=book-in-shelf
APP_ALLOWED_KINDS_ENTITYREACTIONS=review,rating
APP_ALLOWED_KINDS_LISTREACTIONS=like,comment
```

If not set, any `_kind` value is accepted.

### Uniqueness Constraints
Enforce uniqueness across a configurable set of fields and scope:

```bash
# Format: APP_UNIQUENESS_<N>_KIND, _FIELDS, _SCOPE
APP_UNIQUENESS_0_KIND=book
APP_UNIQUENESS_0_FIELDS=_name
APP_UNIQUENESS_0_SCOPE=global              # global | user | group
```

On violation, returns `409 Conflict` with error code `UNIQUENESS-VIOLATION`.

### Auto Approve
Control whether new records are approved (`_validFromDateTime` set) automatically:

```bash
APP_AUTOAPPROVE_ENTITIES=true              # default: false
APP_AUTOAPPROVE_LISTS=false
```

When `false`, new records are created in `pending` state (`_validFromDateTime` = null) until a gateway filter or admin sets it.

### Visibility Default
Default `_visibility` for new records per type:

```bash
APP_DEFAULT_VISIBILITY_ENTITIES=private   # public | protected | private
APP_DEFAULT_VISIBILITY_LISTS=private
```

### Response Limits
Maximum records returned per request:

```bash
APP_RESPONSE_LIMIT_ENTITIES=100
APP_RESPONSE_LIMIT_LISTS=50
```

### Record Limits
Prevent users from creating too many records of a given kind. Supports dynamic interpolation using `{userId}`, `{groupId}`, etc.:

```bash
# Max 5 books per user
APP_RECORD_LIMITS_0_KIND=book
APP_RECORD_LIMITS_0_MAX=5
APP_RECORD_LIMITS_0_SCOPE=user
```

On violation, returns `422 Unprocessable Entity` with code `RECORD-LIMIT-EXCEEDED`.

### Idempotency
Configure which fields contribute to the idempotency key:

```bash
APP_IDEMPOTENCY_FIELDS_ENTITIES=_kind,_name,_createdBy
```

Prevents duplicate creation when the same combination of fields is submitted within the idempotency window.

---

## Query Language

EPS uses a structured query string notation (LoopBack filter syntax). The Gateway adds simplified aliases on top.

### `filter[where]` — Conditional filtering
Supports operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `inq`, `nin`, `between`, `like`, `nlike`, `ilike`, `nilike`, `exists`, `regexp`.

```
GET /entities?filter[where][_kind]=product
GET /entities?filter[where][score][gte]=100&filter[where][score][type]=number
GET /entities?filter[where][and][0][_kind]=book&filter[where][and][1][_visibility]=public
```

For `count`, `updateAll`, `deleteAll` use the `where[...]` shorthand (no `filter` wrapper).

### `filter[fields]` — Field projection
```
GET /entities?filter[fields][_name]=true&filter[fields][score]=true
```
`_kind` is always included regardless of field selection (security constraint).

### `filter[order]` — Sorting
```
GET /entities?filter[order]=_createdDateTime%20DESC
```

### `filter[limit]` / `filter[skip]` — Pagination
```
GET /entities?filter[limit]=20&filter[skip]=40
```

### `filter[include]` — Relation eager loading
```
GET /lists?filter[include][0][relation]=_entities&filter[include][1][relation]=_reactions
GET /entities?filter[include][0][relation]=_reactions
```

### `sets` — Semantic state/visibility filters
Pre-defined semantics applied as query scope:

| Set | Meaning |
|:---|:---|
| `sets[actives]=true` | `_validFromDateTime` in past AND (`_validUntilDateTime` null OR in future) |
| `sets[pendings]=true` | `_validFromDateTime` null OR in future |
| `sets[expireds]=true` | `_validUntilDateTime` in past |
| `sets[publics]=true` | `_visibility = "public"` |
| `sets[protecteds]=true` | `_visibility = "protected"` |
| `sets[privates]=true` | `_visibility = "private"` |
| `sets[owners][userIds]={id}` | `_ownerUsers` contains the given user ID |

The gateway injects appropriate sets based on the caller's identity before the request reaches this service.

### `filter[lookup]` — Reference resolution
Resolve `tapp://` URI values in fields at query time:
```
GET /entities?filter[lookup][0][prop]=company
GET /entities?filter[lookup][0][prop]=tags&filter[lookup][0][scope][where][_kind]=tag
```
Supports nested lookups, array fields, and scoped filters.

### `through` filters — Metadata on join records
When querying through a relation (e.g., `/lists/{id}/entities`), access join-record fields:
```
GET /lists/{id}/entities?filter[where][through][addedBy]=user123
```

---

## Error Codes Reference (selected)

| Code | HTTP | Meaning |
|:---|:---|:---|
| `UNIQUENESS-VIOLATION` | 409 | A record with the same uniqueness key already exists |
| `RECORD-LIMIT-EXCEEDED` | 422 | User/global record limit reached for this kind |
| `IMMUTABLE-ENTITY-KIND` | 422 | Attempt to change `_kind` on an existing record |
| `INVALID-KIND` | 422 | `_kind` value not in allowed kinds list |
| `IDEMPOTENCY-CONFLICT` | 409 | Duplicate request detected via idempotency key |

---

## Local Development

```bash
cd entity-persistence-service
cp dev.env .env
npm install
npm start         # starts on :3000, uses in-memory MongoDB if DB_HOST not set
```

See [`DEVELOPING.md`](../../entity-persistence-service/DEVELOPING.md) for test setup and lint config.

---

## Related Documents
- `00_SYSTEM_MANIFEST.md` — Managed fields table, record type overview
- `11_COMPONENT_entity-persistence-gateway.md` — How the gateway wraps EPS
- `20_CONCEPT_data-model.md` — Deep dive into all five record types
- `23_CONCEPT_query-language.md` — Full query reference including gateway-level simplifications
