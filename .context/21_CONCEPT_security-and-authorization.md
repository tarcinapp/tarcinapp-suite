# 21_CONCEPT_security-and-authorization.md

## Overview

Security in Tarcinapp is a multi-layer, end-to-end chain. No single component owns all of it:

1. **Keycloak** issues JWTs and declares user identity and roles.
2. **Gateway** validates JWTs, rejects unauthenticated requests, and injects caller context.
3. **OPA** decides whether the operation is allowed and which fields must be hidden.
4. **Gateway** enforces OPA's decision: blocks the request, strips fields from the response, or scopes the query via sets injection.
5. **EPS** receives only already-authorized, already-scoped requests. It does not perform any access control.

---

## The Request Security Flow

```
Client (with Bearer JWT)
      │
      ▼
entity-persistence-gateway
      │
      ├─ 1. AuthenticateRequest
      │      Verify JWT signature (RS256 public key or JWKS)
      │      Validate iss (routed to matching provider), exp, nbf, clockSkew
      │      Extract sub, roles[], groups[], azp
      │      → MISSING header: 401 Unauthorized
      │      → EXPIRED token: 401 Unauthorized
      │      → UNKNOWN issuer: 401 Unauthorized
      │
      ├─ 2. FetchForbiddenFields
      │      Call OPA: POST /v1/data/policies/gateway/forbidden_fields/policy
      │      Input: {encodedJwt, appShortcode}
      │      Output: which_fields_forbidden_for_finding[]
      │              which_fields_forbidden_for_create[]
      │              which_fields_forbidden_for_update[]
      │      → OPA unavailable: 500 (fail-closed)
      │
      ├─ 3. AuthorizeRequest (with originalRecord for single-item ops)
      │      For single-item ops: fetch record from EPS via unauthenticated
      │        backend call GET /entities/{id} → raw, unfiltered record
      │        → Record 404 from EPS: return 404 to caller (no enumeration)
      │      Call OPA: POST /v1/data/policies/auth/routes/{resource}/{op}/policy
      │      Input: {encodedJwt, request, originalRecord, appShortcode}
      │      Output: allow: true | false
      │      → allow=false: 403 Forbidden
      │
      ├─ 4. PreventQueryByForbiddenFields
      │      Strip forbidden field names from filter[fields] and query params
      │
      ├─ 5. AddSetsToEntityListOrReactionViaRecordQuery  ← visibility scoping
      │      Inject sets[] filters into query based on caller role:
      │        admin/editor  → no sets injected (see all)
      │        member        → sets[owners][userIds]={sub}
      │                        OR (sets[actives]=true AND sets[publics]=true)
      │        visitor       → sets[actives]=true AND sets[publics]=true
      │
      ├─ 6. InjectTypeHintsToQuery
      │      Add _kind and type-hint parameters to the backend query
      │
      ├─ [proxy to EPS / Orchestrator]
      │
      └─ 7. FieldFilter
             Strip forbidden fields from response body
```

---

## JWT Authentication

### Token Requirements

The Gateway expects a Bearer token in the `Authorization` header:
```
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

Validated fields:
- **Signature**: RS256 against the matched provider's public key or JWKS
- **`iss`**: must exactly match one of the configured provider issuers (used to route to the correct parser)
- **`exp`**: must be in the future (with `clock-skew-seconds` tolerance)

### Failure Modes

| Condition | HTTP Response |
|:---|:---|
| `Authorization` header missing | `401 Unauthorized` |
| Header is not `Bearer` scheme | `401 Unauthorized` |
| `iss` claim missing from token | `401 Unauthorized` |
| `iss` does not match any configured provider | `401 Unauthorized` |
| Signature invalid or tampered | `401 Unauthorized` |
| Token expired (beyond clock skew) | `401 Unauthorized` |
| JWKS endpoint timed out | `504 Gateway Timeout` |
| JWKS endpoint returned 5xx | `502 Bad Gateway` |

> **Important:** Expired tokens return `401`, not `403`. `403` is reserved exclusively for OPA authorization denials after successful authentication.

### Multiple Issuers (Multi-Provider Support)

The gateway supports multiple identity providers simultaneously. Providers are configured as a list under `app.auth.providers`:

```yaml
app:
  auth:
    providers:
      # Provider 1: Internal Keycloak with static public key
      - issuer: "tarcinapp-idm"
        public-key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."
        clock-skew-seconds: 60

      # Provider 2: Google Firebase (JWKS-based key rotation)
      - issuer: "https://securetoken.google.com/my-project-id"
        jwk-set-uri: "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
        clock-skew-seconds: 60
```

Or in indexed `.properties` format:
```properties
app.auth.providers[0].issuer=tarcinapp-idm
app.auth.providers[0].public-key=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
app.auth.providers[0].clock-skew-seconds=60

app.auth.providers[1].issuer=https://securetoken.google.com/my-project-id
app.auth.providers[1].jwk-set-uri=https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com
app.auth.providers[1].clock-skew-seconds=60
```

**How issuer routing works:**
1. The `iss` claim is extracted from the JWT payload via Base64 decode — **before** signature verification.
2. The `TokenParserRegistry` maps that issuer string to the matching configured provider.
3. Signature validation runs using only the matched provider's key. Unknown issuers fail with `401`.

**Provider types:**
- **Static public key** (`public-key`): Base64-encoded RSA public key (PEM headers optional). Used for internal/self-hosted providers. No network calls needed at request time.
- **JWKS-backed** (`jwk-set-uri`): Fetches keys from a JWKS endpoint, caches up to 10 keys for 24 hours, rate-limited to 10 fetches/minute. Used for providers that rotate keys (Google, Auth0, Keycloak).

If `app.auth.providers` is empty (default), authentication is skipped entirely with a `WARN` log message. All downstream filters operate with a null/empty security context.

### Extracted Claims

After successful validation, the `GatewaySecurityContext` is populated with:

| JWT claim | GatewaySecurityContext field | Used for |
|:---|:---|:---|
| `sub` | `authSubject` | `_createdBy`, `_lastUpdatedBy`, `_ownerUsers` injection; rate limit keys |
| `azp` | `authParty` | Request ID / tracing header (`X-Request-Id`) |
| `roles` | `roles` | OPA RBAC decisions, OAS generation |
| `groups` | `groups` | Group ownership checks, visibility scoping |
| *(raw token)* | `encodedJwt` | Forwarded as-is to OPA for full claims inspection |

### JWT Claim Normalization

Keycloak places group membership in JWTs with a leading slash: `"/group-a"`. The OPA policies (in the entity-persistence-gateway-policies repo) strip the leading `/` when comparing group names against `_ownerGroups`. This means:
- A JWT containing `"groups": ["/premium-users"]`
- Will match a record whose `_ownerGroups` contains `"premium-users"` (no slash)

This normalization is done inside OPA policy rules, not at the gateway level. Consumers writing OPA policies must account for this convention.

### Keycloak Configuration

Roles must appear as a flat string array at the root of the JWT payload (not nested in `realm_access`):
```json
{
  "sub": "user-uuid",
  "iss": "tarcinapp-idm",
  "azp": "my-frontend-app",
  "roles": ["tarcinapp.member", "tarcinapp.entities.create.editor"],
  "groups": ["/premium-users"],
  "email_verified": true
}
```

In Keycloak, configure a **token mapper** of type "User Attribute" or "Hardcoded Claim" to place roles at the root level as `roles`. Without this mapper, roles appear in `realm_access.roles` and are invisible to the gateway.

### Role Naming Convention

Roles are namespaced by `app.shortcode`:

| Role | Typical Privileges |
|:---|:---|
| `{shortcode}.admin` | Full access; can set managed fields, bypass restrictions |
| `{shortcode}.editor` | Can create and update records |
| `{shortcode}.member` | Can read public/active records and own records |
| `{shortcode}.visitor` | Read-only access to public + active records |

The shortcode prefix allows a single identity provider to govern multiple independent Tarcinapp instances simultaneously.

---

## OPA Authorization: The Two-Pass Check

### Pass 1: Operation Authorization

**OPA path:** `POST /v1/data/policies/auth/routes/{resource}/{operation}/policy`

The gateway sends a `PolicyData` JSON input to OPA and waits for `allow: true` or `allow: false`.

- `allow=true`: request proceeds down the filter chain
- `allow=false`: `403 Forbidden` is returned immediately; EPS is never called
- OPA unreachable / error: `500 Internal Server Error` (fail-closed)

**OPA input structure:**
```json
{
  "token": {
    "payload": { "sub": "...", "roles": [...], "groups": [...], "email_verified": true }
  },
  "request": {
    "method": "PATCH",
    "path": "/api/v1/entities/abc123",
    "routeId": "updateEntityById",
    "body": { "_name": "New name" },
    "queryParams": {}
  },
  "app": { "shortcode": "tarcinapp" },
  "originalRecord": {
    "_id": "abc123",
    "_ownerUsers": ["user-uuid"],
    "_ownerGroups": [],
    "_visibility": "private",
    "_validFromDateTime": "2024-01-01T00:00:00Z",
    "_validUntilDateTime": null
  }
}
```

**How `originalRecord` is fetched:**
For single-record operations (`findById`, `updateById`, `replaceById`, `deleteById`, etc.), the gateway calls EPS directly via an **unauthenticated backend call** — `GET /entities/{id}` — before invoking OPA. This call bypasses all visibility filtering, so OPA receives the raw, complete record regardless of whether the caller would normally be allowed to see it. This is intentional: OPA needs the full record to make a correct ownership/visibility decision.

**When the original record is not found:**
If EPS returns `404` for the pre-fetch call, the gateway returns `404 Not Found` to the caller immediately — it does **not** return `403`. This prevents record-existence enumeration: a caller cannot distinguish "record exists but is forbidden" from "record does not exist."

**`operation` normalization for field policy:**
- `GET` / `DELETE` → `find`
- `POST` → `find` (used for response field visibility after creation)
- `PATCH` / `PUT` → `update`

### Pass 2: Field Authorization

**OPA paths:**
- Per-resource policy: `POST /v1/data/policies/fields/{resource}/policy`
- Gateway-level aggregator (what the gateway actually calls): `POST /v1/data/policies/gateway/forbidden_fields/policy`

The gateway calls the **gateway-level aggregator** (`/v1/data/policies/gateway/forbidden_fields/policy`), which internally delegates to the per-resource policies and merges results. The response contains:

```json
{
  "result": {
    "which_fields_forbidden_for_finding": ["_createdBy", "_lastUpdatedBy"],
    "which_fields_forbidden_for_create": ["_ownerUsers", "_createdDateTime"],
    "which_fields_forbidden_for_update": ["_ownerUsers", "_createdDateTime", "_createdBy"]
  }
}
```

These arrays are cached in the gateway's exchange context and consumed by downstream filters:

1. **`PreventQueryByForbiddenFields`** (pre-request): strips forbidden field names from `filter[fields]` query parameters — prevents even querying by forbidden fields.
2. **Response `FieldFilter`** (post-response): physically removes forbidden field values from the JSON response body.
3. **`AddForbiddenFieldsFromOriginalToPayloadInReplace`** (PUT flows): re-injects the original values of forbidden fields into the replacement payload — prevents callers who cannot see a field from accidentally nulling it out on full replace.
4. **On POST/PATCH with forbidden field in body**: request is rejected with `403 Forbidden`.

**Authorization caching:**
Policy responses are cached in Redis only for read-only HTTP methods (`GET`, `HEAD`, `OPTIONS`). Write methods (`POST`, `PUT`, `PATCH`, `DELETE`) are never cached. Cache key: `auth:policy:{policyName}:{sha256(jwt)}`. TTL is derived from JWT `exp` so cached decisions never outlive token validity.

---

## Role-Based Access: Decision Table

### Operation Defaults (application-level roles)

| Operation | Admin | Editor | Member | Visitor |
|:---|:---|:---|:---|:---|
| `GET /entities` | ✅ | ✅ | ✅ (own + visible) | ✅ (public + active only) |
| `GET /entities/{id}` | ✅ | ✅ | ✅ (if can view) | ✅ (public + active only) |
| `POST /entities` | ✅ | ✅ | ✅ | ❌ |
| `PATCH /entities/{id}` | ✅ | ✅ | ✅ (own only) | ❌ |
| `PUT /entities/{id}` | ✅ | ✅ | ✅ (own only) | ❌ |
| `DELETE /entities/{id}` | ✅ | ✅ | ✅ (own only) | ❌ |
| `PATCH /entities` (update-all) | ✅ | ✅ | ❌ | ❌ |

> Exact rules are in OPA policies. This table shows common defaults — custom field-level roles can expand or restrict access per deployment.

### Field-Level Defaults by Role

| Field | Admin can write | Editor can write | Member can write | Visitor can write |
|:---|:---|:---|:---|:---|
| `_name` | ✅ | ✅ | ✅ | ❌ |
| `_visibility` | ✅ | ✅ | ✅ | ❌ |
| `_validFromDateTime` | ✅ | ✅ | ❌ | ❌ |
| `_validUntilDateTime` | ✅ | ✅ | ❌ | ❌ |
| `_ownerUsers` | ✅ | ❌ | ❌ | ❌ |
| `_createdBy` | ✅ | ❌ | ❌ | ❌ |
| `_createdDateTime` | ✅ | ❌ | ❌ | ❌ |
| `_lastUpdatedBy` | ✅ | ❌ | ❌ | ❌ |
| Custom fields | ✅ | ✅ | ✅ | ❌ |

---

## Sets Injection: Visibility Scoping at the Query Level

### Purpose

For collection endpoints (`findAll`, `count`), the Gateway automatically injects `sets[]` filter parameters into the query **before** it is forwarded to EPS. This ensures EPS never receives a query that could return records the caller is not authorized to see. Filtering is enforced at the query construction level — not as a post-response filter — so unauthorized records are never fetched from the database at all.

This is handled by the `AddSetsToEntityListOrReactionViaRecordQuery` filter family (with variants for relations, reactions, and through-records).

### Injection Rules by Role

| Role | Sets injected | Effective scope |
|:---|:---|:---|
| `admin` | None | All records regardless of visibility, activeness, or ownership |
| `editor` | None | All records regardless of visibility, activeness, or ownership |
| `member` | `sets[owners][userIds]={sub}` **OR** `(sets[actives]=true AND sets[publics]=true)` | Records the member owns, OR records that are both public and active |
| `visitor` | `sets[actives]=true AND sets[publics]=true` | Only records that are both public and active |

The `{sub}` in the member rule comes from the `authSubject` field of the `GatewaySecurityContext`, which is populated from the JWT `sub` claim during authentication.

### Filter Variants

| Filter | Applies to |
|:---|:---|
| `AddSetsToEntityListOrReactionViaRecordQuery` | Entity queries and list queries |
| `AddSetsToRelationQuery` | Relation (ListEntityRelation) queries |
| `AddSetsToReactionsQuery` | Entity and list reaction queries |
| `AddSetsToThroughRecordQuery` | Traversal (through-record) queries |

All `AddSets*` filters require `AuthenticateRequest` to have run first (they read from `GatewaySecurityContext`).

### Position in Filter Chain

Sets injection runs **after** `PreventQueryByForbiddenFields` (which strips forbidden field names from query parameters) and **before** `InjectTypeHintsToQuery`. The Authorization header is stripped before the request is forwarded to EPS.

---

## Visibility Enforcement: How It Works

### The Gateway's Role in Queries

For collection endpoints, sets injection (described above) scopes the query. The result:
- A `member` querying `/entities` will only receive records they own OR records that are public and active — EPS never evaluates unauthorized records.
- An `admin` or `editor` receives unscoped results.

### The Gateway's Role in Single-Record Access

For `GET /entities/{id}`:
1. The gateway calls EPS via an unauthenticated backend call to fetch the raw record (see [Pass 1: Operation Authorization](#pass-1-operation-authorization)).
2. The full record is passed to OPA.
3. OPA evaluates the caller's role, ownership, visibility, and activeness.
4. If `allow=false`, Gateway returns `404 Not Found` — not `403` — to prevent confirming that a record exists.

---

## Ownership and Visibility Interaction Matrix

| Visibility | Activeness | Direct owner | Group owner | Viewer | Public |
|:---|:---|:---|:---|:---|:---|
| `private` + `pending` | ❌ | ✅ | ❌ | ❌ | ❌ |
| `private` + `active` | ❌ | ✅ | ❌ | ✅ | ❌ |
| `private` + `expired` | ❌ | Admin/Editor only | ❌ | ❌ | ❌ |
| `protected` + `pending` | ❌ | ✅ | ❌ | ❌ | ❌ |
| `protected` + `active` | ❌ | ✅ | ✅ | ✅ | ❌ |
| `public` + `pending` | ❌ | ✅ | ❌ | ❌ | ❌ |
| `public` + `active` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `public` + `expired` | ❌ | Admin/Editor only | ❌ | ❌ | ❌ |

> "❌" in the visibility column means non-owners of that visibility tier; "✅" means they can access.

---

## Relation Authorization

Relations (ListEntityRelation) have no `_ownerUsers` of their own. Their authorization is derived:

| Operation | Rule |
|:---|:---|
| Create | Must own the list (`_fromMetadata._ownerUsers` contains `sub`) AND be able to view the entity (`_toMetadata` passes visibility check) |
| View | Must be able to view both the list and the entity |
| Modify | Must own the list |
| Delete | Must own the list |

The gateway enriches relation requests with `_fromMetadata` and `_toMetadata` before calling OPA.

---

## Through (Traversal) Authorization

Traversal endpoints use AND logic — both policies must pass:

| Endpoint | Policy 1 | Policy 2 |
|:---|:---|:---|
| `POST /lists/{id}/entities` | Can view the list | Can create entities |
| `GET /entities/{id}/lists` | Can view the entity | Can find lists |
| `POST /entities/{id}/children` | Can view the parent entity | Can create entities |
| `GET /entities/{id}/reactions` | Can view the entity | Can find reactions |

---

## Distributed Locking for Write Safety

For write operations, the gateway acquires a **Redis-based distributed lock** (via Redisson) before calling EPS. This prevents duplicate creation and lost updates in horizontally scaled deployments.

### Lock Filters

| Filter | Applied to | Failure response |
|:---|:---|:---|
| `AcquireLockForCreation` | `POST` (create) routes | `429 Too Many Requests` |
| `AcquireLockForUpdate` | `PATCH` / `PUT` by-ID routes | `423 Locked` |

Lock acquisition always runs **after** `AuthorizeRequest` — unauthorized requests do not consume lock budget.

### Lock Key Derivation

All keys are namespaced by `app.shortcode` to isolate environments sharing the same Redis instance.

**Creation locks:**
- If client sends `X-Idempotency-Key` header: `{appShortcode}:lock:creation:header:{idempotencyKey}`
- Otherwise, SHA-256 hash of the request body: `{appShortcode}:lock:creation:hash:{sha256(payload)}`

This coalesces duplicate create attempts even when the client does not provide an explicit idempotency key.

**Update locks:**
- `{appShortcode}:lock-on-record-update:{recordId}`

Per-record serialization ensures concurrent PATCHes to different records do not block each other.

### Lock Configuration

Configured in `application-locks.yml` and bound per-route in `application-routes.yml`:

```yaml
app:
  locks:
    default:
      waitTime: 3s      # How long to wait to acquire before failing
      leaseTime: 30s    # Auto-expiry safety window
    entities:
      create:
        waitTime: ${app.locks.default.waitTime}
        leaseTime: ${app.locks.default.leaseTime}
      update:
        waitTime: ${app.locks.default.waitTime}
        leaseTime: ${app.locks.default.leaseTime}
```

Equivalent blocks exist for `lists`, `relations`, and `reactions`. Per-record-type overrides allow tuning high-contention routes independently.

**Key timing notes:**
- Default `waitTime` is **3 seconds**. If the lock cannot be acquired within this window, the gateway returns `429` (create) or `423` (update) immediately.
- `leaseTime` (default **30 seconds**) is the safety auto-expiry. It should be set above normal request latency to avoid premature lock release mid-operation.

### Lock Lifecycle

Both filters use Redisson `RLockReactive` with a per-request virtual thread ID for both `tryLock` and `unlock` calls. Lock release runs in `doFinally`, ensuring unlock on success, error, and cancellation paths.

---

## OPA Decision Logging

When OPA is started with `--set decision_logs.console=true`, every authorization decision is logged to stdout with the full input, the result, and a timestamp. Example:

```sh
opa run --server \
  --set decision_logs.console=true \
  /policies
```

This is useful for debugging authorization failures in development. Each log entry contains:
- The full OPA input (JWT payload, request, originalRecord, appShortcode)
- The decision result (`allow: true/false`, or field arrays)
- Timing information

> Do **not** enable console decision logging in production — JWT payloads and record data will appear in plaintext in the log stream.

---

## Security Checklist for Deployment

Before going to production, verify all of the following:

| # | Check | Why |
|:---|:---|:---|
| 1 | **HTTPS on ingress** — all external traffic uses TLS | Prevents JWT interception in transit |
| 2 | **Redis password set** — `requirepass` configured on Redis | Prevents unauthorized lock manipulation and cache poisoning |
| 3 | **OPA not exposed publicly** — OPA port only reachable from the gateway network | Prevents external callers from querying policies directly |
| 4 | **EPS not exposed publicly** — EPS port only reachable from the gateway network | EPS performs no access control; direct access bypasses all authorization |
| 5 | **JWT public key correctly configured** — `app.auth.providers[n].public-key` matches the key used by your IdM to sign tokens | Incorrect key causes all valid tokens to fail with `401` |
| 6 | **Keycloak token mapper configured** — flat `roles` array at JWT root (not nested in `realm_access`) | Without this, OPA sees empty roles and denies everything |
| 7 | **`clock-skew-seconds` ≤ 60** — do not set to large values to compensate for misconfigured server clocks | Overly large skew extends the validity window of expired tokens |
| 8 | **OPA decision logging disabled** — `decision_logs.console` is `false` in production | JWT payloads and record data would appear in plaintext logs |
| 9 | **`app.auth.providers` not empty** — at least one provider configured | An empty list disables authentication entirely and passes all requests through |
| 10 | **`app.shortcode` consistent** — same shortcode used in gateway config and Keycloak role names | Mismatch causes all role checks to fail silently (empty role match) |

---

## Related Documents
- `12_COMPONENT_gateway-policies.md` — OPA policy structure, role model, forbidden field defaults
- `20_CONCEPT_data-model.md` — Visibility, activeness, ownership field definitions
- `11_COMPONENT_entity-persistence-gateway.md` — Filter chain detail
- `22_CONCEPT_domain-projection.md` — How domain projection interacts with security (per-kind schemas, OAS pruning)
