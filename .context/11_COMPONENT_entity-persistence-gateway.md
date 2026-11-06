# 11_COMPONENT_entity-persistence-gateway.md

## Component Identity

**Repository:** `entity-persistence-gateway`  
**Technology:** Java 21 · Spring Boot 3.4 · Spring Cloud Gateway (WebFlux/Netty) · Redis (Redisson) · OPA  
**Layer:** III — Gateway & Security  
**Default inbound port:** `8081`  
**Source of truth for its own docs:** [`entity-persistence-gateway/.context/`](../../entity-persistence-gateway/.context/)

---

## What It Is

`entity-persistence-gateway` is the **Policy Enforcement Point (PEP)** and primary API entry point for the Tarcinapp suite. Every client request passes through it. It authenticates, authorizes, validates, transforms, and routes — and only then does data reach `entity-persistence-service`.

It is a **reactive** (WebFlux) Spring Cloud Gateway application. All processing is non-blocking. Its configuration is entirely YAML-driven; no business logic is compiled into it.

The gateway has two primary roles:
1. **Security enforcer** — JWT validation, OPA authorization, field masking, ownership injection, sets-based access scoping, distributed locking.
2. **Domain projector** — transforms generic `/entities` endpoints into domain-specific routes like `/books` via Kind Path Aliasing.

---

## Technology Stack

| Component | Detail |
|:---|:---|
| Runtime | Java 21 |
| Framework | Spring Boot 3.5.3 + Spring Cloud 2025.0.3 (`spring-cloud-starter-gateway-server-webflux`) |
| HTTP | Reactive (WebFlux / Netty) |
| State | Redis via Redisson 3.52.0 (locks, rate limiting, caching) |
| Auth | Auth0 JWKS (`jwks-rsa` 0.23.1) + JJWT 0.12.7 |
| Validation | NetworkNT JSON Schema Validator 1.5.6 |
| Policy | OPA REST API (sidecar or standalone) |

---

## Configuration Architecture

The app uses a **modular YAML** structure. `application.yml` is the root — it sets Netty, Redis, and imports all feature config files via `spring.config.import`:

```
src/main/resources/
├── application.yml                       ← root: Netty, Redis, spring.config.import list
├── application-routes.yml                ← ALL 140 routes defined here
├── application-auth.yml                  ← JWT issuers, public keys, clock skew
├── application-locks.yml                 ← distributed lock config per route
├── application-fieldsets.yml             ← named field sets
├── application-logging.yml               ← log level knobs per package
├── app-inbound.yml                       ← inbound port, base URI, controller base paths
├── app-outbound.yml                      ← backend (EPS) host, port, protocol
├── application-timeouts.yml              ← default and per-route connect/read timeouts
├── application-route-toggles.yml         ← which routes/tags are disabled at startup
├── application-request-sizes.yml         ← global and per-kind max request sizes
├── application-rate-limits.yml           ← global and per-kind rate limit configuration
├── application-management.yml            ← Spring Boot actuator/management endpoints
├── application-jmx.yml                   ← JMX configuration
├── app-oas.yml                           ← OAS generation settings
├── application-oas-orchestrator.yml      ← OAS orchestrator (multi-source) config
└── logback-spring.xml                    ← Logback wiring
```

> **Working example profile:** `application-booksapp.yml` — a complete, annotated configuration profile that wires up a books-and-shelves domain. Use it as the canonical reference when configuring a new deployment.

All keys map to environment variables using Spring's relaxed binding convention:  
`app.auth.rs256PublicKey` → `APP_AUTH_RS256PUBLICKEY`  
`app.kindAliasPaths[0].alias` → `APP_KINDALIASPATHS_0_ALIAS`

---

## Route Topology (140 Routes)

Routes are organized along two independent dimensions: **context** (generic vs. domain-projected) and **topology** (root vs. traversal). The 140 routes break down across five sub-groups:

### Route Count by Sub-Group

| Sub-Group | Count | Description |
|:---|:---:|:---|
| **Base Generic — Root** | 53 | Direct mirrors of EPS root endpoints. Use generic resource names (`/entities`, `/lists`, `/relations`, `/entity-reactions`, `/list-reactions`). |
| **Base Generic — Traversal** | 12 | Through-path endpoints that navigate a relationship edge (`/entities/{id}/reactions`, `/lists/{id}/entities`, etc.). |
| **Kind Alias — Root** | 60 | Domain-projected wrappers for root endpoints. Use configured aliases (`/books`, `/shelves`). Scope all queries to `_kind`. |
| **Kind Alias — Traversal** | 13 | Domain-projected wrappers for traversal endpoints (e.g., `/books/{id}/reviews`). |
| **Utility** | 2 | `/ping` and `/openapi.json` / `/openapi.yaml` |
| **Grand Total** | **140** | |

### Dimension 1: Context

| Context | Total | Root | Traversal |
|:---|:---:|:---:|:---:|
| **Base Generic** | 65 | 53 | 12 |
| **Kind Alias** | 73 | 60 | 13 |
| **Utility** | 2 | — | — |

### Dimension 2: Topology

| Topology | Description | Controllers |
|:---|:---|:---|
| **Root** | Manages a resource type directly | Entity, List, Relation, EntityReactions, ListReactions |
| **Traversal ("Through")** | Navigates a relationship edge to a related resource | ReactionsThroughEntity, ReactionsThroughList, EntitiesThroughList, ListsThroughEntity |

### Route Type Categories within a Controller

| Type | Path pattern | Operations |
|:---|:---|:---|
| Collection | `/{resource}` | find, create, count, updateAll |
| Single Item | `/{resource}/{id}` | findById, updateById, replaceById, deleteById |
| Hierarchy | `/{resource}/{id}/children`, `/{resource}/{id}/parents` | findChildren, createChild, findParents |

> Traversal controllers only expose Collection-type routes (no single-item addressing or hierarchy within a traversal path).

### Dynamic Hierarchy Routes (Kind Alias only — 8 extra)

Kind Alias root controllers (Entity, List, EntityReactions, ListReactions — 4 controllers) each add 2 `/{hierarchyAlias}` routes that let callers use domain-friendly hierarchy names configured via `app.kindAliasPaths[N].hierarchyAlias`:

- `GET /books/{id}/chapters` instead of `GET /books/{id}/children`
- `POST /books/{id}/chapters` instead of `POST /books/{id}/children`

4 controllers × 2 routes = **8 extra domain-driven hierarchy routes**, accounting for the difference between Base Generic Hierarchy (3 per controller) and Kind Alias Hierarchy (5 per controller). The Relation kind alias controller has no hierarchy routes and remains at 8, matching its base generic counterpart.

### Route Tag System

Every route carries a rich set of metadata tags enabling fine-grained targeting. Key tag categories:

| Category | Example tags |
|:---|:---|
| HTTP Method | `get`, `post`, `patch`, `put`, `delete` |
| Operation | `find`, `count`, `create`, `update`, `replace`, `delete`, `update-all`, `bulk` |
| Access Pattern | `read-only`, `write`, `destructive`, `manage` |
| Data Scope | `by-id`, `single-record`, `collection`, `bulk` |
| Record Type | `entities`, `lists`, `relations`, `entityReactions`, `listReactions` |
| Context | `generic` (65 routes), `kind-alias` (73 routes) |
| Topology | `through` (26 routes) |
| Hierarchy | `hierarchical`, `children`, `parents`, `domain-driven` |
| Utility | `utility`, `health-check`, `api-discovery` |

Tags are the primary mechanism for the **Route Toggles** feature. A single tag in the disabled list can silence dozens of routes without redeployment (e.g., disabling `generic` hides all 65 base generic routes, leaving a clean domain-native surface).  
→ See [`entity-persistence-gateway/.context/11-ROUTE-TAGS.md`](../../entity-persistence-gateway/.context/11-ROUTE-TAGS.md)

---

## Feature Reference

Every capability is implemented as a `GatewayFilterFactory`. Filters are declared in `application-routes.yml` per route.

### 1. Request Tracing & Observability
**Filter:** `GenerateRequestId`  
Generates a composite request ID: `APP-{authParty}-{timestamp}-{random}` (e.g., `BOOKS-USER42-20260203091534-A7K9M`). Stored in MDC as `RequestId`. Propagated via `X-Request-Id` header.

### 2. Dynamic Route Toggling
**Filter:** `CheckIfRouteEnabled`  
Routes can be enabled/disabled without redeployment using route tags. Disabled routes return `405 Method Not Allowed`.  
Config: `app.routes.disabled: updateAllEntities, findEntities` or tag-based: `app.routes.tags.disabled: generic`.  
→ See [`entity-persistence-gateway/.context/75-FEATURE-ROUTE-TOGGLES.md`](../../entity-persistence-gateway/.context/75-FEATURE-ROUTE-TOGGLES.md)

### 3. Request Size Limiting
**Filter:** `RequestSize` (global), `DynamicRequestSizeFilter` (per kind)  
Default: `1KB`. Prevents large payload attacks.  
Config: `app.kindAliasPaths[N].maxRequestSize`

### 4. Rate Limiting
**Filters:** `RequestRateLimiter` (per route), `DynamicRateLimiter` (per kind)  
Token bucket algorithm backed by Redis. Key: authenticated user ID (or IP if unauthenticated).  
Config: `replenishRate`, `burstCapacity` in route filter args or `app.kindAliasPaths[N].rateLimiter.*`

### 5. Authentication (JWT)
**Filter:** `AuthenticateRequest`  
Validates JWT signature against RS256 public key. Extracts `sub` (user ID), `roles`, `groups`, `email_verified`. Supports multiple issuers.  
Config: `app.auth.rs256PublicKey`, `app.auth.issuer`, `app.auth.clockSkewSeconds`  
→ See [`entity-persistence-gateway/.context/40-FEATURE-AUTHENTICATION.md`](../../entity-persistence-gateway/.context/40-FEATURE-AUTHENTICATION.md)

### 6. JSON Schema Validation
**Filter:** `ValidateRequestBodyByKindSchema`  
Validates POST/PUT request bodies against per-kind JSON schemas (draft 2020-12). Active only on Kind Alias routes.  
Config: `app.kindAliasPaths[N].schema` (inline JSON string)  
On failure: `422 Unprocessable Entity` with field-level error details.

### 7. Query Safety
**Filter:** `PreventStringifiedJsonFilter`  
Blocks queries containing stringified JSON (e.g., `?filter={"where":...}`). Reduces injection risk.

### 8. Policy-Based Authorization (OPA)
**Filter:** `AuthorizeRequest`  
Sends a structured policy input (JWT claims, request body, HTTP verb, route name, original record metadata) to OPA. Awaits `allow: true/false`.  
On deny: `403 Forbidden`.  
Config: `app.opa.protocol`, `app.opa.host`, `app.opa.port`  
→ See [`entity-persistence-gateway/.context/45-FEATURE-AUTHORIZATION.md`](../../entity-persistence-gateway/.context/45-FEATURE-AUTHORIZATION.md)

### 9. Field-Level Security
**Filters:** `FetchForbiddenFields`, `PreventQueryByForbiddenFields`, `FieldFilter`, `AddForbiddenFieldsFromOriginalToPayloadInReplace`  
Two-pass approach:
1. Fetch `forbiddenFields[]` list from OPA.
2. Pre-request: strip forbidden fields from query parameters.
3. Post-response: physically remove forbidden fields from JSON response body.
4. On PUT (replace): inject original forbidden field values into the replacement payload to prevent accidental deletion.

### 10. Managed Fields Injection
**Filters:** `AddManagedFieldsInCreation`, `AddManagedFieldsInPatch`, `AddManagedFieldsFromOriginalToPayloadInReplace`

**On POST (create):** `AddManagedFieldsInCreation` injects `_createdBy` (JWT `sub`), `_createdDateTime` (now), `_ownerUsers` ([sub]), `_lastUpdatedBy` (JWT `sub`), `_lastUpdatedDateTime` (now) using `putIfAbsent` — callers with rights can supply their own values (e.g. admin backfill).

**On PATCH (update):** `AddManagedFieldsInPatch` injects `_lastUpdatedBy` and `_lastUpdatedDateTime` using a **forbidden-field-aware** strategy:
- If the field is **forbidden** for this caller (editor / member without a field-level role): always overwrite with the caller's identity / current timestamp, even if they echoed the original value.
- If the field is **not forbidden** (admin, or caller holding a `tarcinapp.fields.*._lastUpdatedBy.update` role): `putIfAbsent` — only inject when absent; honour any value the caller expressed.

**On PUT (replace):** `AddManagedFieldsFromOriginalToPayloadInReplace` applies the same forbidden-field-aware strategy for `_lastUpdatedBy` and `_lastUpdatedDateTime`, and `putIfAbsent` for `_createdBy`, `_createdDateTime`, and `_ownerUsers` (restoring originals for fields the caller omitted).

### 11. Sets Injection (Security-Critical)
**Filters:** `AddSetsToEntityListOrReactionViaRecordQuery`, `AddSetsToRelationQuery`, `AddSetsToReactionsQuery`, `AddSetsToThroughRecordQuery`

This is one of the gateway's most important security behaviors. Before any read query is forwarded to EPS, the gateway **automatically injects `sets[...]` filter parameters** based on the authenticated caller's role and identity. These `sets[...]` parameters map to named access-scoping rules evaluated by EPS (e.g., `sets[actives]`, `sets[owners][userIds]=<userId>`).

The effect: a regular user's `GET /books` query is transparently rewritten to include ownership and visibility scopes before hitting the database — they can never see records outside their permitted set, regardless of what query parameters they send.

| Filter | Applies to |
|:---|:---|
| `AddSetsToEntityListOrReactionViaRecordQuery` | Entity, List, and EntityReaction/ListReaction root queries |
| `AddSetsToRelationQuery` | Relation queries |
| `AddSetsToReactionsQuery` | Reaction queries (entity reactions, list reactions) |
| `AddSetsToThroughRecordQuery` | All traversal ("through") queries |

Sets are configured via `app.queries.*` as SpEL expressions that combine role checks with identity values:
```yaml
app:
  queries:
    my: "'sets[owners][userIds]='+#userId"
    actives: "'sets[actives]'"
```

None of these filters require inline configuration; the injection logic is determined entirely by the evaluated SpEL context at request time.

### 12. Domain Mapping (Kind Aliasing)
**Filters:** `KindResolution`, `PlaceKindNameIntoPayload`, `ConvertKindAliasToKindQuery`, `HierarchyKindAliasResolver`, `ThroughKindAliasResolver`

The engine that projects generic routes into domain endpoints:
- `KindResolution`: maps `/books` → `_kind=book` (sets `KindAliasConfigAttr` on the exchange)
- `PlaceKindNameIntoPayload`: injects `"_kind":"book"` into POST/PUT/PATCH body
- `ConvertKindAliasToKindQuery`: rewrites GET query to add `filter[where][_kind]=book`
- `HierarchyKindAliasResolver`: maps `GET /books/{id}/chapters` → `GET /entities/{id}/children?filter[where][_kind]=chapter`
- `ThroughKindAliasResolver`: resolves through-record kind alias routes (e.g., `GET /books/{id}/reviews` → `GET /entities/{id}/reactions?filter[where][_kind]=review`). Returns `404` if the through-record alias is not configured.

### 13. Domain Include Alias Projection
**Filters:** `ConvertDomainIncludeAliasToGenericRelation`, `ProjectDomainIncludeAliasInResponse`

Allows clients to use domain-level alias names in `filter[include]` instead of raw generic relation names.

**Request phase** (`ConvertDomainIncludeAliasToGenericRelation`):
- Scans `filter[include][N][relation]` keys in the query string.
- Leaves generic relations (`_entities`, `_reactions`) unchanged.
- Resolves configured alias names to their generic bucket (e.g., `books` → `_entities`) and injects `scope[where][_kind]=book`.
- Safely merges with any existing `scope[where]` clause by wrapping in an `and` condition.
- Stores the projection mapping in exchange attributes for the response phase.

**Response phase** (`ProjectDomainIncludeAliasInResponse`):
- Reads the stored alias projection context.
- Renames matching include fields in the JSON payload back to the alias names the caller requested (e.g., `_entities` → `books`).
- Skips transformation when no projection context is present.

**Coverage:** Active on all entity and list `find*` routes (including kind-alias and traversal variants). Not used on relation, reaction, count, create, or update-all routes.

**Example:**  
Client sends: `GET /books?filter[include][0][relation]=_shelves`  
Backend receives: `GET /entities?filter[where][_kind]=book&filter[include][0][relation]=_lists&filter[include][0][scope][where][_kind]=shelf`  
Client receives response with field `_shelves` (not `_lists`).

### 14. Type Hint Injection
**Filter:** `InjectTypeHintsToQuery`

Automatically injects LoopBack 4 type hints (`[type]=number` or `[type]=boolean`) into where-clause query parameters. Clients do not need to include them manually.

- Runs after `PreventQueryByForbiddenFields`, before `RemoveRequestHeader=Authorization`.
- Only active on Kind Alias routes (requires `KindAliasConfigAttr`; skipped on generic routes).
- Consults `TypeHintSchemaRegistry` built at startup from OpenAPI alias schemas.
- Handles implicit exact-match (`filter[where][price]`), explicit operators (`filter[where][price][gt]`), and array-value operators (`filter[where][price][inq][0]`).
- Supports dot-notation field paths (`filter[where][info.pageCount]`).
- Skips gateway-managed fields (starting with `_`) and any keys containing `[lookup]` (lookup scope type cannot be resolved from the current route's schema).
- Wired into 80 route definitions.

### 15. Query Simplification
**Filter:** `ConvertSimplerQueriesToBackendFormat`  
Translates client-friendly params to LoopBack syntax:

| Client sends | Gateway rewrites to |
|:---|:---|
| `?s=foo` | `?filter[where][_name][regexp]=.*foo.*` |
| `?limit=20` | `?filter[limit]=20` |
| `?skip=10` | `?filter[skip]=10` |
| `?order=name` | `?filter[order]=name` |

### 16. Field Sets
**Filter:** `ApplyFieldsetConfig`  
Expands named field sets from config into `filter[fields]` parameters.  
Config: `app.fieldsets.<name>.show` or `app.fieldsets.<name>.hide`  
Client: `?fieldset=bookinfo`  
→ See [`entity-persistence-gateway/.context/85-FEATURE-FIELDSETS.md`](../../entity-persistence-gateway/.context/85-FEATURE-FIELDSETS.md)

### 17. Distributed Locking
**Filters:** `AcquireLockForCreation`, `AcquireLockForUpdate`  
Redis-based distributed locks prevent race conditions in concurrent creates and updates. Lock keys are often derived from record-specific fields (e.g., list ID for relation creation).  
→ See [`entity-persistence-gateway/.context/60-FEATURE-DISTRIBUTED-LOCKING.md`](../../entity-persistence-gateway/.context/60-FEATURE-DISTRIBUTED-LOCKING.md)

### 18. Local Response Caching
**Filter:** `DynamicLocalCache`
In-memory cache for GET responses. Respects `Cache-Control` headers from EPS. Configurable TTL and max size per route. Cache keys are prefixed with `app.shortcode` (`{shortcode}:cache:METHOD:PATH:?sortedQuery:userId`), consistent with all Redis key conventions in the system.
→ See [`entity-persistence-gateway/.context/58-FEATURE-LOCAL-CACHING.md`](../../entity-persistence-gateway/.context/58-FEATURE-LOCAL-CACHING.md)

### 19. Dynamic Timeout
**Filter:** `DynamicTimeout`  
Per-route configurable connect/read timeouts. Defaults can be overridden per kind alias. Configuration lives in `application-timeouts.yml`.

### 20. Dynamic OpenAPI Generation
**Components:** `DynamicOasHandler`, `OasTransformationEngine`, `OasSchemaPruner`  
Generates a personalized OpenAPI spec at runtime:
- Applies Kind Alias path rewriting
- Respects active route toggles
- Prunes fields from schemas based on the caller's `forbiddenFields`
- Returns the user-specific API surface

Client: `GET /openapi.json` or `GET /openapi.yaml` (with or without Bearer token)
→ See [`entity-persistence-gateway/.context/90-FEATURE-DYNAMIC-OAS-GENERATION.md`](../../entity-persistence-gateway/.context/90-FEATURE-DYNAMIC-OAS-GENERATION.md)

### 21. Application Shortcode Propagation
**Configuration:** `spring.cloud.gateway.default-filters: AddRequestHeader=X-App-Shortcode, ${app.shortcode}` (built-in filter, no custom class)
Injects the configured `app.shortcode` value as the `X-App-Shortcode` HTTP header on every proxied request. Enables downstream services (Orchestrator, EPC, EPS) to identify the application deployment context for Redis key namespacing and per-application processor branching. This is the mechanism by which the gateway's single-source-of-truth application identity is propagated to the entire downstream call chain.
→ See [`entity-persistence-gateway/.context/62-FEATURE-APP-SHORTCODE-PROPAGATION.md`](../../entity-persistence-gateway/.context/62-FEATURE-APP-SHORTCODE-PROPAGATION.md)

---

## Complete Filter Catalogue

| Filter | Category | Purpose |
|:---|:---|:---|
| `RequestSize` | Validation (built-in) | Global max request body size |
| `RewritePath` | Routing (built-in) | URL path rewriting |
| `RequestRateLimiter` | Protection (built-in) | Per-route rate limiting |
| `RemoveRequestHeader` | Transformation (built-in) | Strip headers (e.g., `Authorization`) before forwarding |
| `SetStatus` | Response (built-in) | Hardcode HTTP status (used for disabled utility routes) |
| `CheckIfRouteEnabled` | Control | Enable/disable routes via tags without redeployment |
| `AuthenticateRequest` | Security | JWT validation, claim extraction |
| `GenerateRequestId` | Tracing | Composite `X-Request-Id` generation |
| `FetchForbiddenFields` | Security | Retrieve field-level permission list from OPA |
| `AuthorizeRequest` | Security | OPA policy decision (allow/deny) |
| `PreventStringifiedJsonFilter` | Validation | Block stringified-JSON query injection |
| `PreventQueryByForbiddenFields` | Validation | Strip forbidden fields from query params |
| `InjectTypeHintsToQuery` | Transformation | Auto-inject `[type]=number/boolean` hints into where clauses |
| `ValidateRequestBodyByKindSchema` | Validation | JSON Schema body validation per kind |
| `AddSetsToEntityListOrReactionViaRecordQuery` | Security | Inject `sets[...]` scope into entity/list/reaction queries |
| `AddSetsToRelationQuery` | Security | Inject `sets[...]` scope into relation queries |
| `AddSetsToReactionsQuery` | Security | Inject `sets[...]` scope into reaction queries |
| `AddSetsToThroughRecordQuery` | Security | Inject `sets[...]` scope into traversal queries |
| `KindResolution` | Routing | Resolve alias path segment to `_kind` value |
| `HierarchyKindAliasResolver` | Routing | Map domain hierarchy URLs to `/children`/`/parents` |
| `ThroughKindAliasResolver` | Routing | Map through-record alias URLs to technical through paths |
| `ConvertKindAliasToKindQuery` | Transformation | Add `filter[where][_kind]` from resolved alias |
| `ConvertDomainIncludeAliasToGenericRelation` | Transformation | Normalize `filter[include][N][relation]` aliases to generic relations + `_kind` scope |
| `ProjectDomainIncludeAliasInResponse` | Transformation | Rename generic include fields in response back to alias names |
| `PlaceKindNameIntoPayload` | Transformation | Inject `"_kind"` into POST/PUT/PATCH body |
| `AddManagedFieldsInCreation` | Transformation | Inject `_createdBy`, `_ownerUsers`, `_lastUpdatedBy`, timestamps on POST (create) |
| `AddManagedFieldsInPatch` | Transformation | Inject `_lastUpdatedBy` and `_lastUpdatedDateTime` on PATCH (update) with forbidden-field-aware strategy |
| `AddManagedFieldsFromOriginalToPayloadInReplace` | Transformation | Inject managed fields on PUT (replace) with forbidden-field-aware strategy for audit fields |
| `AddForbiddenFieldsFromOriginalToPayloadInReplace` | Transformation | Preserve forbidden fields on PUT to prevent blind overwrites |
| `ConvertSimplerQueriesToBackendFormat` | Transformation | `s=`, `limit=`, `skip=`, `order=` → LoopBack syntax |
| `ApplyFieldsetConfig` | Transformation | Expand named fieldsets to `filter[fields]` |
| `FieldFilter` | Transformation | Strip forbidden fields from response body |
| `AcquireLockForCreation` | Concurrency | Redis distributed lock for creates |
| `AcquireLockForUpdate` | Concurrency | Redis distributed lock for updates |
| `DynamicLocalCache` | Performance | In-memory GET response cache |
| `DynamicRateLimiter` | Protection | Per-kind configurable rate limiting |
| `DynamicRequestSizeFilter` | Validation | Per-kind configurable request size limit |
| `DynamicTimeout` | Configuration | Per-kind configurable connect/read timeouts |

---

## Key Configuration Properties

```yaml
app:
  name: my-app                    # spring.application.name
  shortcode: myapp                # prefix for: request IDs, role names, Redis lock/cache keys, X-App-Shortcode header
  inbound:
    address: 0.0.0.0
    port: 8081
    baseUri: /api/v1/
    controllerBasePaths:
      entities: entities
      lists: lists
      relations: relations
      entityReactions: entity-reactions
      listReactions: list-reactions
  backend:
    protocol: http
    host: entity-persistence-service
    port: 3000
    baseURI: /
  opa:
    protocol: http
    host: entity-persistence-gateway-policies
    port: 8181
  auth:
    rs256PublicKey: <PEM public key>
    issuer: http://keycloak:8080/realms/tarcinapp
    clockSkewSeconds: 60
  routes:
    disabled: ""                  # comma-separated route IDs
    tags:
      disabled: ""                # comma-separated tags (e.g. "generic" to hide all base routes)
  fieldsets:
    managed:
      show: _id, _kind, _name, _visibility, _ownerUsers, ...
    unmanaged:
      hide: _slug, _version, _ownerUsers, ...
  queries:
    my: "'sets[owners][userIds]='+#userId"
    actives: "'sets[actives]'"
  kindAliasPaths:
    - alias: books
      name: book
      schema: '{"$schema":"...","type":"object","properties":{...}}'
      maxRequestSize: 4096
      hierarchyAlias: chapters     # enables GET /books/{id}/chapters
      throughRecords:
        - alias: reviews
          name: review
```

---

## Request-Response Filter Chain

### POST /api/v1/books (createEntity via Kind Alias)

```
Client POST /api/v1/books
  → CheckIfRouteEnabled          (is this route active?)
  → DynamicRequestSizeFilter     (per-kind payload size check)
  → RequestSize                  (global payload ≤ max size?)
  → DynamicRateLimiter           (per-kind rate limit check)
  → RequestRateLimiter           (per-route rate limit check)
  → RewritePath                  (rewrite /books → /entities internally)
  → GenerateRequestId            (assign X-Request-Id, populate MDC)
  → AuthenticateRequest          (verify JWT, extract sub/roles/groups)
  → ValidateRequestBodyByKindSchema  (schema check for _kind=book)
  → PreventStringifiedJsonFilter (block ?filter={...} injection)
  → FetchForbiddenFields         (call OPA: which fields are forbidden?)
  → AuthorizeRequest             (call OPA: is this operation allowed?)
  → PreventQueryByForbiddenFields
  → KindResolution               (resolve "books" → _kind=book)
  → PlaceKindNameIntoPayload     (inject "_kind":"book" into body)
  → AddManagedFieldsInCreation   (inject _createdBy, _ownerUsers, timestamps)
  → AcquireLockForCreation       (acquire Redis lock)
  → RemoveRequestHeader=Authorization
  → [proxy to entity-persistence-service POST /entities]
  ← FieldFilter                  (strip forbidden fields from response body)
  ← [return 201 to client]
```

### GET /api/v1/books (findAll via Kind Alias)

```
Client GET /api/v1/books?s=tolkien&limit=10&filter[include][0][relation]=_shelves
  → CheckIfRouteEnabled
  → DynamicRateLimiter
  → RequestRateLimiter
  → RewritePath
  → GenerateRequestId
  → AuthenticateRequest
  → PreventStringifiedJsonFilter
  → FetchForbiddenFields
  → AuthorizeRequest
  → ConvertDomainIncludeAliasToGenericRelation
      (rewrites _shelves → _lists, injects scope[where][_kind]=shelf)
  → ApplyFieldsetConfig          (expand ?fieldset=... to filter[fields])
  → ConvertSimplerQueriesToBackendFormat
      (rewrites s=tolkien → filter[where][_name][regexp]=.*tolkien.*,
               limit=10 → filter[limit]=10)
  → KindResolution               (resolve "books" → _kind=book)
  → ConvertKindAliasToKindQuery  (add filter[where][_kind]=book)
  → AddSetsToEntityListOrReactionViaRecordQuery
      (inject sets[actives], sets[owners][userIds]=<userId> per role)
  → PreventQueryByForbiddenFields
  → InjectTypeHintsToQuery       (inject [type]=number/boolean hints)
  → RemoveRequestHeader=Authorization
  → DynamicLocalCache            (serve from cache if valid entry exists)
  → [proxy to entity-persistence-service GET /entities?filter[where][_kind]=book&...]
  ← ProjectDomainIncludeAliasInResponse
      (rename _lists → _shelves in response JSON)
  ← FieldFilter                  (strip forbidden fields from response)
  ← [return 200 to client]
```

---

## Related Documents

- `00_SYSTEM_MANIFEST.md` — Six-layer architecture, security philosophy
- `12_COMPONENT_gateway-policies.md` — OPA policy structure and role model
- `22_CONCEPT_domain-projection.md` — Kind aliasing deep dive
- `21_CONCEPT_security-and-authorization.md` — End-to-end security flow
- `entity-persistence-gateway/.context/` — Per-feature deep dives (20+ documents)
  - `10-ROUTES.md` — Full route inventory with all 140 route IDs
  - `11-ROUTE-TAGS.md` — Complete tag catalogue and assignment rules
  - `20-FILTERS.md` — All filter descriptions with per-route usage lists
  - `75-FEATURE-ROUTE-TOGGLES.md` — Route toggle configuration reference
  - `85-FEATURE-FIELDSETS.md` — Field set configuration reference
  - `40-FEATURE-AUTHENTICATION.md` — Authentication deep dive
  - `45-FEATURE-AUTHORIZATION.md` — OPA authorization deep dive
  - `58-FEATURE-LOCAL-CACHING.md` — Caching configuration
  - `60-FEATURE-DISTRIBUTED-LOCKING.md` — Distributed locking reference
  - `90-FEATURE-DYNAMIC-OAS-GENERATION.md` — Dynamic OpenAPI generation
