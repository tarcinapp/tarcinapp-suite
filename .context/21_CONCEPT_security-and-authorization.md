# 21_CONCEPT_security-and-authorization.md

## Overview

Security in Tarcinapp is a multi-layer, end-to-end chain. No single component owns all of it:

1. **Keycloak** issues JWTs and declares user identity and roles.
2. **Gateway** validates JWTs, rejects unauthenticated requests, and injects caller context.
3. **OPA** decides whether the operation is allowed and which fields must be hidden.
4. **Gateway** enforces OPA's decision: blocks the request or strips fields from the response.
5. **EPS** receives only already-authorized, already-transformed requests. It does not perform any access control.

---

## The Request Security Flow

```
Client (with Bearer JWT)
      │
      ▼
entity-persistence-gateway
      │
      ├─ 1. AuthenticateRequest
      │      Verify JWT signature (RS256 public key)
      │      Validate iss, exp, nbf, clockSkew
      │      Extract sub, roles[], groups[], email_verified
      │      → FAIL: 401 Unauthorized
      │
      ├─ 2. FetchForbiddenFields
      │      Call OPA: POST /v1/data/policies/fields/{resource}/policy
      │      Input: {token, app.shortcode}
      │      Output: which_fields_forbidden_for_finding[]
      │              which_fields_forbidden_for_create[]
      │              which_fields_forbidden_for_update[]
      │
      ├─ 3. AuthorizeRequest (with originalRecord for single-item ops)
      │      Call OPA: POST /v1/data/policies/auth/routes/{resource}/{op}/policy
      │      Input: {token, request, originalRecord, app.shortcode}
      │      Output: allow: true | false
      │      → FAIL: 403 Forbidden
      │
      ├─ 4. PreventQueryByForbiddenFields
      │      Strip forbidden fields from query params
      │
      ├─ [proxy to EPS / Orchestrator]
      │
      └─ 5. FieldFilter
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
- **Signature**: RS256 against `app.auth.rs256PublicKey`
- **`iss`**: must match `app.auth.issuer`
- **`exp`**: must be in the future (with `clockSkewSeconds` tolerance)

### Extracted Claims
The Gateway reads these claims and stores them in the reactive context for downstream filters:

| JWT claim | Where it goes | Used for |
|:---|:---|:---|
| `sub` | `_createdBy`, `_lastUpdatedBy`, `_ownerUsers` injection | Ownership, audit trail |
| `roles` | Passed to OPA as `token.payload.roles` | Operation + field authorization |
| `groups` | Passed to OPA as `token.payload.groups` | Group ownership checks |
| `email_verified` | Passed to OPA | Some operations may require verified email |

### Keycloak Configuration
Roles must appear as a flat string array at the root of the JWT payload (not nested in `realm_access`):
```json
{
  "sub": "user-uuid",
  "roles": ["tarcinapp.member", "tarcinapp.entities.create.editor"],
  "groups": ["/premium-users"],
  "email_verified": true
}
```
In Keycloak, configure a **token mapper** of type "User Attribute" or "Hardcoded Claim" to place roles at the root level as `roles`.

---

## OPA Authorization: The Two-Pass Check

### Pass 1: Operation Authorization
**OPA path:** `policies/auth/routes/{resource}/{operation}/policy.allow`

The gateway sends a JSON input to OPA and waits for `allow: true` or `allow: false`.

On `false`: `403 Forbidden` is returned immediately. EPS is never called.

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

For **single-record operations** (findById, updateById, etc.), the gateway first fetches the record from EPS to populate `originalRecord`. For collection operations (findAll, createEntity), `originalRecord` is absent.

### Pass 2: Field Authorization
**OPA path:** `policies/fields/{resource}/policy.which_fields_forbidden_for_{operation}`

Returns arrays of forbidden field names. The gateway uses them to:
1. **Pre-request**: strip forbidden field names from `filter[fields]` and query parameters (prevents information leakage even at the query level)
2. **Post-response**: physically remove forbidden field values from the JSON response body
3. **On PUT (replace)**: inject original values of forbidden fields from the existing record into the replacement payload (so callers who can't see those fields don't accidentally null them out)
4. **On POST/PATCH**: reject the request if the body contains a forbidden field with code `403`

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

## Visibility Enforcement: How It Works

### The Gateway's Role in Queries
For collection endpoints (findAll, count), the Gateway injects `sets` filters into the backend query **before** it reaches EPS:

- For a `member` querying `/entities`: Gateway adds `sets[owners][userIds]={sub}` OR `sets[actives]=true` AND `sets[publics]=true` — effectively scoping the query to only records the member can see.
- For an `admin`: no set restrictions are injected; they can see everything.

This means EPS never receives a query that could return unauthorized records. The filtering happens at the query level, not as a post-response filter.

### The Gateway's Role in Single-Record Access
For `GET /entities/{id}`:
1. EPS fetches the record and returns it.
2. Gateway checks if the caller can view it (based on `_ownerUsers`, `_visibility`, `_validFromDateTime`, etc. via OPA).
3. If OPA says `allow=false`, Gateway returns `404 Not Found` (not `403 Forbidden` — to prevent confirming a record exists).

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

For PATCH and POST operations, the gateway acquires a **Redis-based distributed lock** before calling EPS. This prevents:
- Duplicate creation when two clients create the same record simultaneously
- Lost updates when two clients update the same record simultaneously

Lock keys are derived from request-specific data (e.g., the `_listId` for relation creation, or the record ID for updates). Locks are released after the backend call completes or times out.

---

## Related Documents
- `12_COMPONENT_gateway-policies.md` — OPA policy structure, role model, forbidden field defaults
- `20_CONCEPT_data-model.md` — Visibility, activeness, ownership field definitions
- `11_COMPONENT_entity-persistence-gateway.md` — Filter chain detail
- `22_CONCEPT_domain-projection.md` — How domain projection interacts with security (per-kind schemas, OAS pruning)
