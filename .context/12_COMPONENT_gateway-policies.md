# 12_COMPONENT_gateway-policies.md

## Component Identity

**Repository:** `entity-persistence-gateway-policies`  
**Technology:** Open Policy Agent (OPA) · Rego  
**Layer:** III — Gateway & Security  
**Default port:** `8181` (OPA HTTP server)  
**Source of truth for its own docs:** [`entity-persistence-gateway-policies/README.md`](../../entity-persistence-gateway-policies/README.md)

---

## What It Is

`entity-persistence-gateway-policies` is the **authorization brain** of the Tarcinapp suite. It is a collection of OPA Rego policies that the Gateway calls on every request to answer two questions:

1. **Operation question:** Is this user allowed to perform this HTTP operation on this resource? → `allow: true/false`
2. **Field question:** Which fields must be hidden from or blocked for this user? → `forbiddenFields: [...]`

Policies are stateless, pure functions. They receive a structured JSON input and produce a deterministic output. They do not call external services or hold state.

> **Default Deny:** If no policy explicitly allows an operation, OPA returns `allow = false`. The Gateway responds with `403 Forbidden`.

---

## Deployment

The policies are packaged as a Docker image running OPA as an HTTP server. It is typically deployed as:
- A **sidecar container** alongside the Gateway in the same Pod (Kubernetes)
- A **standalone service** on the same Docker network

The Gateway calls it via HTTP at `app.opa.host:app.opa.port`.

---

## Repository Structure

```
policies/
├── auth/
│   └── routes/
│       ├── entities/              ← one subfolder per operation
│       │   ├── createEntity/
│       │   │   ├── policy.rego
│       │   │   ├── policy_test.rego
│       │   │   └── README.md
│       │   ├── findEntities/
│       │   ├── findEntityById/
│       │   ├── updateEntityById/
│       │   ├── replaceEntityById/
│       │   ├── deleteEntityById/
│       │   ├── updateAllEntities/
│       │   ├── countEntities/
│       │   ├── createEntityChild/
│       │   ├── findEntityChildren/
│       │   └── findEntityParents/
│       ├── lists/                 ← same structure for lists
│       ├── relations/             ← 8 operations (no hierarchy)
│       ├── entityReactions/       ← 11 operations
│       ├── listReactions/         ← 11 operations + updateListReactions
│       ├── reactionsThroughEntity/ ← 4 traversal operations
│       ├── reactionsThroughList/  ← 4 traversal operations
│       ├── entitiesThroughList/   ← 4 traversal operations
│       └── listsThroughEntity/    ← 1 traversal operation
├── fields/
│   ├── entities/
│   │   ├── forbidden_fields.rego  ← authoritative field lists per role
│   │   └── policy.rego            ← helpers: which_fields_forbidden_for_*
│   ├── lists/
│   ├── relations/
│   ├── entityReactions/
│   └── listReactions/
└── util/
    ├── common/                    ← token parsing, time helpers, array ops
    ├── entities/                  ← entity-specific role matchers
    ├── lists/
    ├── relations/
    ├── entityReactions/
    └── listReactions/
```

---

## Role Model

### Role Name Convention

Roles follow a hierarchical naming pattern with `{shortcode}` as a prefix (matching `app.shortcode` in the gateway config, e.g., `tarcinapp`):

```
{shortcode}.{level}
```

### Four Base Roles

| Role | Level | Capabilities |
|:---|:---|:---|
| `tarcinapp.admin` | Admin | Full access; no forbidden fields; can override managed fields; can access all records in any state |
| `tarcinapp.editor` | Editor | Can create/modify content; cannot tamper with audit fields; no view restrictions |
| `tarcinapp.member` | Member | Standard user; can only access records they own, can view, or that are public+active; restricted field write access |
| `tarcinapp.visitor` | Visitor | Read-only; most restrictive view (hides audit metadata, validity, visibility fields) |

### Three-Tier Granularity

Roles can be scoped at three levels:

| Scope | Example | Applies to |
|:---|:---|:---|
| Application level | `tarcinapp.admin` | All resource types |
| Resource-type level | `tarcinapp.entities.editor` | Only entity operations |
| Operation level | `tarcinapp.entities.create.member` | Only entity create operations |

**Resource type aliases:** `records` = entities + lists; `reactions` = entityReactions + listReactions.

### Field-Level Roles

Grant exceptions to the default forbidden field lists:

```
{shortcode}.fields.{resourceType}.{fieldName}.{operation}
{shortcode}.fields.{resourceType}.{fieldName}.manage    ← all operations
```

**Examples:**
- `tarcinapp.fields.entities._validFromDateTime.create` — allows member to set `_validFromDateTime` on creation (for scheduled publishing)
- `tarcinapp.fields.entities._createdBy.manage` — allows full control of `_createdBy` (admin migration use case)
- `tarcinapp.records.fields._ownerUsers.update` — allows updating `_ownerUsers` on both entities and lists

---

## Core Authorization Concepts

### Concept 1: Ownership

**Direct ownership** (`_ownerUsers`): JWT `sub` is in the array. Highest privilege. Takes precedence over all other checks.

**Group ownership** (`_ownerGroups`): JWT `groups` intersection with the array. Only evaluated when:
- Caller is NOT a direct owner
- Resource visibility is NOT `private`

### Concept 2: Visibility

| Value | Access |
|:---|:---|
| `private` | Only direct owners, `_viewerUsers`, and admin/editor roles. **Group ownership disabled.** |
| `protected` | Direct owners, group owners, `_viewerUsers`, `_viewerGroups`, appropriate roles |
| `public` | All authenticated users (when record is active) |

### Concept 3: Activeness (Temporal Validity)

Records have three states based on `_validFromDateTime` / `_validUntilDateTime`:

| State | Condition | Access |
|:---|:---|:---|
| `pending` | `_validFromDateTime` is null or in the future | Only direct owners and admin/editor |
| `active` | `_validFromDateTime` in past AND (`_validUntilDateTime` null OR in future) | Standard access per visibility |
| `expired` | `_validUntilDateTime` in the past | Admin/editor owners; member owners are **denied** |

> Member owners cannot access their own expired records. Only elevated roles (admin, editor) can manage expired content.

### Concept 4: The Two-Pass Authorization Check

**Pass 1 — Operation check** (`policies/auth/routes/{resource}/{operation}/policy.rego`):
- Input: JWT claims (sub, roles, groups, email_verified), HTTP method, route ID, request body, original record metadata
- Output: `allow: true` or `allow: false`
- On `false`: Gateway returns `403 Forbidden`

**Pass 2 — Field check** (`policies/fields/{resource}/policy.rego`):
- Input: same JWT claims
- Output: `which_fields_forbidden_for_finding: [...]`, `which_fields_forbidden_for_create: [...]`, `which_fields_forbidden_for_update: [...]`
- Gateway uses these lists to: (a) strip query parameters referencing forbidden fields, (b) strip forbidden fields from response JSON, (c) reject payloads that set forbidden fields

---

## Field-Level Defaults Per Role

### Admin
- **No forbidden fields** on any operation (find, create, update)
- Full access to all managed and custom fields

### Editor
- **No view restrictions** (can see all fields)
- **Cannot create or update:** `_createdDateTime`, `_createdBy`, `_lastUpdatedDateTime`, `_lastUpdatedBy`, `_idempotencyKey`

### Member
**Cannot view:**
- `_version`, `_idempotencyKey`, `_application`

**Cannot create:**
- Audit fields (`_createdDateTime`, `_lastUpdatedDateTime`, `_lastUpdatedBy`, `_createdBy`)
- Temporal validity (`_validFromDateTime`, `_validUntilDateTime`)
- Ownership assignment (`_ownerUsers`) — prevents privilege escalation
- Immutable fields (`_slug`, `_kind` where applicable)

**Cannot update:**
- All audit fields
- Temporal validity fields
- Immutable resource identifiers (`_kind`, `_slug`, `_listId`, `_entityId`)

### Visitor
**Cannot view:**
- All temporal validity (`_validFromDateTime`, `_validUntilDateTime`)
- All visibility/access fields (`_visibility`, `_viewerUsers`, `_viewerGroups`)
- All audit metadata (`_lastUpdatedBy`, `_lastUpdatedDateTime`)
- All internal fields (`_version`, `_idempotencyKey`, `_application`)

---

## Relational Authorization

### Relations (ListEntityRelation)
Relations have no `_ownerUsers` of their own. Authorization is **derived** from connected records:

| Operation | Requirement |
|:---|:---|
| Create | Must **own** the list (`_fromMetadata`) AND be able to **view** the entity (`_toMetadata`) |
| View | Must be able to **view** both the list and the entity |
| Modify / Delete | Must **own** the list |

### Traversal ("Through") Routes
Composite AND logic — both policies must independently allow:

- `POST /lists/{listId}/entities` → list viewability check AND entity create check
- `GET /entities/{entityId}/lists` → entity viewability check AND list find check
- `POST /entities/{id}/children` → parent entity viewability check AND child entity create check

---

## Policy Input Structure

The Gateway sends this JSON to OPA for every request:

```json
{
  "token": {
    "payload": {
      "sub": "user-uuid",
      "roles": ["tarcinapp.member"],
      "groups": ["group-a"],
      "email_verified": true
    }
  },
  "request": {
    "method": "PATCH",
    "path": "/api/v1/entities/abc123",
    "routeId": "updateEntityById",
    "body": { "_name": "Updated Name" },
    "queryParams": {}
  },
  "app": {
    "shortcode": "tarcinapp"
  },
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

For relation operations, `_fromMetadata` (list ownership context) and `_toMetadata` (entity visibility context) are added to `originalRecord`.

---

## JWT Structure (Keycloak)

Configure Keycloak to include roles and groups in the token:

```json
{
  "sub": "user-uuid-here",
  "roles": ["tarcinapp.member", "tarcinapp.entities.create.editor"],
  "groups": ["/group-a", "/group-b"],
  "email_verified": true,
  "iss": "http://keycloak:8080/realms/tarcinapp",
  "exp": 1700000000
}
```

Roles are a flat string array on the token root (not nested in `realm_access`). Configure Keycloak's token mapper to place them at the root level as `roles`.

---

## How to Grant a Field-Level Exception

**Scenario:** Allow members to set `_validFromDateTime` when creating entities (for scheduled publishing).

1. Add the role `tarcinapp.fields.entities._validFromDateTime.create` to the user in Keycloak.
2. No code change required. On next request, OPA evaluates the role, finds the exception, and removes `_validFromDateTime` from the forbidden list for that user.

---

## Development

```bash
# Run OPA with policies loaded
docker run -p 8181:8181 -v $(pwd)/policies:/policies \
  openpolicyagent/opa:latest run --server /policies

# Test all policies
opa test policies/ -v

# Evaluate a specific policy
opa eval -d policies/ -i input.json "data.policies.auth.routes.entities.createEntity.policy.allow"
```

See `input.json` at the repo root for a sample policy input to use during development.

---

## Related Documents
- `00_SYSTEM_MANIFEST.md §5` — Security constitution and core security axioms
- `11_COMPONENT_entity-persistence-gateway.md` — How the gateway calls OPA
- `21_CONCEPT_security-and-authorization.md` — End-to-end security flow
