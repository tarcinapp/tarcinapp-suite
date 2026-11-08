# 10_COMPONENT_entity-persistence-service.md

## Component Identity

**Repository:** `entity-persistence-service`  
**Technology:** Node.js (22 / 24 / 26) · LoopBack 4 (`@loopback/core ^7.0.15`, `@loopback/rest ^16.0.0`, `@loopback/repository ^9.0.0`) · MongoDB (`loopback-connector-mongodb ^8.0.0`)  
**Layer:** V — Data, Search & Storage  
**Default port:** `3000` (docker run maps to `30003:3000`)  
**Source of truth for its own docs:** [`entity-persistence-service/README.md`](../../entity-persistence-service/README.md) and [`openapi.json`](../../entity-persistence-service/openapi.json)

---

## What It Is

`entity-persistence-service` is the **generic, business-logic-free REST backend** that stores and retrieves all data in the Tarcinapp suite. It is intentionally dumb by design: it performs no authentication, no authorization, no field masking, and no ownership enforcement. All of that lives in the Gateway and OPA layers above it.

It is built on [LoopBack 4](https://loopback.io) and exposes a rich, well-structured REST API over MongoDB. When a request reaches this service, it has already been authenticated, authorized, and transformed by the Gateway. The service's job is to persist the result.

> **IMPORTANT:** Never expose this service directly to the internet. Always place the `entity-persistence-gateway` in front of it. Querying EPS directly will return all records regardless of visibility, ownership, or role.

**Cross-reference:** How the gateway wraps this service, adds auth context, injects sets, and projects domain kinds is covered in [`11_COMPONENT_entity-persistence-gateway.md`](./11_COMPONENT_entity-persistence-gateway.md).

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

Collection names are **configurable** (see `COLLECTION_*` env vars below). Defaults: `GenericEntities`, `Lists`, `ListEntityRelations`, `EntityReactions`, `ListReactions`.

Every record is decorated with **managed fields** (underscore-prefixed). See [`00_SYSTEM_MANIFEST.md`](./00_SYSTEM_MANIFEST.md) §4 for the canonical managed field table. See [`20_CONCEPT_data-model.md`](./20_CONCEPT_data-model.md) for a deep dive into all five record types.

### Key architectural decisions
- **Schema-less by default**: each record can hold arbitrary JSON alongside its managed fields (`additionalProperties: true` on all models).
- **`_kind` discriminator**: all records within a collection are differentiated by the `_kind` field. The gateway uses this to project domain endpoints (e.g., `_kind=book` → `/books`). `_kind` is **always** returned in responses — it cannot be excluded via `filter[fields]`.
- **`_kind` is immutable after creation**: once set, a record's `_kind` cannot be changed. Attempt triggers `IMMUTABLE-*-KIND` (422).
- **Hierarchies**: Entities, Lists, EntityReactions, and ListReactions all support `_parents` / `_children` trees (via `_parents` array field and `_parentsCount` counter). Relations do **not** have hierarchy routes.
- **`tapp://` URI references**: any field value can be a `tapp://localhost/{recordType}/{uuid}` URI, which the service resolves at query time through the Lookup mechanism.
- **`_version` field**: automatically incremented on every `PUT`/`PATCH` on a single record. **Not** incremented by bulk `updateAll`.

---

## Controller Reference (67 endpoints)

There are 12 controller source files with routes in [`entity-persistence-service/src/controllers/`](../../entity-persistence-service/src/controllers/) (plus `index.ts` which is a re-export barrel with no routes of its own).

### EntityController — 11 routes
| Method | Path | Description |
|:---|:---|:---|
| `POST` | `/entities` | Create entity |
| `GET` | `/entities` | Find entities (with filter + sets + lookup) |
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
Same pattern as EntityController, under `/lists`. Supports hierarchy (`/lists/{id}/parents`, `/lists/{id}/children`).

### ListEntityRelController (Relations) — 8 routes
`POST /relations`, `GET /relations`, `PATCH /relations`, `GET /relations/count`, `GET /relations/{id}`, `PUT /relations/{id}`, `PATCH /relations/{id}`, `DELETE /relations/{id}`. **No hierarchy routes** — relations are flat. Accepts `entityFilter`/`listFilter` parameters to filter connected records.

### EntitiesThroughListController — 4 routes
| Method | Path | Description |
|:---|:---|:---|
| `GET` | `/lists/{id}/entities` | Find entities in a list (accepts `filterThrough` to filter the relation record itself) |
| `POST` | `/lists/{id}/entities` | Add entity to list (creates a Relation record) |
| `PATCH` | `/lists/{id}/entities` | Update all entities in a list (accepts `whereThrough`) |
| `DELETE` | `/lists/{id}/entities` | Remove entities from list |

### ListsThroughEntitiesController — 1 route
| Method | Path | Description |
|:---|:---|:---|
| `GET` | `/entities/{id}/lists` | Find lists containing an entity |

### EntityReactionController — 11 routes
Same pattern as EntityController, under `/entity-reactions`. Supports hierarchy. Accepts `entityFilter`/`entityWhere`/`entitySet` to filter reactions by the properties of the connected entity.

### ReactionsThroughEntityController — 4 routes
`GET/POST/PATCH/DELETE /entities/{id}/reactions`

### ListReactionController — 11 routes
Same pattern, under `/list-reactions`. Supports hierarchy.

### ReactionsThroughListsController — 4 routes
`GET/POST/PATCH/DELETE /lists/{id}/reactions`

### PingController — 1 route
`GET /ping` — Health check. Returns `200 OK` with `{ greeting, date, url, headers }`.

### SystemInfoController — 1 route
`GET /system-info` — Returns system uptime (seconds + human-readable) and the full resolved application configuration derived from environment variables. Sensitive values (e.g. `mongodb_password`) are **masked or excluded**. See [System Info Endpoint](#system-info-endpoint) below.

---

## System Info Endpoint

`GET /system-info` is a diagnostics endpoint that exposes the running service's state without requiring a database round-trip for most fields.

**Response shape:**
```json
{
  "uptime": {
    "seconds": 3761.4,
    "formatted": "1h 2m 41s"
  },
  "startedAt": "2025-01-15T09:00:00.000Z",
  "currentTime": "2025-01-15T10:02:41.000Z",
  "configuration": {
    "nodeEnv": "production",
    "logging": { "level": "info", "format": "json", "timestamp": "true", "service": "entity-persistence-service", "requestIdHeader": "X-Request-ID" },
    "server": { "host": "localhost", "port": 3000 },
    "database": { "url": "mongodb+srv://tapp:***@cluster0.../tappdb", "database": "tappdb", "host": "...", "port": "...", "user": "tapp" },
    "collections": { "entity": "GenericEntities", "list": "Lists", "entityReactions": "EntityReactions", "listReactions": "ListReactions", "listEntityRel": "ListEntityRelations" },
    "allowedKinds": { "entity": ["book","author"], "list": ["bookshelf"], ... },
    "uniqueness": { "entity": "where[_kind]=${_kind}&where[_slug]=${_slug}", ... },
    "responseLimits": { "entity": 100, "list": 100, ... },
    "recordLimits": { "entity": "[{\"scope\":\"\",\"limit\":500}]", ... }
  }
}
```

> **Security note:** Do not expose `GET /system-info` publicly; it reveals full configuration including collection names, kind constraints, and uniqueness rules.

---

## Configuration (Environment Variables)

All configuration is read from environment variables (case-insensitive). The [`entity-persistence-service/dev.env`](../../entity-persistence-service/dev.env) file is the canonical reference for local development.

### Database

| Env var | Default | Description |
|:---|:---|:---|
| `MONGODB_HOST` | `localhost` | MongoDB host |
| `MONGODB_PORT` | `27017` | MongoDB port |
| `MONGODB_DATABASE` | `tappdb` | Database name |
| `MONGODB_USER` | `tappuser` | MongoDB user |
| `MONGODB_PASSWORD` | `tapppass123!` | MongoDB password — provide via k8s Secret |
| `MONGODB_URL` | _(none)_ | Full connection URL; **takes precedence** over individual host/port/user/pass fields. Supports Atlas SRV URIs: `mongodb+srv://user:pass@cluster0.xxx.mongodb.net/tappdb?appName=...` |

> **Note:** The old `DB_HOST` / `DB_PORT` naming seen in some early drafts is **incorrect**. The real variable names are `MONGODB_HOST`, `MONGODB_PORT`, `MONGODB_DATABASE`, `MONGODB_USER`, `MONGODB_PASSWORD`, and `MONGODB_URL` as shown in [`dev.env`](../../entity-persistence-service/dev.env).

If neither individual fields nor `MONGODB_URL` is set, the service auto-starts an **in-memory MongoDB** instance (`mongodb-memory-server`) — for development/testing only.

### Server

| Env var | Default | Description |
|:---|:---|:---|
| `HOST` | `localhost` | Bind address |
| `PORT` | `3000` | Listen port |
| `NODE_ENV` | `development` | Node environment |

### Logging

| Env var | Default | Description |
|:---|:---|:---|
| `LOG_LEVEL` | `debug` | Winston log level (`debug`, `info`, `warn`, `error`) |
| `LOG_FORMAT` | `json` | Log format (`json` or `text`) |
| `LOG_TIMESTAMP` | `true` | Include timestamps in logs |
| `LOG_SERVICE` | `entity-persistence-service` | Service name tag in logs |
| `REQUEST_ID_HEADER` | `X-Request-ID` | Header name for request ID propagation |

### Collection Names

| Env var | Default | Description |
|:---|:---|:---|
| `COLLECTION_ENTITY` | `GenericEntities` | MongoDB collection for entities |
| `COLLECTION_LIST` | `Lists` | MongoDB collection for lists |
| `COLLECTION_LIST_ENTITY_REL` | `ListEntityRelations` | MongoDB collection for list-entity relations |
| `COLLECTION_ENTITY_REACTIONS` | `EntityReactions` | MongoDB collection for entity reactions |
| `COLLECTION_LIST_REACTIONS` | `ListReactions` | MongoDB collection for list reactions |

### Allowed Kinds

Restrict which `_kind` values are accepted per record type. If unset, any `_kind` value is accepted. Violation returns `422` with code `INVALID-*-KIND`.

```bash
ENTITY_KINDS=book,author,chapter
LIST_KINDS=bookshelf,library
LIST_ENTITY_REL_KINDS=contains
ENTITY_REACTION_KINDS=like,comment,rating,flag,review
LIST_REACTION_KINDS=like,comment,rating,flag,review
```

> **Normalization is EPBO's responsibility.** Default `_kind`, default `_visibility`, `_validFromDateTime` auto-approve, `_validUntilDateTime` null-coercion, and `_slug` derivation are all computed by `entity-persistence-base-orchestrator` (EPBO) before the request reaches EPS. See [`16_COMPONENT_entity-persistence-base-orchestrator.md`](./16_COMPONENT_entity-persistence-base-orchestrator.md) and [`31_OPS_configuration-reference.md`](./31_OPS_configuration-reference.md) for the EPBO configuration schema. EPS is a pure schema-validating persistence store — it does not inject or compute these fields.

> **Idempotency is client-supplied.** There is no stack-level `_idempotencyKey` computation. Callers supply an `X-Idempotency-Key` request header; the Gateway uses it as the distributed lock key.

### Uniqueness Constraints

Enforce record-level uniqueness using a **query-like filter template** syntax. Multiple rules are separated by commas (`,`). Within each rule, conditions are joined by `&`. Field values from the incoming record are interpolated using `${fieldName}`.

```bash
ENTITY_UNIQUENESS="where[_kind]=${_kind}&where[_slug]=${_slug}"
LIST_UNIQUENESS="where[_kind]=${_kind}&where[_slug]=${_slug}"
RELATION_UNIQUENESS="where[_listId]=${_listId}&where[_entityId]=${_entityId}&where[_kind]=${_kind}"
ENTITY_REACTION_UNIQUENESS="where[_kind]=like&where[_entityId]=${_entityId}&set[actives]&set[publics]&set[owners],where[_kind]=review&where[_entityId]=${_entityId}&set[actives]&set[publics]&set[owners]"
LIST_REACTION_UNIQUENESS="where[_kind]=like&where[_entityId]=${_entityId}&set[actives]&set[publics]&set[owners],where[_kind]=review&where[_entityId]=${_entityId}&set[actives]&set[publics]&set[owners]"
```

**Configuration syntax components:**

1. **Field conditions** — `where[fieldName]=${fieldName}`: the service queries for existing records where this field equals the incoming record's value.
2. **Scope narrowing with sets** — `set[actives]`, `set[publics]`, etc.: only check uniqueness *within* the named set (e.g., only check for duplicates among active records).
3. **Scope narrowing with static where clauses** — `where[status]=approved`: only check within records matching this literal condition.
4. **Multiple rules** — separate complete rules with `,`: each rule is evaluated independently and any violation triggers a 409.
5. **Template interpolation** — `${_kind}`, `${_slug}`, `${_name}`, `${_listId}`, `${_entityId}`, `${department}`, etc. Any field present on the incoming record can be referenced.

**Per-owner uniqueness with `set[owners]`:**

`set[owners]` scopes the uniqueness check to records that share the same owner(s) as the incoming record. When combined with `${_ownerUsers}` interpolation it means: *"check for duplicates only among records owned by the same user(s)"*. This makes uniqueness **per-owner** rather than global.

```bash
ENTITY_UNIQUENESS="where[_kind]=${_kind}&where[_slug]=${_slug}&set[owners][userIds]=${_ownerUsers}"
```

With this rule:
- User 1 creates a `book` with `_slug: the-great-gatsby` → **allowed** (no existing book with this slug owned by user 1)
- User 2 creates a `book` with `_slug: the-great-gatsby` → **allowed** (the duplicate check is scoped to user 2's records; user 1's record is not counted)
- User 1 creates a **second** `book` with `_slug: the-great-gatsby` → **409** (user 1 already owns a book with this slug)

Without `set[owners]`, the rule `where[_kind]=${_kind}&where[_slug]=${_slug}` would be global: user 2 would also receive a 409 because user 1's record already exists with that slug, regardless of ownership.

> **`_ownerUsers` is an array field.** When the incoming record has `_ownerUsers: ["user-1", "user-2"]` (co-ownership), `${_ownerUsers}` interpolates to `user-1,user-2` and `set[owners][userIds]` checks against all named users. A duplicate is flagged if any record exists that is owned by *any* of those users and matches the other conditions.

**Practical examples:**

```bash
# Slug unique globally per kind (cross-user: no two users can have the same slug)
ENTITY_UNIQUENESS="where[_kind]=${_kind}&where[_slug]=${_slug}"

# Slug unique per owner per kind (each user has their own slug namespace)
ENTITY_UNIQUENESS="where[_kind]=${_kind}&where[_slug]=${_slug}&set[owners][userIds]=${_ownerUsers}"

# Name unique among active records only
ENTITY_UNIQUENESS="where[_name]=${_name}&set[actives]"

# Two rules: global name uniqueness AND slug uniqueness among actives
ENTITY_UNIQUENESS="where[_name]=${_name},where[_slug]=${_slug}&set[actives]"

# Name unique per department among active public records
ENTITY_UNIQUENESS="where[_name]=${_name}&where[department]=${department}&set[actives]&set[publics]"

# One user can have at most one active like or review per entity
ENTITY_REACTION_UNIQUENESS="where[_kind]=like&where[_entityId]=${_entityId}&set[actives]&set[owners],where[_kind]=review&where[_entityId]=${_entityId}&set[actives]&set[owners]"
```

> **Concurrency enforcement by `entity-persistence-cache` (EPC):** Unlike record limits (which have an opt-in `enforceSerialisation` flag for wide-scope rules), uniqueness rules are **always** enforced with a distributed Redis lock by EPC. This is safe because every valid uniqueness rule must contain at least one interpolatable field — the lock key is therefore always scoped to specific runtime values (e.g. a specific kind + slug + user) and never global. No additional configuration is required. See [`15_COMPONENT_entity-persistence-cache.md`](./15_COMPONENT_entity-persistence-cache.md) for the full locking design.

**Error response on violation** — HTTP 409:
```json
{
  "error": {
    "statusCode": 409,
    "name": "UniquenessViolationError",
    "message": "Entity already exists",
    "code": "ENTITY-UNIQUENESS-VIOLATION",
    "status": 409,
    "details": [{ "code": "ENTITY-UNIQUENESS-VIOLATION", "message": "Entity already exists", "info": { "scope": "where[_kind]=book&where[_slug]=the-great-gatsby" } }]
  }
}
```
> The `info.scope` field echoes back the fully interpolated uniqueness rule that was violated, useful for debugging.

During PATCH/PUT on an existing record the service automatically excludes the record's own `_id` from the uniqueness count so a no-change update does not self-conflict.

### Response Limits

Maximum records returned per request. If a caller requests more via `filter[limit]` it is **silently capped**. Default is 50 for all types.

```bash
RESPONSE_LIMIT_ENTITY=100
RESPONSE_LIMIT_LIST=100
RESPONSE_LIMIT_LIST_ENTITY_REL=100
RESPONSE_LIMIT_ENTITY_REACTION=100
RESPONSE_LIMIT_LIST_REACTION=100
```

### Record Limits

Prevent over-creation of records. Configured as a **JSON array** per record type. Each element defines a `scope` (filter expression), a `limit` (maximum count), and an optional `duration` (sliding time window).

```bash
# Format: JSON array
ENTITY_RECORD_LIMITS='[{"scope":"","limit":2,"duration":"1min"},{"scope":"","limit":500}]'
LIST_RECORD_LIMITS='[{"scope":"","limit":500}]'
RELATION_RECORD_LIMITS='[{"scope":"","limit":500}]'
ENTITY_REACTION_RECORD_LIMITS='[{"scope":"","limit":1000}]'
LIST_REACTION_RECORD_LIMITS='[{"scope":"","limit":1000}]'
```

**Configuration schema:**
```json
[
  {
    "scope": "string",              // Filter expression: "" = global, or where/set clauses
    "limit": 100,                   // Maximum number of records matching the scope
    "duration": "30d",              // OPTIONAL: sliding time window (counts only records created within this window)
    "enforceSerialisation": false   // OPTIONAL: when true, signals entity-persistence-cache (EPC) to acquire
                                    // a distributed lock for this rule even when scope has no interpolatable
                                    // fields. EPS itself ignores this field — it is a passthrough consumed
                                    // by EPC via /system-info. Default: false (best-effort).
  }
]
```

**`scope` field syntax:**
- `""` — global limit across all records of this type
- `where[field]=value` — limit scoped to matching records
- `set[actives]`, `set[publics]`, etc. — limit scoped to named set
- `&`-joined combinations: `set[actives]&set[publics]&where[_kind]=book`
- `${fieldName}` interpolation using the **incoming** record's field values: `where[_listId]=${_listId}`, `where[_ownerUsers]=${_ownerUsers}`

**`duration` field — supported units:**
| Unit | Accepted strings |
|:---|:---|
| Seconds | `s`, `sec`, `secs`, `second`, `seconds` |
| Minutes | `m`, `min`, `mins`, `minute`, `minutes` |
| Hours | `h`, `hour`, `hours` |
| Days | `d`, `day`, `days` |
| Weeks | `w`, `week`, `weeks` |
| Months | `M`, `mo`, `mon`, `month`, `months` (note: uppercase `M` = month, lowercase `m` = minute) |

**Practical examples:**
```bash
# Hard global cap + rate limit: max 2 entities per minute and 500 total
ENTITY_RECORD_LIMITS='[{"scope":"","limit":2,"duration":"1min"},{"scope":"","limit":500}]'

# Per-kind limits: 100 books, 50 movies
ENTITY_RECORD_LIMITS='[{"scope":"where[_kind]=book","limit":100},{"scope":"where[_kind]=movie","limit":50}]'

# Per-user limits: each user can create at most 10 lists
LIST_RECORD_LIMITS='[{"scope":"set[owners][userIds]=${_ownerUsers}","limit":10}]'

# Per-list capacity: each list can contain at most 100 entities
RELATION_RECORD_LIMITS='[{"scope":"where[_listId]=${_listId}","limit":100}]'

# Rate limit with sliding window: max 100 books created in last 30 days
ENTITY_RECORD_LIMITS='[{"scope":"where[_kind]=book","limit":100,"duration":"30d"}]'

# Hard licence/seat cap: max 10 records total, EPC enforces with a global lock
ENTITY_RECORD_LIMITS='[{"scope":"","limit":10,"enforceSerialisation":true}]'

# Mixed: soft burst rate limit (best-effort) + hard global cap (serialised via EPC)
ENTITY_RECORD_LIMITS='[{"scope":"","limit":2,"duration":"1min"},{"scope":"","limit":10,"enforceSerialisation":true}]'
```

**Duration behaviour:**
- When `duration` is set, only records whose `_createdDateTime > (now − duration)` are counted.
- If the incoming record's own `_createdDateTime` is older than `(now − duration)`, the limit check for that entry is **skipped** (it cannot contribute to the window).
- Invalid duration strings are **logged as a warning and ignored** — the limit still applies without the time restriction.
- Limit counting is **not atomic** with the create operation (best-effort). For strict quotas in high-concurrency scenarios, consider database-level strategies.

**Error response on violation** — HTTP 429:
```json
{
  "statusCode": 429,
  "name": "LimitExceededError",
  "message": "Record limit exceeded for entity",
  "code": "ENTITY-LIMIT-EXCEEDED",
  "status": 429,
  "details": [{ "code": "ENTITY-LIMIT-EXCEEDED", "message": "Record limit exceeded for entity", "info": { "limit": 500, "scope": "" } }]
}
```

### Lookup Constraints

Validate `tapp://` URI references at create/replace time. Configured as a JSON array per record type.

```bash
ENTITY_LOOKUP_CONSTRAINT=''
LIST_LOOKUP_CONSTRAINT=''
ENTITY_REACTION_LOOKUP_CONSTRAINT=''
LIST_REACTION_LOOKUP_CONSTRAINT=''
```

Each constraint object:
```json
[
  {
    "propertyPath": "_parents",      // Dot-notation path to the field with tapp:// references
    "record": "entity",              // Expected target type: entity | list | entity-reaction | list-reaction
    "sourceKind": "product",         // OPTIONAL: only apply this rule when source record _kind = this
    "targetKind": "category"         // OPTIONAL: referenced target must have this _kind
  }
]
```

Violation returns `422` with codes like `ENTITY-INVALID-LOOKUP-REFERENCE`, `ENTITY-INVALID-LOOKUP-KIND`, or `ENTITY-INVALID-PARENT-ENTITY-ID`.

---

## Query Language

EPS uses LoopBack 4's structured query-string filter notation. The gateway adds simplified aliases on top — see [`23_CONCEPT_query-language.md`](./23_CONCEPT_query-language.md) for gateway-level query translations.

### `filter[where]` — Conditional filtering

Supports operators: `eq` (implicit), `neq`, `gt`, `gte`, `lt`, `lte`, `inq`, `nin`, `between`, `like`, `nlike`, `ilike`, `nilike`, `exists`, `regexp`.

```
GET /entities?filter[where][_kind]=product
GET /entities?filter[where][views][gte]=100&filter[where][views][type]=number
GET /entities?filter[where][and][0][_kind]=book&filter[where][and][1][_visibility]=public
GET /entities?filter[where][score][between][]=10&filter[where][score][between][]=20
GET /entities?filter[where][tags][inq][]=fiction&filter[where][tags][inq][]=drama
GET /entities?filter[where][metadata.createdBy]=user123
GET /entities?filter[where][email][regexp]=^.+@example\.com$
```

For `count`, `updateAll`, `deleteAll` use the `where[...]` shorthand (no `filter` wrapper):
```
GET /entities/count?where[_kind]=book
PATCH /entities?where[status]=draft
```

**Type hinting for non-string fields:** since all query-string values are strings by default, numeric/boolean comparisons require an explicit type hint unless the request passes through the gateway (which injects types from the kind's JSON schema):
```
# Won't work — "100" compared as string:
GET /entities?filter[where][views][gt]=100

# Correct — type hint added:
GET /entities?filter[where][views][gt]=100&filter[where][views][type]=number
```
Supported type hints: `number`, `boolean`.

**Special literal handling:**
- `true` / `false` string values are **always** coerced to boolean: `filter[where][isActive]=true`
- The string `"null"` is interpreted as an actual **null** value: `filter[where][deletedBy]=null` (matches records where `deletedBy` is null or missing)

### `filter[fields]` — Field projection

```
GET /entities?filter[fields][_name]=true&filter[fields][score]=true
GET /lists?filter[fields][_id]=false&filter[fields][title]=false
```

**`_kind` is always present** regardless of field selection — it cannot be excluded, including in nested includes and lookup results.

**Edge case — arbitrary fields and `false` exclusion:** Due to a LoopBack behaviour, setting any arbitrary (non-schema) field to `false` in `filter[fields]` will exclude **all** other arbitrary fields from the response, even those not explicitly mentioned. Built-in managed fields (like `_id`, `_name`, `_kind`) are unaffected.

### `filter[order]` — Sorting

```
GET /entities?filter[order]=_createdDateTime%20DESC
GET /entities?filter[order]=_kind%20ASC&filter[order]=_name%20DESC
```

### `filter[limit]` / `filter[skip]` — Pagination

```
GET /entities?filter[limit]=20&filter[skip]=40
```

`filter[limit]` is silently capped to the configured `RESPONSE_LIMIT_*` for the resource type.

### `filter[include]` — Relation eager loading

```
GET /lists?filter[include][0][relation]=_entities&filter[include][1][relation]=_reactions
GET /entities?filter[include][0][relation]=_reactions
GET /entities/{id}?filter[include][][relation]=_reactions
```

Include scope supports `where`, `fields`, `limit`, `skip`, `order`, `set`, `lookup`, and nested `include`:
```
GET /entities?filter[include][0][relation]=_reactions&filter[include][0][scope][where][_kind]=like
GET /lists?filter[include][0][relation]=_entities&filter[include][0][scope][order]=_name%20ASC&filter[include][0][scope][limit]=5
```

### `sets` — Semantic state/visibility filters

Pre-defined semantics applied as query scope. The gateway injects appropriate sets based on the caller's identity before requests reach this service. See [`23_CONCEPT_query-language.md`](./23_CONCEPT_query-language.md).

| Set | Meaning |
|:---|:---|
| `sets[actives]=true` | `_validFromDateTime` in past AND (`_validUntilDateTime` null OR in future) |
| `sets[pendings]=true` | `_validFromDateTime` null OR in future |
| `sets[expireds]=true` | `_validUntilDateTime` in past |
| `sets[publics]=true` | `_visibility = "public"` |
| `sets[protecteds]=true` | `_visibility = "protected"` |
| `sets[privates]=true` | `_visibility = "private"` |
| `sets[roots]=true` | `_parentsCount = 0` (top-level records only) |
| `sets[owners][userIds]={id}` | `_ownerUsers` or `_ownerGroups` contains the given ID |
| `sets[viewers][userIds]={id}` | `_viewerUsers` or `_viewerGroups` contains the given ID |
| `sets[audience][userIds]={id}` | Combines `actives`, `publics`, and ownership/viewership |

**Dynamic time-windowed sets:**
```
GET /entities?set[createds-7d]=true       # created within last 7 days
GET /entities?set[expireds-10min]=true    # expired within last 10 minutes
GET /entities?set[actives-30d]=true       # became active within last 30 days
GET /entities?set[pendings-2w]=true       # pending and created within last 2 weeks
```
Syntax: `set[<base>-<N><unit>]` where base is `createds|expireds|actives|pendings` and unit is `d|day|w|min|m|mon|mo`.

**Combining sets with other filters:**
```
GET /entities?set[actives]&filter[where][_kind]=config
GET /entities?set[and][0][actives]&set[and][1][publics]&filter[where][_kind]=blog
GET /lists?filter[include][0][relation]=_entities&filter[include][0][set][and][0][actives]&filter[include][0][set][and][1][publics]
```

### `filter[lookup]` — Reference resolution

Resolve `tapp://` URI values in fields at query time:
```
GET /entities?filter[lookup][0][prop]=company
GET /entities?filter[lookup][0][prop]=tags&filter[lookup][0][scope][where][_kind]=tag
```
Supports nested lookups, array fields, and scoped filters. The `_kind` field of looked-up records is always included.

### Relation-level filter parameters

When querying through-endpoints and relation collections, additional filter namespaces are available:

| Parameter | Applicable endpoints | Purpose |
|:---|:---|:---|
| `filterThrough` / `whereThrough` | `/lists/{id}/entities`, `/entities/{id}/lists` | Filter the **relation record** (not the returned entity/list) |
| `listFilter` / `listWhere` / `listSet` | `GET /relations` | Filter by properties of the connected **List** |
| `entityFilter` / `entityWhere` / `entitySet` | `GET /relations`, `GET /entity-reactions` | Filter by properties of the connected **Entity** |
| `setThrough` | Through endpoints | Apply named sets to the relation record |

**Examples:**
```
# Entities in a list where the relation record has _kind=positioned
GET /lists/{id}/entities?filterThrough[where][_kind]=positioned

# Reactions on public entities only
GET /entity-reactions?entityFilter[where][_visibility]=public

# Relations where connected list _kind=featured
GET /relations?listFilter[where][_kind]=featured

# Combined: likes on public entities, max 20
GET /entity-reactions?filter[where][_kind]=like&entityFilter[where][_visibility]=public&filter[limit]=20
```

> **Known limitation:** Dot-notation filtering (e.g., `metadata.status.current`) is **not supported** inside `listFilter` and `entityFilter` parameters when querying connected models. Use bracket-notation for the outer parameters instead: `filter[where][metadata][status][current]=active`.

---

## MongoDB Index Recommendations

EPS does not programmatically create indexes at startup (no `npm run migrate` index step). Indexes must be created manually or via the MongoDB Atlas / ops tooling. The following compound indexes are recommended for production workloads based on the managed fields used by sets, uniqueness checks, and relation queries:

**All collections (entities, lists, entity-reactions, list-reactions):**
```js
// Set queries on state and visibility
db.GenericEntities.createIndex({ _validFromDateTime: 1, _validUntilDateTime: 1 })
db.GenericEntities.createIndex({ _visibility: 1 })
db.GenericEntities.createIndex({ _kind: 1 })
db.GenericEntities.createIndex({ _ownerUsers: 1 })       // multikey — supports owners set
db.GenericEntities.createIndex({ _ownerGroups: 1 })      // multikey
db.GenericEntities.createIndex({ _viewerUsers: 1 })      // multikey
db.GenericEntities.createIndex({ _viewerGroups: 1 })     // multikey
db.GenericEntities.createIndex({ _parents: 1 })          // multikey — supports hierarchy traversal
db.GenericEntities.createIndex({ _parentsCount: 1 })     // supports roots set
db.GenericEntities.createIndex({ _createdDateTime: 1 })  // duration-based record limits and dynamic sets
db.GenericEntities.createIndex({ _slug: 1, _kind: 1 })   // uniqueness checks
```

**Relations collection:**
```js
db.ListEntityRelations.createIndex({ _listId: 1 })
db.ListEntityRelations.createIndex({ _entityId: 1 })
db.ListEntityRelations.createIndex({ _listId: 1, _entityId: 1, _kind: 1 }) // uniqueness
```

---

## Error Codes Reference

All error responses follow `{ error: { statusCode, name, message, code, status, details[] } }`.

| Code | HTTP | Trigger |
|:---|:---|:---|
| `ENTITY-UNIQUENESS-VIOLATION` | 409 | Uniqueness rule matched an existing record. Also: `LIST-`, `RELATION-`, `ENTITY-REACTION-`, `LIST-REACTION-` variants |
| `ENTITY-LIMIT-EXCEEDED` | 429 | Record limit reached for this scope. Also: `LIST-`, `RELATION-`, `ENTITYREACTION-`, `LIST-REACTION-` variants |
| `IMMUTABLE-ENTITY-KIND` | 422 | Attempt to change `_kind` on an existing entity. Also: `IMMUTABLE-LIST-KIND`, `IMMUTABLE-RELATION-KIND`, etc. |
| `IMMUTABLE-ENTITY-ID` | 422 | Attempt to change an immutable identifier field (`_id`, `_entityId`, `_listId`). Also `IMMUTABLE-LIST-ID` |
| `INVALID-ENTITY-KIND` | 422 | `_kind` not in configured allowed-kinds list. Also `INVALID-LIST-KIND`, etc. |
| `SOURCE-RECORD-NOT-MATCH` | 422 | Child reaction `_entityId`/`_listId` does not match parent's |
| `ENTITY-INVALID-LOOKUP-REFERENCE` | 422 | `tapp://` URI format is invalid for the constrained property |
| `ENTITY-INVALID-LOOKUP-KIND` | 422 | Referenced target record does not have the required `_kind` |
| `ENTITY-INVALID-PARENT-ENTITY-ID` | 422 | Parent reaction's `_entityId` does not match child's |
| `RELATION-MISSING-IDS` | 400 | Relation created without both `_entityId` and `_listId` |
| `MALFORMED-QUERY-FILTER` | 400 | `where` / filter expression cannot be parsed (e.g. empty `and`/`or` element) |
| `INVALID-INCLUSION-FILTER` | 400 | `filter[include]` entry is empty, malformed, or references unknown relation |
| `VALIDATION-FAILED` | 422 | Model schema validation failure |
| `ENTITY-NOT-FOUND` | 404 | Entity ID not found. Also `LIST-NOT-FOUND`, `RELATION-NOT-FOUND`, `ENTITY-REACTION-NOT-FOUND`, `LIST-REACTION-NOT-FOUND` |

---

## Known Issues and Limitations

1. **Idempotency + visibility**: If an earlier idempotent record was created as `private`, a later caller may receive a success response for an "idempotent create" but then be unable to read the record (it is private and belongs to someone else). This is a known design gap.

2. **Field selection with arbitrary fields**: Setting any custom (non-schema) field to `false` in `filter[fields]` causes **all** other custom fields to be excluded, even if they were not listed. Managed fields (like `_id`, `_name`, `_kind`) are unaffected.

3. **`_version` not incremented on `updateAll`**: Bulk `PATCH /entities?where[...]` does not increment `_version`. Only single-record `PATCH`/`PUT` /{id} does.

4. **Dot-notation in connected model filters**: In `listFilter` and `entityFilter` on relation queries, dot-notation (e.g., `metadata.status.current`) is not reliably parsed. Use bracket-notation in the outer filter parameters instead.

5. **Uniqueness and record-limit checks are best-effort under concurrent load (TOCTOU)**: Both `checkUniqueness` and `checkLimits` follow a check-then-act pattern: they count existing records, then decide to accept or reject, then insert. Two concurrent requests opening MongoDB transactions at the same moment both see the same snapshot and can both pass the check, producing a duplicate or over-limit record. MongoDB snapshot isolation does not prevent this. **Mitigation:** Deploy `entity-persistence-cache` (EPC) in the topology, which acquires Redis locks keyed on the interpolated uniqueness/limit scope before forwarding requests to EPS, serialising concurrent writes that share the same logical key. For wide-scope global limits (no interpolatable fields in the scope), best-effort behaviour is accepted by design. For scalar uniqueness rules, a MongoDB unique index provides an atomic backstop. See [`25_CONCEPT_concurrency-and-integrity.md`](./25_CONCEPT_concurrency-and-integrity.md) for the full analysis.

6. **No `E11000 → 409` translator**: If a MongoDB unique index catches a duplicate that slipped through all application-level checks, EPS currently surfaces a raw 500 error instead of translating the `E11000 duplicate key` error into a 409 Conflict response. Adding this translator in the repository base class is the recommended hardening step for deployments that rely on database-level unique indexes as a backstop.

---

## Local Development

```bash
cd entity-persistence-service
cp dev.env .env         # contains MONGODB_URL, kind config, etc.
npm install
npm start               # builds then starts on :3000; uses in-memory MongoDB if MONGODB_URL/MONGODB_HOST not set
```

Test commands:
```bash
npm test                        # build + all tests + lint
npm run test:unit               # unit tests only
npm run test:acceptance         # acceptance tests only (spins up mongodb-memory-server)
npm run build:watch             # TypeScript watch mode
```

See [`DEVELOPING.md`](../../entity-persistence-service/DEVELOPING.md) for VSCode setup and lint configuration.

---

## Related Documents

- [`00_SYSTEM_MANIFEST.md`](./00_SYSTEM_MANIFEST.md) — Managed fields table, record type overview
- [`11_COMPONENT_entity-persistence-gateway.md`](./11_COMPONENT_entity-persistence-gateway.md) — How the gateway wraps EPS, injects sets, and projects domain kinds
- [`12_COMPONENT_gateway-policies.md`](./12_COMPONENT_gateway-policies.md) — OPA policies that run before the gateway forwards to EPS
- [`20_CONCEPT_data-model.md`](./20_CONCEPT_data-model.md) — Deep dive into all five record types and managed fields
- [`21_CONCEPT_security-and-authorization.md`](./21_CONCEPT_security-and-authorization.md) — Auth flow and why EPS must never be exposed directly
- [`22_CONCEPT_domain-projection.md`](./22_CONCEPT_domain-projection.md) — How `_kind` drives the gateway's domain endpoint projection
- [`23_CONCEPT_query-language.md`](./23_CONCEPT_query-language.md) — Full query reference including gateway-level simplifications
- [`31_OPS_configuration-reference.md`](./31_OPS_configuration-reference.md) — Complete env var reference for all suite components
- [`33_OPS_deployment-docker-compose.md`](./33_OPS_deployment-docker-compose.md) — Docker Compose setup that wires EPS with MongoDB and the gateway
