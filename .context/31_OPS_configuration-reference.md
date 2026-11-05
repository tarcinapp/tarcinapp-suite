# 31_OPS_configuration-reference.md

## Overview

This is the master configuration reference for all Tarcinapp services. Variables are grouped by service. For each variable, the table shows the key name, type, default, and a brief description.

> **Naming conventions:**
> - **EPS** uses `UPPER_SNAKE_CASE` environment variables directly.
> - **Gateway** uses Spring Boot: property `app.some.thing` → env var `APP_SOME_THING`. Indexed arrays: `APP_KINDALIASPATHS_0_ALIAS=books`.
> - **Orchestrator** uses MicroProfile Config: `property.key` → `PROPERTY_KEY` (dots/hyphens → underscores, uppercased).

---

## entity-persistence-service

### Server
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `NODE_ENV` | string | `production` | Node environment (`development`, `production`, `test`) |
| `HOST` | string | `0.0.0.0` | Bind address |
| `PORT` | integer | `3000` | HTTP listen port |
| `LOG_LEVEL` | string | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `LOG_FORMAT` | string | `json` | Log format (`json` or `text`) |
| `LOG_TIMESTAMP` | boolean | `true` | Include timestamp in log output |
| `LOG_SERVICE` | string | _(none)_ | Service name tag added to every log line |
| `REQUEST_ID_HEADER` | string | `X-Request-ID` | Header name for propagating request IDs |

> **⚠️ Header name alignment:** The EPS default is `X-Request-ID` (capital **D**). The gateway default is `X-Request-Id` (lowercase **d**). These **must match** — set `APP_REQUESTID=X-Request-ID` on the gateway (or `REQUEST_ID_HEADER=X-Request-Id` on EPS) so the same header flows end-to-end.

### Database
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `MONGODB_URL` | string | _(none)_ | **Full MongoDB connection string.** Takes precedence over all individual params below. Use for Atlas or any URI-style connection (e.g. `mongodb+srv://user:pass@cluster/db?appName=...`). |
| `MONGODB_HOST` | string | `localhost` | MongoDB host (ignored when `MONGODB_URL` is set) |
| `MONGODB_PORT` | integer | `27017` | MongoDB port (ignored when `MONGODB_URL` is set) |
| `MONGODB_DATABASE` | string | `tarcinapp` | Database name (ignored when `MONGODB_URL` is set) |
| `MONGODB_USER` | string | _(none)_ | MongoDB username (ignored when `MONGODB_URL` is set) |
| `MONGODB_PASSWORD` | string | _(none)_ | MongoDB password (ignored when `MONGODB_URL` is set) |

### Collections (custom names)
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `COLLECTION_ENTITY` | string | `entities` | MongoDB collection for entities |
| `COLLECTION_LIST` | string | `lists` | MongoDB collection for lists |
| `COLLECTION_ENTITY_REACTIONS` | string | `entity-reactions` | MongoDB collection for entity reactions |
| `COLLECTION_LIST_REACTIONS` | string | `list-reactions` | MongoDB collection for list reactions |
| `COLLECTION_LIST_ENTITY_REL` | string | `list-entity-relations` | MongoDB collection for list-entity relations |

### Allowed Kinds
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `ENTITY_KINDS` | string | _(any)_ | Comma-separated allowed `_kind` values for entities. Empty = no restriction. Example: `book,author,chapter` |
| `LIST_KINDS` | string | _(any)_ | Comma-separated allowed `_kind` values for lists. Example: `bookshelf,library` |
| `LIST_ENTITY_REL_KINDS` | string | _(any)_ | Allowed kinds for relations. Example: `contains` |
| `ENTITY_REACTION_KINDS` | string | _(any)_ | Allowed kinds for entity reactions. Example: `like,comment,rating,flag,review` |
| `LIST_REACTION_KINDS` | string | _(any)_ | Allowed kinds for list reactions. |

### Default Kinds
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `DEFAULT_ENTITY_KIND` | string | `entity` | Default `_kind` applied when not specified for entities |
| `DEFAULT_LIST_KIND` | string | `list` | Default `_kind` for lists |
| `DEFAULT_RELATION_KIND` | string | `list-entity-relation` | Default kind for relations |
| `DEFAULT_ENTITY_REACTION_KIND` | string | `entity-reaction` | Default kind for entity reactions |
| `DEFAULT_LIST_REACTION_KIND` | string | `list-reaction` | Default kind for list reactions |

### Auto Approve
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `AUTOAPPROVE_ENTITY` | boolean | `false` | Auto-set `_validFromDateTime=now` on entity create |
| `AUTOAPPROVE_LIST` | boolean | `false` | Auto-approve lists |
| `AUTOAPPROVE_ENTITY_REACTION` | boolean | `false` | Auto-approve entity reactions |
| `AUTOAPPROVE_LIST_REACTION` | boolean | `false` | Auto-approve list reactions |
| `AUTOAPPROVE_LIST_ENTITY_RELATIONS` | boolean | `false` | Auto-approve relations |

#### Per-Kind Auto-Approve Overrides

Each `AUTOAPPROVE_*` variable has a per-kind override following the pattern `AUTOAPPROVE_{RESOURCE}_FOR_{KIND_UPPERCASE}`. The override applies only to records of that `_kind`; all other kinds fall back to the global setting.

| Env var pattern | Example | Effect |
|:---|:---|:---|
| `AUTOAPPROVE_ENTITY_FOR_{KIND}` | `AUTOAPPROVE_ENTITY_FOR_BOOK=true` | Auto-approve only `book` entities; other kinds still need manual approval |
| `AUTOAPPROVE_LIST_FOR_{KIND}` | `AUTOAPPROVE_LIST_FOR_BOOKSHELF=true` | Auto-approve only `bookshelf` lists |
| `AUTOAPPROVE_ENTITY_REACTION_FOR_{KIND}` | `AUTOAPPROVE_ENTITY_REACTION_FOR_LIKE=true` | Auto-approve only `like` entity reactions |
| `AUTOAPPROVE_LIST_REACTION_FOR_{KIND}` | `AUTOAPPROVE_LIST_REACTION_FOR_LIKE=true` | Auto-approve only `like` list reactions |

### Default Visibility
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `VISIBILITY_ENTITY` | string | `private` | Default `_visibility` for new entities (`public`, `protected`, `private`) |
| `VISIBILITY_LIST` | string | `private` | Default visibility for lists |
| `VISIBILITY_ENTITY_REACTION` | string | `private` | Default visibility for entity reactions |
| `VISIBILITY_LIST_REACTION` | string | `private` | Default visibility for list reactions |

#### Per-Kind Visibility Overrides

Same pattern as auto-approve: `VISIBILITY_{RESOURCE}_FOR_{KIND_UPPERCASE}`.

| Env var pattern | Example | Effect |
|:---|:---|:---|
| `VISIBILITY_ENTITY_FOR_{KIND}` | `VISIBILITY_ENTITY_FOR_BOOK=public` | New `book` entities default to `public`; others use the global `VISIBILITY_ENTITY` |
| `VISIBILITY_LIST_FOR_{KIND}` | `VISIBILITY_LIST_FOR_BOOKSHELF=protected` | New `bookshelf` lists default to `protected` |
| `VISIBILITY_ENTITY_REACTION_FOR_{KIND}` | `VISIBILITY_ENTITY_REACTION_FOR_REVIEW=public` | New `review` reactions default to `public` |

### Response Limits
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `RESPONSE_LIMIT_ENTITY` | integer | `100` | Maximum records per response for entities |
| `RESPONSE_LIMIT_LIST` | integer | `100` | Maximum records per response for lists |
| `RESPONSE_LIMIT_LIST_ENTITY_REL` | integer | `100` | Maximum records per response for relations |
| `RESPONSE_LIMIT_ENTITY_REACTION` | integer | `100` | Maximum records per response for entity reactions |
| `RESPONSE_LIMIT_LIST_REACTION` | integer | `100` | Maximum records per response for list reactions |

### Uniqueness Constraints
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `ENTITY_UNIQUENESS` | string | _(none)_ | Uniqueness rule(s) for entities |
| `LIST_UNIQUENESS` | string | _(none)_ | Uniqueness rule(s) for lists |
| `RELATION_UNIQUENESS` | string | _(none)_ | Uniqueness for relations |
| `ENTITY_REACTION_UNIQUENESS` | string | _(none)_ | Uniqueness for entity reactions |
| `LIST_REACTION_UNIQUENESS` | string | _(none)_ | Uniqueness for list reactions |

**Format:** A filter template string using `where[field]=${field}` interpolation. `${field}` is replaced at runtime with the value from the record being created. Multiple independent rules are comma-separated.

```bash
# Entities unique by kind + slug
ENTITY_UNIQUENESS="where[_kind]=${_kind}&where[_slug]=${_slug}"

# Lists unique by kind + slug
LIST_UNIQUENESS="where[_kind]=${_kind}&where[_slug]=${_slug}"

# Relations unique by list + entity + kind (prevents duplicate memberships)
RELATION_UNIQUENESS="where[_listId]=${_listId}&where[_entityId]=${_entityId}&where[_kind]=${_kind}"

# Reactions: two independent rules separated by comma — one rule per kind
# Each rule also scopes uniqueness to active, public, and owner-owned records
ENTITY_REACTION_UNIQUENESS="where[_kind]=like&where[_entityId]=${_entityId}&set[actives]&set[publics]&set[owners],where[_kind]=review&where[_entityId]=${_entityId}&set[actives]&set[publics]&set[owners]"
```

The `set[actives]`, `set[publics]`, and `set[owners]` modifiers narrow the uniqueness check to active, visible, and caller-owned records respectively, so a user can re-react after deleting a previous reaction.

### Record Limits
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `ENTITY_RECORD_LIMITS` | JSON array | _(none)_ | Array of limit rules for entities |
| `LIST_RECORD_LIMITS` | JSON array | _(none)_ | Record limits for lists |
| `RELATION_RECORD_LIMITS` | JSON array | _(none)_ | Record limits for relations |
| `ENTITY_REACTION_RECORD_LIMITS` | JSON array | _(none)_ | Record limits for entity reactions |
| `LIST_REACTION_RECORD_LIMITS` | JSON array | _(none)_ | Record limits for list reactions |

Record limit rule structure:
```json
{
  "scope": "where[_kind]=book",   // filter expression (empty string = global)
  "limit": 100,                   // max allowed records
  "duration": "30d"               // optional: rolling window (s, m, h, d, w)
}
```

Examples:
```bash
# Global cap: max 500 entities, plus a short-burst cap of 2 per minute
ENTITY_RECORD_LIMITS='[{"scope":"","limit":2,"duration":"1min"},{"scope":"","limit":500}]'

# Limit book entities created in the last 30 days
ENTITY_RECORD_LIMITS='[{"scope":"where[_kind]=book","limit":100,"duration":"30d"}]'

# Limit reactions per entity to 500 in the last 30 days (dynamic scope)
ENTITY_REACTION_RECORD_LIMITS='[{"scope":"where[_entityId]=${_entityId}","limit":500,"duration":"30d"}]'
```

### Idempotency
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `IDEMPOTENCY_ENTITY` | string | _(none)_ | Fields contributing to entity idempotency key (comma-separated) |
| `IDEMPOTENCY_LIST` | string | _(none)_ | Fields for list idempotency |
| `IDEMPOTENCY_ENTITY_REACTION` | string | _(none)_ | Fields for entity reaction idempotency |
| `IDEMPOTENCY_LIST_REACTION` | string | _(none)_ | Fields for list reaction idempotency |
| `IDEMPOTENCY_LIST_ENTITY_REL` | string | _(none)_ | Fields for relation idempotency |

### Lookup Constraints

Lookup constraints restrict which records can be resolved when EPS follows a reference (e.g. resolving a parent entity by `_parentId`). The constraint is a filter expression appended to the lookup query — records not matching the filter are treated as if they do not exist.

| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `ENTITY_LOOKUP_CONSTRAINT` | string | _(none)_ | Filter appended to all entity lookup resolutions |
| `LIST_LOOKUP_CONSTRAINT` | string | _(none)_ | Filter for list lookup resolutions |
| `ENTITY_REACTION_LOOKUP_CONSTRAINT` | string | _(none)_ | Filter for entity reaction lookups |
| `LIST_REACTION_LOOKUP_CONSTRAINT` | string | _(none)_ | Filter for list reaction lookups |

**Examples:**

```bash
# Only allow resolving published (active) entities as lookup targets
ENTITY_LOOKUP_CONSTRAINT="filter[actives]"

# Only allow resolving public entities
ENTITY_LOOKUP_CONSTRAINT="filter[publics]"

# Only allow resolving entities of a specific kind as lookup targets
ENTITY_LOOKUP_CONSTRAINT="filter[where][_kind]=book"

# Combine: only active public books can be resolved as lookup targets
ENTITY_LOOKUP_CONSTRAINT="filter[actives]&filter[publics]&filter[where][_kind]=book"
```

An empty value (the default) means no additional constraint — any record can be a lookup target.

---

## entity-persistence-gateway

Spring Boot conventions: property `app.some.thing` → env var `APP_SOME_THING`. Array items: `APP_KINDALIASPATHS_0_ALIAS=books`.

### Application Identity
| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.name` | `APP_NAME` | `entity-persistence-gateway` | Application name (used in Spring context and metrics) |
| `app.shortcode` | `APP_SHORTCODE` | `tarcinapp` | Prefix for role names, request IDs, and JMX domain |
| `app.requestId` | `APP_REQUESTID` | `X-Request-Id` | Inbound/outbound request ID header name. **Must match EPS `REQUEST_ID_HEADER`.** |

### Inbound Server
| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.inbound.port` | `APP_INBOUND_PORT` | `8081` | HTTP listen port |
| `app.inbound.address` | `APP_INBOUND_ADDRESS` | `0.0.0.0` | Bind address |
| `app.inbound.baseUri` | `APP_INBOUND_BASEURI` | `/api/v1/` | Base URI prefix for all routes |
| `app.inbound.metricsEnabled` | `APP_INBOUND_METRICSENABLED` | `true` | Enable Prometheus metrics collection |
| `app.inbound.exposedEndpoints` | `APP_INBOUND_EXPOSEDENDPOINTS` | `gateway,health,metrics,prometheus,jolokia,env,info` | Actuator endpoints exposed over HTTP |
| `app.inbound.trustedProxyCount` | `APP_INBOUND_TRUSTEDPROXYCOUNT` | `0` | Number of trusted reverse proxies. Controls `X-Forwarded-For` resolution for IP-based rate limiting. `0` = direct/local, `1` = single nginx hop. |

### CORS Configuration

CORS is configured under `app.inbound.cors.*` in `app-inbound.yml`. These properties drive Spring Cloud Gateway's `globalcors` block.

| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.inbound.cors.allowedOrigins` | `APP_INBOUND_CORS_ALLOWEDORIGINS` | `http://localhost:8080` | Allowed origins (comma-separated or wildcard `*`) |
| `app.inbound.cors.allowedMethods` | `APP_INBOUND_CORS_ALLOWEDMETHODS` | `GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD` | Allowed HTTP methods |
| `app.inbound.cors.allowedHeaders` | `APP_INBOUND_CORS_ALLOWEDHEADERS` | _(see below)_ | Allowed request headers |
| `app.inbound.cors.exposedHeaders` | `APP_INBOUND_CORS_EXPOSEDHEADERS` | _(see below)_ | Response headers browsers may read |
| `app.inbound.cors.allowCredentials` | `APP_INBOUND_CORS_ALLOWCREDENTIALS` | `true` | Allow cookies / auth headers in cross-origin requests |
| `app.inbound.cors.maxAge` | `APP_INBOUND_CORS_MAXAGE` | `3600` | Preflight cache duration in seconds |

Default `allowedHeaders` includes: `Accept`, `Authorization`, `Content-Type`, `Origin`, `X-Requested-With`, `X-XSRF-TOKEN`, `If-Match`, `If-None-Match`, and the value of `${app.requestId}` (so the request ID header is always allowed).

Default `exposedHeaders` includes: `Date`, `Content-Type`, `ETag`, `Link`, `X-Total-Count`, `X-Page-Count`, `X-Cache-Status`, `Retry-After`, and the value of `${app.requestId}`.

> **Production note:** Replace `allowedOrigins` with your actual front-end domain(s). Do not use `*` with `allowCredentials: true` — browsers reject that combination.

### Backend (EPS or Orchestrator)
| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.outbound.routing-target.protocol` | `APP_OUTBOUND_ROUTING-TARGET_PROTOCOL` | `http` | Protocol for backend calls |
| `app.outbound.routing-target.host` | `APP_OUTBOUND_ROUTING-TARGET_HOST` | `entity-persistence-service` | Backend hostname |
| `app.outbound.routing-target.port` | `APP_OUTBOUND_ROUTING-TARGET_PORT` | `80` | Backend port |
| `app.outbound.routing-target.baseUri` | `APP_OUTBOUND_ROUTING-TARGET_BASEURI` | `/` | Backend base path |
| `app.outbound.routing-target.readTimeoutMs` | `APP_OUTBOUND_ROUTING-TARGET_READTIMEOUTMS` | `3000` | Read timeout for backend calls (ms) |
| `app.outbound.routing-target.writeTimeoutMs` | `APP_OUTBOUND_ROUTING-TARGET_WRITETIMEOUTMS` | `3000` | Write timeout for backend calls (ms) |
| `app.outbound.routing-target.pool.maxConnections` | `APP_OUTBOUND_ROUTING-TARGET_POOL_MAXCONNECTIONS` | `500` | Max connection pool size |

The `policy-source` (used for row-level-security pre-fetch) inherits the same connection settings as `routing-target` by default. Override `app.outbound.policy-source.*` if the security data source differs.

### OPA
| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.outbound.opa.protocol` | `APP_OUTBOUND_OPA_PROTOCOL` | `https` | OPA protocol |
| `app.outbound.opa.host` | `APP_OUTBOUND_OPA_HOST` | `entity-persistence-gateway-policies` | OPA hostname |
| `app.outbound.opa.port` | `APP_OUTBOUND_OPA_PORT` | `443` | OPA port |
| `app.outbound.opa.readTimeoutMs` | `APP_OUTBOUND_OPA_READTIMEOUTMS` | `300` | OPA read timeout (ms) — fail fast |

### Authentication (JWT / multi-provider)

Authentication is configured as an indexed list of providers under `app.auth.providers`. Each provider can use either a JWKS URI (for dynamic key rotation, e.g. Keycloak, Google, Auth0) or a static public key (for internal issuers).

| Property | Env var | Description |
|:---|:---|:---|
| `app.auth.providers[N].issuer` | `APP_AUTH_PROVIDERS_N_ISSUER` | Expected JWT `iss` claim |
| `app.auth.providers[N].jwk-set-uri` | `APP_AUTH_PROVIDERS_N_JWK-SET-URI` | JWKS endpoint URL (use for dynamic key fetch) |
| `app.auth.providers[N].public-key` | `APP_AUTH_PROVIDERS_N_PUBLIC-KEY` | Static PEM public key string (use when JWKS is not available) |
| `app.auth.providers[N].algorithm` | `APP_AUTH_PROVIDERS_N_ALGORITHM` | Key algorithm: `RSA` (RS256/RS384/RS512), `EC` (ES256/ES384/ES512), `EdDSA` (Ed25519) |
| `app.auth.providers[N].clockSkewSeconds` | `APP_AUTH_PROVIDERS_N_CLOCKSKEWSECONDS` | Allowed JWT expiry clock skew in seconds (default: `60`) |

**Example: two Keycloak realms**

```yaml
app:
  auth:
    providers:
      - issuer: "https://keycloak.example.com/realms/external"
        jwk-set-uri: "https://keycloak.example.com/realms/external/protocol/openid-connect/certs"
        clockSkewSeconds: 60
      - issuer: "https://keycloak.example.com/realms/internal"
        jwk-set-uri: "https://keycloak.example.com/realms/internal/protocol/openid-connect/certs"
        clockSkewSeconds: 10
```

**Example: internal issuer with static key (env vars)**

```bash
APP_AUTH_PROVIDERS_0_ISSUER=tarcinapp-internal
APP_AUTH_PROVIDERS_0_PUBLIC_KEY=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
APP_AUTH_PROVIDERS_0_ALGORITHM=RSA
APP_AUTH_PROVIDERS_0_CLOCKSKEWSECONDS=10
```

### Redis
| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.outbound.redis.host` | `APP_OUTBOUND_REDIS_HOST` | `gateway-redis-master` | Redis hostname |
| `app.outbound.redis.port` | `APP_OUTBOUND_REDIS_PORT` | `6379` | Redis port |
| `app.outbound.redis.database` | `APP_OUTBOUND_REDIS_DATABASE` | `0` | Redis database index |
| `app.outbound.redis.password` | `APP_OUTBOUND_REDIS_PASSWORD` | _(required)_ | Redis password |

### Timeout Configuration

Timeouts are hierarchical. Override only the level you need; unset levels inherit from the level above.

| Level | Property pattern | Env var pattern | Description |
|:---|:---|:---|:---|
| Global default | `app.timeouts.default.connectTimeoutMs` | `APP_TIMEOUTS_DEFAULT_CONNECTTIMEOUTMS` | Default `3000` ms TCP connect timeout for all routes |
| Global default | `app.timeouts.default.responseTimeoutMs` | `APP_TIMEOUTS_DEFAULT_RESPONSETIMEOUTMS` | Default `30000` ms response timeout for all routes |
| Controller default | `app.timeouts.entities.default.responseTimeoutMs` | `APP_TIMEOUTS_ENTITIES_DEFAULT_RESPONSETIMEOUTMS` | Override for all entity routes |
| Kind default | `app.timeouts.entities.kinds.book.default.responseTimeoutMs` | `APP_TIMEOUTS_ENTITIES_KINDS_BOOK_DEFAULT_RESPONSETIMEOUTMS` | Override for all `book` kind routes |
| Route-specific | `app.timeouts.entities.findEntities.responseTimeoutMs` | `APP_TIMEOUTS_ENTITIES_FINDENTITIES_RESPONSETIMEOUTMS` | Override for one specific route |

Available controllers for timeout overrides: `entities`, `lists`, `relations`, `reactions`, `reactionsThroughEntity`, `reactionsThroughList`, `entitiesThroughList`, `listsThroughEntity`, `ping`.

**Example: slow search query needs a longer timeout**

```bash
APP_TIMEOUTS_ENTITIES_FINDENTITIES_RESPONSETIMEOUTMS=60000
```

### Route Toggles

Routes are toggled via `app.toggles.*` (prefix `APP_TOGGLES_*`). Three dimensions can be toggled: individual route IDs, controller names, and tags. Each dimension has an `on` list and an `off` list.

| Property | Env var | Description |
|:---|:---|:---|
| `app.toggles.routes.off` | `APP_TOGGLES_ROUTES_OFF` | Comma-separated route IDs to disable (returns `405`) |
| `app.toggles.routes.on` | `APP_TOGGLES_ROUTES_ON` | Route IDs forced on (overrides controller/tag off lists) |
| `app.toggles.controllers.off` | `APP_TOGGLES_CONTROLLERS_OFF` | Controller names to disable entirely |
| `app.toggles.tags.off` | `APP_TOGGLES_TAGS_OFF` | Tag names to disable (e.g. `generic`, `write`) |
| `app.toggles.tags.on` | `APP_TOGGLES_TAGS_ON` | Tag names forced on regardless of other rules |

**Route ID naming convention:** `{verb}{ResourceType}[ById|Children|Parents|Count|All]`

| Route ID | Method | URL pattern |
|:---|:---|:---|
| `createEntity` | POST | `/entities` |
| `findEntities` | GET | `/entities` |
| `countEntities` | GET | `/entities/count` |
| `findEntityById` | GET | `/entities/{id}` |
| `updateEntityById` | PATCH | `/entities/{id}` |
| `replaceEntityById` | PUT | `/entities/{id}` |
| `deleteEntityById` | DELETE | `/entities/{id}` |
| `updateAllEntities` | PATCH | `/entities` |
| `findEntityChildren` | GET | `/entities/{id}/children/{alias}` |
| `createEntityChild` | POST | `/entities/{id}/children/{alias}` |
| `findEntityParents` | GET | `/entities/{id}/parents/{alias}` |
| `createList` | POST | `/lists` |
| `findLists` | GET | `/lists` |
| `findListById` | GET | `/lists/{id}` |
| `deleteListById` | DELETE | `/lists/{id}` |
| `createRelation` | POST | `/relations` |
| `createEntityReaction` | POST | `/entity-reactions` |
| `findReactionsByEntityId` | GET | `/{entities}/{id}/reactions/{alias}` |
| `createReactionByEntityId` | POST | `/{entities}/{id}/reactions/{alias}` |

Kind-alias variants of entity routes (e.g. `/books`) use IDs like `findEntitiesByKindAlias`, `createEntityByKindAlias`, `findEntityByIdByKindAlias`.

**YAML example (disable all generic routes, keep one open):**

```yaml
app:
  toggles:
    tags:
      off:
        - generic
    routes:
      on:
        - findEntities   # force this one generic route back on
```

### Kind Alias Paths (indexed array)
| Property | Env var | Description |
|:---|:---|:---|
| `app.kindAliasPaths[N].alias` | `APP_KINDALIASPATHS_N_ALIAS` | URL segment (e.g., `books`) |
| `app.kindAliasPaths[N].name` | `APP_KINDALIASPATHS_N_NAME` | `_kind` value (e.g., `book`) |
| `app.kindAliasPaths[N].schema` | `APP_KINDALIASPATHS_N_SCHEMA` | JSON Schema string for validation |
| `app.kindAliasPaths[N].hierarchyAlias` | `APP_KINDALIASPATHS_N_HIERARCHYALIAS` | Hierarchy URL alias (e.g., `chapters`) |
| `app.kindAliasPaths[N].hierarchyName` | `APP_KINDALIASPATHS_N_HIERARCHYNAME` | Hierarchy `_kind` (e.g., `chapter`) |
| `app.kindAliasPaths[N].maxRequestSize` | `APP_KINDALIASPATHS_N_MAXREQUESTSIZE` | Max payload size (e.g., `5KB`) |
| `app.kindAliasPaths[N].rateLimiter.replenishRate` | `APP_KINDALIASPATHS_N_RATELIMITER_REPLENISHRATE` | Tokens/sec for rate limiter |
| `app.kindAliasPaths[N].rateLimiter.burstCapacity` | `APP_KINDALIASPATHS_N_RATELIMITER_BURSTCAPACITY` | Max burst size |
| `app.kindAliasPaths[N].timeout` | `APP_KINDALIASPATHS_N_TIMEOUT` | Per-kind request timeout override (ms) |

### OAS Configuration (`app-oas.yml`)

Controls the OpenAPI Specification document generated by the gateway.

| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.oas.title` | `APP_OAS_TITLE` | `Entity Persistence Platform API` | API title in generated OAS |
| `app.oas.version` | `APP_OAS_VERSION` | `1.0.0` | API version string |
| `app.oas.description` | `APP_OAS_DESCRIPTION` | _(see yml)_ | API description |
| `app.oas.contact.name` | `APP_OAS_CONTACT_NAME` | `Platform Team` | Contact name |
| `app.oas.contact.email` | `APP_OAS_CONTACT_EMAIL` | `support@tarcinapp.com` | Contact email |
| `app.oas.contact.url` | `APP_OAS_CONTACT_URL` | `https://tarcinapp.com` | Contact URL |
| `app.oas.servers[N].url` | `APP_OAS_SERVERS_N_URL` | `https://api.tarcinapp.com` | Base API URL shown in OAS (first entry = default) |
| `app.oas.servers[N].description` | `APP_OAS_SERVERS_N_DESCRIPTION` | `Production Environment` | Server description |
| `app.oas.controllers` | _(complex)_ | `{}` | Per-controller alias definitions (see below) |

**Controller alias definitions** determine which endpoints appear in the OAS document and how they are described. Aliases map a URL segment (e.g. `books`) to an internal `_kind` (e.g. `book`), attach a JSON Schema, and optionally configure per-route OAS metadata (`operationId`, `summary`, `tags`).

```yaml
app:
  oas:
    servers:
      - url: "https://api.myapp.com"
        description: "Production"
    controllers:
      entities:
        aliases:
          - alias: books
            kind: book
            description: "Manage book entities"
            schema: |
              {"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}
            routes:
              createEntity:
                operationId: createBook
                summary: "Create a new book"
              findEntities:
                operationId: listBooks
```

Routes not referenced in `controllers` are still active but will not appear in the generated OAS document.

### Fieldsets (named field selections)
| Property | Env var | Description |
|:---|:---|:---|
| `app.fieldsets.<name>.show` | `APP_FIELDSETS_<NAME>_SHOW` | Comma-separated fields to include |
| `app.fieldsets.<name>.hide` | `APP_FIELDSETS_<NAME>_HIDE` | Comma-separated fields to exclude |

Built-in defaults: `managed` (show managed fields only), `unmanaged` (hide managed fields).

### Saved Queries
| Property | Env var | Description |
|:---|:---|:---|
| `app.queries.<name>` | `APP_QUERIES_<NAME>` | SpEL expression for named query (`?q=<name>`) |

Example: `APP_QUERIES_BY-BOOK-NAME="'filter[where][_name]=' + #query['book-name']"`

### Default Fieldsets per Record Type
| Property | Description |
|:---|:---|
| `app.defaultFieldset.entities` | Fieldset name applied automatically to entity endpoints |
| `app.defaultFieldset.lists` | Fieldset applied to list endpoints |
| `app.defaultFieldset.reactions` | Fieldset applied to reaction endpoints |

### JMX Configuration

JMX monitoring is configured via `application-jmx.yml`. The `spring.jmx.*` settings are bound from `app.jmx.*`.

| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.jmx.enabled` | `APP_JMX_ENABLED` | `true` | Enable JMX (maps to `spring.jmx.enabled`) |
| `app.jmx.default-domain` | `APP_JMX_DEFAULT-DOMAIN` | `${app.shortcode}.jmx` | JMX domain (e.g. `tarcinapp.jmx`) |
| `app.jmx.unique-names` | `APP_JMX_UNIQUE-NAMES` | `false` | Append object name uniqueness qualifiers |
| `app.jmx.jolokia.enabled` | `APP_JMX_JOLOKIA_ENABLED` | `true` | Enable embedded Jolokia agent (HTTP-to-JMX bridge) |
| `app.jmx.jolokia.host` | `APP_JMX_JOLOKIA_HOST` | `0.0.0.0` | Jolokia bind address |
| `app.jmx.jolokia.port` | `APP_JMX_JOLOKIA_PORT` | `8778` | Jolokia HTTP port |
| `app.jmx.jolokia.discoveryEnabled` | `APP_JMX_JOLOKIA_DISCOVERYENABLED` | `true` | Enable Jolokia discovery for Hawtio |

Jolokia exposes JMX over HTTP at `http://<host>:8778/jolokia`. Used by Hawtio for visual monitoring. Expose port `8778` only on internal/management networks.

### Observability
| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.inbound.metricsEnabled` | `APP_INBOUND_METRICSENABLED` | `true` | Expose Prometheus `/actuator/prometheus` endpoint |
| `app.logging.tarcinapp` | `APP_LOGGING_TARCINAPP` | `INFO` | Log level for `com.tarcinapp.*` package |
| `app.logging.http` | `APP_LOGGING_HTTP` | `INFO` | HTTP request/response trace log level (set `TRACE` to see full bodies) |
| `app.logging.gateway` | `APP_LOGGING_GATEWAY` | `INFO` | Spring Cloud Gateway route/filter log level |
| `app.logging.redisson` | `APP_LOGGING_REDISSON` | `INFO` | Redisson Redis client log level |

---

## entity-persistence-universal-orchestrator

MicroProfile Config convention: `property.key` → `PROPERTY_KEY` (dots/hyphens → underscores, uppercased).

| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `quarkus.http.port` | `QUARKUS_HTTP_PORT` | `8079` | Orchestrator HTTP listen port |
| `backend.base-url` | `BACKEND_BASE_URL` | `http://localhost:3000` | EPS base URL for Camel route `toD()` calls. Must **not** have a trailing slash. |
| `gateway.base-url` | `GATEWAY_BASE_URL` | `http://localhost:8081` | Gateway URL used as fallback for the REST client (see below) |
| `quarkus.rest-client."entity-persistence-gateway".url` | `QUARKUS_REST_CLIENT__ENTITY_PERSISTENCE_GATEWAY__URL` | `${GATEWAY_BASE_URL:${gateway.base-url}}` | **Primary** URL for the MicroProfile REST client. Resolves `GATEWAY_BASE_URL` env var first, then falls back to `gateway.base-url` property. Set this (or `GATEWAY_BASE_URL`) to point to the gateway. |
| `quarkus.rest-client."entity-persistence-gateway".connect-timeout` | _(config only)_ | `5000` | REST client connect timeout (ms) |
| `quarkus.rest-client."entity-persistence-gateway".read-timeout` | _(config only)_ | `30000` | REST client read timeout (ms) |
| `backend.health-check.enabled` | `BACKEND_HEALTH_CHECK_ENABLED` | `true` | Probe EPS at startup. Application aborts if probe fails. |
| `backend.health-check.path` | `BACKEND_HEALTH_CHECK_PATH` | `/ping` | EPS liveness probe path |
| `backend.health-check.openapi-path` | `BACKEND_HEALTH_CHECK_OPENAPI_PATH` | `/openapi.json` | EPS OpenAPI spec path (checked at startup to validate schema) |
| `backend.health-check.timeout-seconds` | `BACKEND_HEALTH_CHECK_TIMEOUT_SECONDS` | `10` | Startup probe timeout in seconds |
| `quarkus.otel.enabled` | `QUARKUS_OTEL_ENABLED` | `true` | Enable OpenTelemetry tracing |
| `quarkus.otel.exporter.otlp.endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | OTLP collector endpoint |
| `quarkus.otel.propagators` | _(config only)_ | `tracecontext,baggage,b3,b3multi` | Trace propagators (W3C + B3 for Instana/Zipkin compatibility) |
| `quarkus.log.level` | `QUARKUS_LOG_LEVEL` | `INFO` | Root log level |
| `quarkus.log.category."io.tarcinapp".level` | _(set in `application.properties`)_ | `DEBUG` | Application code log level (tarcinapp package only) |
| `quarkus.log.category."org.apache.camel".level` | _(set in `application.properties`)_ | `INFO` | Apache Camel framework log level |

> **`GATEWAY_BASE_URL` vs `quarkus.rest-client` URL:** `GATEWAY_BASE_URL` is the simpler override — it is the standard env var to set in most deployments. The full `quarkus.rest-client."entity-persistence-gateway".url` property only needs to be set directly if you need to override without `GATEWAY_BASE_URL` (e.g. in test profiles).

---

## OPA (entity-persistence-gateway-policies)

OPA is configured via command-line flags when running the Docker image.

### Runtime Flags
| Flag | Description |
|:---|:---|
| `--server` | Run as HTTP server (required for gateway integration) |
| `--addr 0.0.0.0:8181` | Bind address and port |
| `--log-level info` | Log level (`debug`, `info`, `error`) |
| `--set decision_logs.console=true` | Enable decision logging to stdout |
| `--poll-period 10s` | Re-read policy files from disk every N seconds. Use when policies are mounted as files and updated without container restart. |
| `--optimize` | (OPA build command) Compile and optimise a bundle for production. Reduces evaluation latency. Use with `opa build -t wasm -O1`. |

### Policy Mounts

Policies directory is mounted at container start:
```bash
docker run \
  -v /path/to/policies:/policies \
  openpolicyagent/opa:latest \
  run --server --addr 0.0.0.0:8181 \
      --log-level info \
      --set decision_logs.console=true \
      --poll-period 10s \
      /policies
```

### OPA Bundle Server (alternative to file mounts)

Instead of file mounts, OPA can pull policy bundles from an HTTP bundle server (e.g. an S3-compatible object store or a custom bundle server). Configure via `--set`:

```bash
--set bundles.tarcinapp.resource=https://bundle-server.example.com/tarcinapp/bundle.tar.gz
--set bundles.tarcinapp.polling.min_delay_seconds=60
--set bundles.tarcinapp.polling.max_delay_seconds=120
```

This is the recommended approach for Kubernetes deployments as it avoids re-deploying the OPA container to update policies.

---

## tarcinapp-base-gui

The GUI is a Vite + React SPA. Configuration is injected at **Vite build time** or read from `localStorage` at runtime.

### Build-time Environment Variables

Vite exposes these as `import.meta.env.TAPP_API_ENDPOINT` / `import.meta.env.TAPP_API_TOKEN` inside the built bundle. They are **not** `VITE_`-prefixed — the app reads them directly from `import.meta.env`.

| Env var | Default | Description |
|:---|:---|:---|
| `TAPP_API_ENDPOINT` | _(none)_ | Gateway base URL baked into the build. When set, skips the SetupScreen at runtime. Example: `https://api.myapp.com` |
| `TAPP_API_TOKEN` | _(none)_ | Bearer token baked into the build. When set together with `TAPP_API_ENDPOINT`, the SetupScreen is bypassed entirely. |

> **Build-time injection:** Pass these during `vite build` (e.g. `TAPP_API_ENDPOINT=https://api.myapp.com vite build`). They are statically replaced at build time and cannot be changed without rebuilding. For runtime-configurable deployments, leave them unset and use the SetupScreen instead.

### Runtime Configuration (localStorage)

When `TAPP_API_ENDPOINT` is not set at build time, the user configures the app through the **SetupScreen**, which stores values in `localStorage` under the key `tarcinapp_config`:

```json
{
  "endpoint": "https://api.myapp.com",
  "token": "eyJhbGci...",
  "bypassCache": true
}
```

Build-time env vars take priority over `localStorage` values. `localStorage` values are ignored when env vars are present.

---

## Configuration Validation

Run these checks before deploying or after any configuration change.

### 1. Gateway health endpoint

```bash
curl -s http://<gateway-host>:<port>/actuator/health | jq .status
# Expected: "UP"
```

For liveness/readiness (Kubernetes probes):
```bash
curl -s http://<gateway-host>:<port>/actuator/health/liveness  | jq .status
curl -s http://<gateway-host>:<port>/actuator/health/readiness | jq .status
```

### 2. OPA data check

Verify OPA is running and the policy package is loaded:
```bash
curl -s http://<opa-host>:8181/v1/data | jq 'keys'
# Should include your policy package name, e.g. ["tarcinapp"]

# Check a specific policy decision with a minimal input:
curl -s -X POST http://<opa-host>:8181/v1/data/tarcinapp/authz/allow \
  -H "Content-Type: application/json" \
  -d '{"input": {"method": "GET", "path": ["api","v1","entities"]}}' \
  | jq .result
```

### 3. JWT creation and auth check

Create a test JWT signed with your configured key and verify the gateway accepts it:

```bash
# 1. Generate a test token (example using step CLI)
step crypto jwt sign \
  --key private.pem \
  --iss "tarcinapp-internal" \
  --sub "test-user" \
  --exp $(date -d '+1 hour' +%s) \
  --alg RS256

# 2. Call a protected endpoint with the token
curl -s -H "Authorization: Bearer <token>" \
  http://<gateway-host>:<port>/api/v1/entities \
  | jq .

# Expected: 200 with data array (or empty array), NOT 401/403
```

If you receive `401 Unauthorized`:
- Verify `APP_AUTH_PROVIDERS_0_ISSUER` matches the `iss` claim exactly.
- Verify the public key or JWKS URI is correct and reachable from the gateway.
- Check `APP_AUTH_PROVIDERS_0_CLOCKSKEWSECONDS` — ensure the token `exp` is in the future accounting for skew.

If you receive `403 Forbidden`:
- The JWT was accepted but OPA denied the request. Check OPA decision logs (`--set decision_logs.console=true`).

### 4. EPS connectivity check

```bash
curl -s http://<eps-host>:<port>/ping
# Expected: {"status":"ok"} or 200

curl -s http://<eps-host>:<port>/openapi.json | jq .info.title
# Expected: API title string
```

### 5. Configuration consistency checklist

| Item | Check |
|:---|:---|
| Request ID header | `REQUEST_ID_HEADER` (EPS) == `APP_REQUESTID` (gateway) |
| Auth issuer | `APP_AUTH_PROVIDERS_0_ISSUER` matches `iss` in your JWTs |
| Backend host/port | `APP_OUTBOUND_ROUTING-TARGET_HOST/PORT` resolves to EPS |
| OPA host/port | `APP_OUTBOUND_OPA_HOST/PORT` resolves to OPA |
| Redis | `APP_OUTBOUND_REDIS_HOST` resolves and password is correct |
| CORS origin | `APP_INBOUND_CORS_ALLOWEDORIGINS` includes your front-end URL |
| Gateway URL (orchestrator) | `GATEWAY_BASE_URL` points to the running gateway |

---

## Related Documents
- `30_OPS_local-development.md` — Local dev setup with specific example values
- `32_OPS_deployment-kubernetes.md` — K8s ConfigMap structure for all these variables
- `33_OPS_deployment-docker-compose.md` — Docker Compose with all services
