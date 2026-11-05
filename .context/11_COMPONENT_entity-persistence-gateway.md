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
1. **Security enforcer** — JWT validation, OPA authorization, field masking, ownership injection, distributed locking.
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

The app uses a **modular YAML** structure. `application.yml` is the root — it sets Netty, Redis, and imports feature configs:

```
src/main/resources/
├── application.yml                  ← root: Netty, Redis, spring.config.import
├── application-routes.yaml          ← ALL 140 routes defined here
├── application-auth.yml             ← JWT issuers, public keys, clock skew
├── application-locks.yml            ← distributed lock config per route
├── application-fieldsets.yml        ← named field sets
├── application-logging.yml          ← log level knobs per package
└── logback-spring.xml               ← Logback wiring
```

All keys map to environment variables using Spring's convention: `app.auth.rs256PublicKey` → `APP_AUTH_RS256PUBLICKEY`.

---

## Route Topology (140 Routes)

Routes are organized along two independent dimensions:

### Dimension 1: Context

| Context | Count | Description |
|:---|:---|:---|
| **Base Generic** | 65 routes | Direct mirrors of EPS endpoints. Use generic resource names (`/entities`, `/lists`, etc.). |
| **Kind Alias** | 73 routes | Domain-projected wrappers. Use configured aliases (`/books`, `/shelves`). Mirror the Base Generic structure but scope to `_kind`. Have 8 extra routes for Dynamic Hierarchy. |
| **Utility** | 2 routes | `/ping`, `/openapi.json` / `/openapi.yaml` |

### Dimension 2: Topology

| Topology | Description | Controllers |
|:---|:---|:---|
| **Root** | Manages a resource type directly | Entity, List, Relation, EntityReactions, ListReactions |
| **Traversal ("Through")** | Navigates a relationship edge | ReactionsThroughEntity, ReactionsThroughList, EntitiesThroughList, ListsThroughEntity |

### Route Type Categories within a Controller

| Type | Path pattern | Operations |
|:---|:---|:---|
| Collection | `/{resource}` | find, create, count, updateAll |
| Single Item | `/{resource}/{id}` | findById, updateById, replaceById, deleteById |
| Hierarchy | `/{resource}/{id}/children`, `/{resource}/{id}/parents` | findChildren, createChild, findParents |

> Through controllers only expose Collection-type routes (no single-item addressing or hierarchy within a traversal path).

### Dynamic Hierarchy Routes (Kind Alias only — 8 extra)
Kind Alias controllers add `/{hierarchyAlias}` routes that let callers use domain-friendly hierarchy names:
- `GET /entities/books/{id}/chapters` instead of `GET /entities/books/{id}/children`
- `POST /entities/books/{id}/chapters` instead of `POST /entities/books/{id}/children`

These 4 controllers × 2 routes = 8 explain the count difference between Base Generic (65) and Kind Alias (73).

---

## Feature Reference

Every capability is implemented as a `GatewayFilterFactory`. Filters are declared in `application-routes.yaml` per route.

### 1. Request Tracing & Observability
**Filter:** `GenerateRequestId`  
Generates a composite request ID: `APP-{authParty}-{timestamp}-{random}` (e.g., `BOOKS-USER42-20260203091534-A7K9M`). Stored in MDC as `RequestId`. Propagated via `X-Request-Id` header.

### 2. Dynamic Route Toggling
**Filter:** `CheckIfRouteEnabled`  
Routes can be enabled/disabled without redeployment using route tags. Disabled routes return `405 Method Not Allowed`.  
Config: `app.routes.disabled: updateAllEntities, findEntities` or tag-based: `app.routes.tags.disabled: generic`.  
→ See [`.context/75-FEATURE-ROUTE-TOGGLES.md`](../../entity-persistence-gateway/.context/75-FEATURE-ROUTE-TOGGLES.md)

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
→ See [`.context/40-FEATURE-AUTHENTICATION.md`](../../entity-persistence-gateway/.context/40-FEATURE-AUTHENTICATION.md)

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
→ See [`.context/45-FEATURE-AUTHORIZATION.md`](../../entity-persistence-gateway/.context/45-FEATURE-AUTHORIZATION.md)

### 9. Field-Level Security
**Filters:** `FetchForbiddenFields`, `PreventQueryByForbiddenFields`, `FieldFilter`, `AddForbiddenFieldsFromOriginalToPayloadInReplace`  
Two-pass:
1. Fetch `forbiddenFields[]` list from OPA.
2. Pre-request: strip forbidden fields from query parameters.
3. Post-response: physically remove forbidden fields from JSON response body.
4. On PUT (replace): inject original forbidden field values into the replacement payload to prevent accidental deletion.

### 10. Managed Fields Injection
**Filters:** `AddManagedFieldsInCreation`, `AddManagedFieldsFromOriginalToPayloadInReplace`  
On creation: injects `_createdBy` (from JWT `sub`), `_createdDateTime` (now), `_ownerUsers` ([sub]), `_lastUpdatedBy`, `_lastUpdatedDateTime`.  
On PUT: fetches the original record and merges managed fields from it unless the caller has admin override rights.

### 11. Domain Mapping (Kind Aliasing)
**Filters:** `KindResolution`, `PlaceKindNameIntoPayload`, `ConvertKindAliasToKindQuery`, `HierarchyKindAliasResolver`  
The engine that projects generic routes into domain endpoints:
- `KindResolution`: maps `/books` → `_kind=book`
- `PlaceKindNameIntoPayload`: injects `"_kind":"book"` into POST/PUT/PATCH body
- `ConvertKindAliasToKindQuery`: rewrites GET query to add `filter[where][_kind]=book`
- `HierarchyKindAliasResolver`: maps `/books/{id}/chapters` → `/entities/{id}/children?filter[where][_kind]=chapter`

### 12. Query Simplification
**Filter:** `ConvertSimplerQueriesToBackendFormat`  
Translates client-friendly params to LoopBack syntax:
| Client sends | Gateway rewrites to |
|:---|:---|
| `?s=foo` | `?filter[where][_name][regexp]=.*foo.*` |
| `?limit=20` | `?filter[limit]=20` |
| `?skip=10` | `?filter[skip]=10` |
| `?order=name` | `?filter[order]=name` |

### 13. Field Sets
**Filter:** `ApplyFieldsetConfig`  
Expands named field sets from config into `filter[fields]` parameters.  
Config: `app.fieldsets.<name>.show` or `app.fieldsets.<name>.hide`  
Client: `?fieldset=bookinfo`  
→ See [`.context/85-FEATURE-FIELDSETS.md`](../../entity-persistence-gateway/.context/85-FEATURE-FIELDSETS.md)

### 14. Distributed Locking
**Filters:** `AcquireLockForCreation`, `AcquireLockForUpdate`  
Redis-based distributed locks prevent race conditions in concurrent creates and updates. Lock keys are often derived from record-specific fields (e.g., list ID for relation creation).  
→ See [`.context/60-FEATURE-DISTRIBUTED-LOCKING.md`](../../entity-persistence-gateway/.context/60-FEATURE-DISTRIBUTED-LOCKING.md)

### 15. Local Response Caching
**Filter:** `DynamicLocalCache`  
In-memory cache for GET responses. Respects `Cache-Control` headers from EPS. Configurable TTL and max size per route.  
→ See [`.context/58-FEATURE-LOCAL-CACHING.md`](../../entity-persistence-gateway/.context/58-FEATURE-LOCAL-CACHING.md)

### 16. Dynamic Timeout
**Filter:** `DynamicTimeout`  
Per-route configurable connect/read timeouts. Defaults can be overridden per kind alias.

### 17. Dynamic OpenAPI Generation
**Components:** `DynamicOasHandler`, `OasTransformationEngine`, `OasSchemaPruner`  
Generates a personalized OpenAPI spec at runtime:
- Applies Kind Alias path rewriting
- Respects active route toggles
- Prunes fields from schemas based on the caller's `forbiddenFields`
- Returns the user-specific API surface

Client: `GET /openapi.json` or `GET /openapi.yaml` (with or without Bearer token)  
→ See [`.context/90-FEATURE-DYNAMIC-OAS-GENERATION.md`](../../entity-persistence-gateway/.context/90-FEATURE-DYNAMIC-OAS-GENERATION.md)

---

## Key Configuration Properties

```yaml
app:
  name: my-app                    # spring.application.name
  shortcode: myapp                # prefix for role names: myapp.admin, myapp.member
  inbound:
    address: 0.0.0.0
    port: 8081
    baseUri: /api/v1/
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
    disabled: ""                  # comma-separated route IDs or tags
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
```

Environment variable format: `APP_KINDALIASPATHS_0_ALIAS=books`

---

## Request-Response Filter Chain (for `createEntity`)

```
Client POST /api/v1/books
  → CheckIfRouteEnabled          (is this route active?)
  → RequestSize                  (payload ≤ max size?)
  → RequestRateLimiter           (within rate limit?)
  → GenerateRequestId            (assign X-Request-Id)
  → AuthenticateRequest          (verify JWT, extract claims)
  → ValidateRequestBodyByKindSchema  (schema check for _kind=book)
  → PreventStringifiedJsonFilter
  → FetchForbiddenFields         (call OPA: which fields are forbidden for this user?)
  → AuthorizeRequest             (call OPA: is this operation allowed?)
  → PreventQueryByForbiddenFields
  → KindResolution               (resolve "books" → _kind=book)
  → PlaceKindNameIntoPayload     (inject "_kind":"book" into body)
  → AddManagedFieldsInCreation   (inject _createdBy, _ownerUsers, timestamps)
  → AcquireLockForCreation       (acquire Redis lock)
  → [proxy to entity-persistence-service POST /entities]
  → FieldFilter                  (strip forbidden fields from response)
  → [return to client]
```

---

## Related Documents
- `00_SYSTEM_MANIFEST.md` — Six-layer architecture, security philosophy
- `12_COMPONENT_gateway-policies.md` — OPA policy structure and role model
- `22_CONCEPT_domain-projection.md` — Kind aliasing deep dive
- `21_CONCEPT_security-and-authorization.md` — End-to-end security flow
- `entity-persistence-gateway/.context/` — Per-feature deep dives (20+ documents)
