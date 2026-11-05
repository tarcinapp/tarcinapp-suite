# 12_COMPONENT_gateway-policies.md

## Component Identity

**Repository:** `entity-persistence-gateway-policies`  
**Technology:** Open Policy Agent (OPA) · Rego  
**Layer:** III — Gateway & Security  
**Default port:** `8181` (OPA HTTP server)  
**README:** Does not exist at repo root — this document is the authoritative reference.

---

## What It Is

`entity-persistence-gateway-policies` is the **authorization brain** of the Tarcinapp suite. It is a collection of OPA Rego policies that the Gateway calls on every request to answer two questions:

1. **Operation question:** Is this user allowed to perform this HTTP operation on this resource? → `allow: true/false`
2. **Field question:** Which fields must be hidden from or blocked for this user? → a map of forbidden field lists per resource type and operation

Policies are stateless, pure functions. They receive a structured JSON input (built by the Gateway) and produce a deterministic output. They do not call external services, hold state, or perform I/O.

> **Default Deny:** If no policy rule explicitly produces `allow = true`, OPA returns `allow = false`. The Gateway responds with `403 Forbidden`.

---

## Deployment

The policies are packaged as a Docker image running OPA as an HTTP server. Typical deployment:

- **Sidecar container** alongside the Gateway in the same Kubernetes Pod
- **Standalone service** on the same Docker network

The Gateway calls OPA via `app.opa.host:app.opa.port`. The two key query paths used by the Gateway are:

| Gateway usage | OPA query path |
|:---|:---|
| Operation allow/deny | `data.policies.auth.routes.{resource}.{operation}.policy.allow` |
| Field filtering (all types at once) | `data.policies.gateway.forbidden_fields.policy.result` |

---

## Repository Structure

```
policies/
├── auth/
│   └── routes/                         ← one subfolder per resource type
│       ├── entities/                   ← 11 operations
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
│       ├── lists/                      ← 11 operations (mirror of entities)
│       │   ├── createList/
│       │   ├── findLists/
│       │   ├── findListById/
│       │   ├── updateListById/
│       │   ├── replaceListById/
│       │   ├── deleteListById/
│       │   ├── updateAllLists/
│       │   ├── countLists/
│       │   ├── createListChild/
│       │   ├── findListChildren/
│       │   └── findListParents/
│       ├── relations/                  ← 8 operations (no hierarchy)
│       │   ├── createRelation/
│       │   ├── findRelations/
│       │   ├── findRelationById/
│       │   ├── updateRelationById/
│       │   ├── replaceRelationById/
│       │   ├── deleteRelationById/
│       │   ├── updateAllRelations/
│       │   └── countRelations/
│       ├── entityReactions/            ← 11 operations (including child hierarchy)
│       │   ├── createEntityReaction/
│       │   ├── findEntityReactions/
│       │   ├── findEntityReactionById/
│       │   ├── updateEntityReactionById/
│       │   ├── replaceEntityReactionById/
│       │   ├── deleteEntityReactionById/
│       │   ├── updateAllEntityReactions/
│       │   ├── countEntityReactions/
│       │   ├── createChildEntityReaction/
│       │   ├── findChildrenEntityReactionsByReactionId/
│       │   └── findParentsByEntityReactionId/
│       ├── listReactions/              ← 12 operations (11 + updateListReactions bulk)
│       │   ├── createListReaction/
│       │   ├── findListReactions/
│       │   ├── findListReactionById/
│       │   ├── updateListReactionById/
│       │   ├── replaceListReactionById/
│       │   ├── deleteListReactionById/
│       │   ├── updateAllListReactions/
│       │   ├── updateListReactions/    ← bulk update (no README)
│       │   ├── countListReactions/
│       │   ├── createChildListReaction/
│       │   ├── findChildrenListReactionsByReactionId/
│       │   └── findParentsByListReactionId/
│       ├── entitiesThroughList/        ← 4 traversal operations
│       │   ├── createEntityByListId/
│       │   ├── findEntitiesByListId/
│       │   ├── updateEntitiesByListId/
│       │   └── deleteEntitiesByListId/
│       ├── listsThroughEntity/         ← 1 traversal operation
│       │   └── findListsByEntityId/
│       ├── reactionsThroughEntity/     ← 4 traversal operations
│       │   ├── createReactionByEntityId/
│       │   ├── findReactionsByEntityId/
│       │   ├── updateReactionsByEntityId/
│       │   └── deleteReactionsByEntityId/
│       └── reactionsThroughList/       ← 4 traversal operations
│           ├── createReactionByListId/
│           ├── findReactionsByListId/
│           ├── updateReactionsByListId/
│           └── deleteReactionsByListId/
│
├── fields/                             ← Central field-filtering engine
│   ├── data.rego                       ← Authoritative forbidden field definitions per role
│   ├── mapping.rego                    ← Key → dot-notation path mapping
│   └── policy.rego                     ← Logic: get_forbidden_fields(), get_all_forbidden_fields()
│
├── gateway/                            ← Gateway-facing entry point
│   └── forbidden_fields/
│       └── policy.rego                 ← Wraps fields/policy.rego; result keyed by resource type
│
└── util/
    ├── common/
    │   ├── array.rego                  ← concat helper
    │   ├── fields.rego                 ← field utility helpers
    │   ├── originalRecord.rego         ← is_active, is_passive, is_belong_to_user, etc.
    │   ├── roleDispatcher.rego         ← routes get_effective_role() per resource type
    │   ├── test.rego                   ← produce_token() helper for tests
    │   ├── token.rego                  ← decodes input.encodedJwt → token.payload
    │   └── verification.rego           ← is_email_verified check
    ├── entities/
    │   └── roles.rego                  ← is_user_admin/editor/member/visitor for entities
    ├── lists/
    │   └── roles.rego                  ← same for lists
    ├── relations/
    │   └── roles.rego                  ← same for relations
    ├── entityReactions/
    │   └── roles.rego                  ← same for entityReactions
    └── listReactions/
        └── roles.rego                  ← same for listReactions
```

### The `gateway/` folder

`policies/gateway/forbidden_fields/policy.rego` is the **single entry point** the Gateway calls for field-level decisions. It:

1. Reads `input.operation` (one of `"find"`, `"create"`, `"update"`)
2. Validates it is a known operation
3. Delegates to `fields/policy.rego :: get_all_forbidden_fields(op)`
4. Returns a map keyed by resource type, e.g.:

```json
{
  "entities": {
    "default": ["_version", "_idempotencyKey", "_application"],
    "kinds": {}
  },
  "lists": { ... },
  "relations": { ... }
}
```

This single call returns forbidden fields for **all** resource types at once, allowing the Gateway to build a complete filter configuration without multiple OPA round-trips.

---

## Role Model

### Role Name Convention

Roles follow a hierarchical naming pattern with `{shortcode}` as a prefix (matching `app.shortcode` in the gateway config, e.g., `tarcinapp`):

```
{shortcode}[.{resourceScope}[.{kind}][.{operation}]].{level}
```

### Four Base Levels

| Level | Capabilities |
|:---|:---|
| `admin` | Full access; no forbidden fields on any operation; can override managed fields; can access records in any state |
| `editor` | Can create/modify content; cannot set audit fields; no view restrictions |
| `member` | Standard authenticated user; ownership- and visibility-gated; restricted field write access; `email_verified` required for mutations |
| `visitor` | Read-only; most restrictive view (see Visitor Forbidden Fields below) |

Role resolution uses strict descending priority: **Admin > Editor > Member > Visitor**. A user is evaluated at their highest-matching level. `util/common/roleDispatcher.rego` implements this via `get_effective_role(recordType, operation, source_object)`.

### Three-Tier Granularity

| Scope | Example | Applies to |
|:---|:---|:---|
| Application level | `tarcinapp.admin` | All resource types and operations |
| Resource-type level | `tarcinapp.entities.editor` | All entity operations only |
| Operation level | `tarcinapp.entities.create.member` | Entity create operations only |

**Resource type aliases:**
- `records` matches both `entities` and `lists`
- `reactions` matches both `entityReactions` and `listReactions`

These aliases are implemented via regex in `util/entities/roles.rego`:

```rego
resource_scope := "(records|entities)"

pattern := sprintf(`^%s(\.%s%s(\.%s)?)?\.admin$`,
    [input.appShortcode, resource_scope, kind_pattern, operation])
```

So `tarcinapp.records.editor` grants editor rights on both entities and lists simultaneously.

### Field-Level Roles

Field-level roles are **skeleton keys** that remove a specific field from the forbidden list for a specific operation. They do not elevate the operation-level role — a visitor with a field-level role still cannot create entities.

```
{shortcode}.fields.{resourceScope}[.{kind}].{fieldKey}.{permission}
```

Where `{permission}` is one of: `find`, `create`, `update`, `manage` (`manage` covers all three).

**Full scope mapping:**

| Resource type | Valid `{resourceScope}` values |
|:---|:---|
| entities | `records` or `entities` |
| lists | `records` or `lists` |
| relations | `relations` |
| entityReactions | `reactions` or `entityReactions` |
| listReactions | `reactions` or `listReactions` |

**Practical examples:**

| Role | Use case |
|:---|:---|
| `tarcinapp.fields.entities._validFromDateTime.create` | **Scheduled publishing** — allow a trusted member to set `_validFromDateTime` on creation so content goes live at a future time rather than being immediately pending-until-approved |
| `tarcinapp.fields.entities._validFromDateTime.update` | Allow a member to self-approve their own content (set `_validFromDateTime` to now) — requires this role because members cannot normally touch `_validFromDateTime` on update |
| `tarcinapp.fields.entities._createdBy.manage` | **Admin migration** — allow a migration script's service account to set `_createdBy` to the original author when importing content from a legacy system |
| `tarcinapp.fields.entities._ownerUsers.create` | **Group ownership override** — allow a moderator (with member-level role) to assign a record to a specific user ID on creation, bypassing the default rule that blocks members from setting `_ownerUsers` |
| `tarcinapp.fields.entities._slug.update` | Allow a specific team member to rename slugs after creation (normally immutable for members) |
| `tarcinapp.fields.records._ownerGroups.update` | Allow updating `_ownerGroups` on both entities and lists (e.g., for a group-transfer tool) |

**Permission hierarchy for find:** `tarcinapp.fields.entities._validFromDateTime.find` (or `create`, `update`, or `manage`) all unlock the `find` forbidden-field check. The operation pattern for `find` resolves to `(find|create|update|manage)`, so any field-level role unlocks visibility.

---

## Core Authorization Concepts

### Concept 1: Ownership

**Direct ownership** (`_ownerUsers`): JWT `sub` matches an entry in the array. This is the highest-privilege ownership mode and is checked first.

**Group ownership** (`_ownerGroups`): JWT `groups` intersection with the array. Only evaluated when:
- Caller is NOT a direct owner (`_ownerUsers`)
- Resource visibility is NOT `private`

> **Group path format:** Keycloak includes groups with a leading slash (e.g., `"/group-a"`). The policy performs exact string matching. If the record stores `"/group-a"` but the token delivers `"group-a"` (no slash), the match fails silently.

### Concept 2: Visibility

| Value | Who can access |
|:---|:---|
| `private` | Direct owners (`_ownerUsers`), `_viewerUsers`, and admin/editor roles. **Group ownership is disabled for private records.** |
| `protected` | Direct owners, group owners (`_ownerGroups`), `_viewerUsers`, `_viewerGroups`, admin/editor roles |
| `public` | All authenticated users (when record is also active) |

Visitors can only access records that are `public` AND `active`.

### Concept 3: Activeness (Temporal Validity)

Records have three states based on `_validFromDateTime` / `_validUntilDateTime`:

| State | Condition | Access |
|:---|:---|:---|
| `pending` | `_validFromDateTime` is null | Only direct owners, `_viewerUsers`, and admin/editor |
| `active` | `_validFromDateTime` in past AND (`_validUntilDateTime` null OR in future) | Standard access per visibility |
| `passive/expired` | `_validUntilDateTime` is in the past | Admin/editor owners; member owners are **denied** |

> Member owners **cannot access their own expired records**. Only elevated roles (admin, editor) can manage expired content.

**Member self-approval time window:** When a member sets `_validFromDateTime` on an update (to "publish" a pending record), the value must be within the last 300 seconds from now. This prevents backdating. Similarly, when setting `_validUntilDateTime` to inactivate a record, the value must be within 300 seconds in the past.

### Concept 4: The Two-Pass Authorization Check

**Pass 1 — Operation check** (`policies/auth/routes/{resource}/{operation}/policy.rego`):
- Input: JWT claims (sub, roles, groups, email_verified), HTTP method, route ID, request body, original record metadata
- Output: `allow: true` or `allow: false`
- On `false`: Gateway returns `403 Forbidden`

**Pass 2 — Field check** (`policies/gateway/forbidden_fields/policy.rego`):
- Input: `input.operation` (`"find"`, `"create"`, or `"update"`) plus the same JWT claims
- Output: A map by resource type → `{ "default": [...], "kinds": {...} }`
- Gateway uses these lists to: (a) strip query parameters referencing forbidden fields, (b) strip forbidden fields from response JSON, (c) reject request payloads that contain forbidden fields

The field check always applies regardless of what the operation policy decided. An `allow = true` with a payload containing a forbidden field causes the policy to deny the request in the operation check.

---

## Policy Input Structure

The Gateway encodes the JWT and sends this JSON to OPA for every request:

```json
{
  "appShortcode": "tarcinapp",
  "httpMethod": "PATCH",
  "requestPath": "/api/v1/entities/abc123",
  "queryParams": {},
  "encodedJwt": "<base64url-encoded-JWT>",
  "requestPayload": {
    "_name": "Updated Name"
  },
  "originalRecord": {
    "_id": "abc123",
    "_ownerUsers": ["user-uuid"],
    "_ownerGroups": ["/group-a"],
    "_visibility": "private",
    "_validFromDateTime": "2024-01-01T00:00:00Z",
    "_validUntilDateTime": null
  }
}
```

The `encodedJwt` is decoded inside OPA via `io.jwt.decode()` in `util/common/token.rego`. Policies access claims via `token.payload.sub`, `token.payload.roles`, etc.

### Input for the field filter endpoint

When the Gateway calls the field-filter endpoint, it passes:

```json
{
  "operation": "find",
  "encodedJwt": "<base64url-encoded-JWT>",
  "appShortcode": "tarcinapp"
}
```

### Input for relational operations

For `createRelation` (and similar relation-writing operations), the `requestPayload` includes **both** sides of the relation inline, because the Gateway fetches both records before calling OPA:

```json
{
  "requestPayload": {
    "_fromMetadata": {
      "_id": "list-uuid",
      "_ownerUsers": ["user-uuid"],
      "_ownerGroups": ["/group-a"],
      "_visibility": "public",
      "_validFromDateTime": "2024-01-01T00:00:00Z",
      "_validUntilDateTime": null
    },
    "_toMetadata": {
      "_id": "entity-uuid",
      "_ownerUsers": ["other-user-uuid"],
      "_ownerGroups": [],
      "_visibility": "public",
      "_validFromDateTime": "2024-01-01T00:00:00Z",
      "_validUntilDateTime": null,
      "_viewerUsers": [],
      "_viewerGroups": []
    }
  }
}
```

**Why this shape:** Relations have no `_ownerUsers` of their own. Authorization is fully derived from the connected records. The policy checks:
- `_fromMetadata` (the list) → caller must **own** it (direct owner or group owner for non-private lists)
- `_toMetadata` (the entity) → caller must be able to **view** it (same rules as `findEntityById`)
- The list must be **active** (not pending, not expired) to accept new associations

The `_fromMetadata` and `_toMetadata` fields are also **forbidden for update** for all roles (admin and editor included — see `fields/data.rego`). These metadata snapshots are computed by the persistence service and cannot be manually overridden.

### Input for "through" traversal routes

`createEntityByListId` (`POST /lists/{listId}/entities`) combines two independent checks:

- `input.requestPayload` → the entity body to create (same as `createEntity`)
- `input.originalRecord` → the **list** record (same shape as `findListById`)

Both `create_allowed` AND `list_allowed` must be independently true. A user who can create entities but cannot see the target list is denied.

---

## JWT Structure (Keycloak)

Configure Keycloak to include roles and groups in the token at the **root level**:

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

Token parsing (`util/common/token.rego`):

```rego
payload := payload if {
    input.encodedJwt
    [header, payload, signature] := io.jwt.decode(input.encodedJwt)
}
```

OPA decodes the token without verifying the signature. Signature verification is the Gateway's responsibility (via the JWKS endpoint).

---

## The `email_verified` Guard

Several operations require `email_verified: true` in the JWT. This is enforced via `util/common/verification.rego`:

```rego
is_email_verified if {
    token.payload.email_verified == true
}
```

**Which operations require it and for whom:**

| Operation | admin | editor | member |
|:---|:---|:---|:---|
| `createEntity` | ✓ required | ✓ required | ✓ required |
| `updateEntityById` | ✓ required | ✓ required | ✓ required |
| `createRelation` | ✓ required | ✓ required | ✓ required |
| `findEntityById` | ✗ not required | ✗ not required | ✗ not required |
| `findEntities` | ✗ not required | ✗ not required | ✗ not required |

All **write operations** (create, update, replace, delete) enforce `is_email_verified` for all roles including admin. Read operations (find, count) do not.

**To enable this guard for a user:** Configure the Keycloak `Email Verified` attribute and enable the "Email Verified" token mapper in the client scope. Unverified users (newly registered or with social login) will receive `403` on any write until they verify their email.

**Opt-in behaviour:** The guard is already active in every write-policy. There is no configuration flag to disable it — to bypass it for a specific deployment, the policy itself would need to be modified.

---

## Field-Level Defaults Per Role

Field definitions live in `policies/fields/data.rego`. The system uses a three-layer inheritance model:

- **Layer 1 – Global defaults:** apply to ALL resource types
- **Layer 2 – Type-specific deltas:** ONLY differences from global defaults
- **Layer 3 – Kind-specific overrides:** planned; currently empty (`"kinds": {}`)

### Admin

**No forbidden fields** on any operation (find, create, update).

### Editor

| Operation | Forbidden fields |
|:---|:---|
| `find` | `_recordType` (internal discriminator) |
| `create` | `_recordType`, `_createdDateTime`, `_lastUpdatedDateTime`, `_lastUpdatedBy`, `_createdBy`, `_idempotencyKey` |
| `update` | All create fields + `_kind` |

Editors cannot forge audit trail fields. They can read everything but cannot write audit metadata.

### Member

| Operation | Forbidden fields |
|:---|:---|
| `find` | `_recordType`, `_version`, `_idempotencyKey`, `_application` |
| `create` | `_recordType`, `_ownerUsers`, `_createdDateTime`, `_lastUpdatedDateTime`, `_lastUpdatedBy`, `_createdBy`, `_validFromDateTime`, `_validUntilDateTime`, `_application`, `_version`, `_idempotencyKey` |
| `update` | All create fields + `_kind` |

Plus entity/list type-specific additions: `_slug` (create and update).

For **relations**, members additionally cannot update `_entityId`, `_listId`, `_fromMetadata`, `_toMetadata`.  
For **entityReactions**, members cannot update `_entityId`.  
For **listReactions**, members cannot update `_listId`.

### Visitor (Forbidden Fields — Extended)

Visitors are **read-only** and receive a stripped view of records. The forbidden-for-find list exists to prevent information leakage:

| Hidden field category | Fields | Rationale |
|:---|:---|:---|
| Temporal validity | `_validFromDateTime`, `_validUntilDateTime` | Prevents visitors from inferring scheduled publish times or expiry schedules — a content strategy confidentiality concern |
| Visibility/access control | `_visibility`, `_viewerUsers`, `_viewerGroups` | Hides access control lists; a visitor should not be able to discover who else has access to a record or determine whether a record is "protected" vs "public" |
| Audit trail (write side) | `_lastUpdatedBy`, `_lastUpdatedDateTime` | Prevents user enumeration via modification history; also reduces PII exposure since `_lastUpdatedBy` is a user ID |
| Internal system fields | `_version`, `_idempotencyKey`, `_application` | `_version` is a concurrency token; exposing it to visitors would allow cache-busting attacks. `_idempotencyKey` is a secret used to deduplicate requests. `_application` reveals the originating service name |

Visitors can see: `_id`, `_name`, `_kind`, `_slug`, `_createdDateTime`, `_createdBy`, `_ownerUsers`, `_ownerGroups`, and all application-defined custom fields.

---

## Relational Authorization (Full Detail)

### Relations (ListEntityRelation)

Relations have no `_ownerUsers` of their own. Authorization is **derived** from connected records.

| Operation | Requirement |
|:---|:---|
| `createRelation` | Member: must **own** the list (`_fromMetadata`) AND be able to **view** the entity (`_toMetadata`); list must be active |
| `findRelations` / `findRelationById` | Must be able to view both the list and the entity |
| `updateRelationById` / `replaceRelationById` | Must **own** the list |
| `deleteRelationById` | Must **own** the list |

For members, "own the list" means either:
- `token.payload.sub` is in `_fromMetadata._ownerUsers`, OR
- `token.payload.groups` intersects `_fromMetadata._ownerGroups` AND the list is not private

Group ownership of the list is **disabled** if the list is private (same rule as direct records).

"Able to view the entity" follows the same five-path logic as `findEntityById`:
1. Direct owner + active
2. Group owner + active + not private
3. Public + active
4. In `_viewerUsers` + active
5. In `_viewerGroups` + active + not private

### Traversal ("Through") Routes

These routes express operations that cross resource boundaries in a single HTTP call. They apply composite AND logic — both sub-policies must independently allow:

| Route | Checks |
|:---|:---|
| `POST /lists/{listId}/entities` (`createEntityByListId`) | entity create check (payload) AND list viewability check (`originalRecord`) |
| `GET /lists/{listId}/entities` (`findEntitiesByListId`) | entity find check AND list viewability check |
| `PATCH /lists/{listId}/entities` (`updateEntitiesByListId`) | entity update check AND list ownership check |
| `DELETE /lists/{listId}/entities` (`deleteEntitiesByListId`) | entity delete check AND list ownership check |
| `GET /entities/{entityId}/lists` (`findListsByEntityId`) | list find check AND entity viewability check |
| `POST /entities/{entityId}/reactions` (`createReactionByEntityId`) | reaction create check AND entity viewability check |
| `GET /entities/{entityId}/reactions` (`findReactionsByEntityId`) | reaction find check AND entity viewability check |
| `POST /lists/{listId}/reactions` (`createReactionByListId`) | reaction create check AND list viewability check |

---

## How to Add a New Operation-Level Policy

**Step 1 — Create the directory and files:**

```
policies/auth/routes/{resourceType}/{operationName}/
├── policy.rego
├── policy_test.rego
└── README.md
```

**Step 2 — Write the policy Rego. Required structure:**

```rego
package policies.auth.routes.{resourceType}.{operationName}.policy

import data.policies.fields.policy as central_policy
import data.policies.util.common.originalRecord as original_record
import data.policies.util.common.token as token
import data.policies.util.common.verification as verification
import data.policies.util.{resourceType}.roles as role_utils

# 1. Default deny (REQUIRED)
default allow := false

# 2. Dynamic forbidden lists (if this is a write operation)
default forbidden_create_list := []

forbidden_create_list := res if {
    res := central_policy.get_forbidden_fields("{resourceType}", "create", input.requestPayload)
}

# 3. Allow rules (one block per role tier)
allow if {
    role_utils.is_user_admin("create", input.requestPayload)
    verification.is_email_verified
    not payload_contains_any_field(forbidden_create_list)
}

allow if {
    role_utils.is_user_editor("create", input.requestPayload)
    verification.is_email_verified
    not payload_contains_any_field(forbidden_create_list)
}

allow if {
    role_utils.is_user_member("create", input.requestPayload)
    verification.is_email_verified
    not payload_contains_any_field(forbidden_create_list)
    # add ownership / visibility checks as appropriate
}

# 4. Helpers
payload_contains_any_field(fields) if {
    some field
    field = fields[_]
    input.requestPayload[field]
}
```

**Key rules:**
- Package name must match the directory path exactly (dots replace slashes)
- `default allow := false` is mandatory
- `verification.is_email_verified` must be present on all write operations for all roles
- For update operations, use `get_forbidden_fields_for_role(..., effective_role)` to derive both find and update lists from the same resolved role (see `updateEntityById/policy.rego` for the pattern)

**Step 3 — Register with the Gateway:**

There is no global registry file. The Gateway already knows the route-to-policy mapping (configured in the Gateway's `app.routes` config). After deploying the new policy file to OPA, the Gateway can begin querying it. If this is a brand-new route, the Gateway's route configuration must also be updated to include the new `routeId`.

**Step 4 — Write tests (required). See Policy Testing section.**

---

## Policy Testing

### Running Tests

```bash
# Run all tests with verbose output
opa test policies/ -v

# Run tests in a specific file
opa test policies/auth/routes/entities/createEntity/policy_test.rego -v

# Run OPA server locally for manual evaluation
docker run -p 8181:8181 -v $(pwd)/policies:/policies \
  openpolicyagent/opa:latest run --server /policies

# Manually evaluate a specific policy
opa eval -d policies/ -i input.json \
  "data.policies.auth.routes.entities.createEntity.policy.allow"
```

### Test File Structure

All tests live in `policy_test.rego` in the same directory as the policy. They use the **same package** as the policy under test (not a separate test package), which allows direct access to internal rules.

```rego
package policies.auth.routes.entities.createEntity.policy

import data.policies.util.common.test as test

# Each test is a rule prefixed with test_
test_allow_to_global_admin if {
    allow with input as produce_input_doc_by_role("tarcinapp.admin", true, {
        "_name": "Test Entity",
        "_visibility": "public",
        "_createdBy": "some-user",
    })
}

test_not_allow_to_global_editor_by_forbidden_field if {
    not allow with input as produce_input_doc_by_role("tarcinapp.editor", true, {
        "_name": "Test Entity",
        "_visibility": "public",
        "_createdBy": "some-user",  # editor cannot set _createdBy
    })
}

# Helper: builds the input document for a given role
produce_input_doc_by_role(roles, is_email_verified, requestPayload) := test_body if {
    test_body = {
        "appShortcode": "tarcinapp",
        "httpMethod": "POST",
        "requestPath": "/entities",
        "queryParams": {},
        "encodedJwt": test.produce_token({
            "sub": "ebe92b0c-bda2-49d0-99d0-feb538aa7db6",
            "email_verified": is_email_verified,
            "groups": ["group-1", "group-3"],
            "roles": [roles],
        }),
        "requestPayload": requestPayload,
    }
}
```

### The `test.produce_token()` Helper

`util/common/test.rego` provides `produce_token(payload)` which signs a JWT using a hardcoded RSA key pair. This is valid only for tests — OPA's `io.jwt.decode()` does not verify the signature, so the test key is accepted in policy evaluation.

### What to Test

Each `policy_test.rego` should cover:

| Category | Examples |
|:---|:---|
| Positive: allowed roles | `tarcinapp.admin`, `tarcinapp.records.admin`, `tarcinapp.entities.create.admin`, etc. at all three granularity levels |
| Negative: forbidden fields | Editor cannot set `_createdBy`; member cannot set `_ownerUsers` |
| Negative: email verification | Member with `email_verified: false` is denied on write |
| Negative: group validation | Member who sets `_ownerGroups` to a group they don't belong to is denied |
| Negative: wrong scope | `tarcinapp.lists.admin` does not grant entity access |
| Negative: wrong operation | `tarcinapp.entities.find.admin` does not grant entity create access |
| Field-level permissions | Member with `tarcinapp.fields.entities._createdBy.create` can include `_createdBy` in payload |

---

## Common Pitfalls

### 1. Roles must be at JWT root — not in `realm_access`

Keycloak by default places realm roles in `realm_access.roles`. The policies read `token.payload.roles` (a flat array at the token root). If roles are in `realm_access`, **all requests will be denied** with no error message — OPA simply finds no matching roles.

**Fix:** Add a Keycloak token mapper of type "User Realm Role" with:
- Token Claim Name: `roles`
- Claim JSON type: `String`
- Multivalued: ON

### 2. Group paths include a leading slash from Keycloak

Keycloak's group membership claim delivers groups with a leading slash: `"/group-a"`. The policies do exact string matching against `_ownerGroups` and `_viewerGroups`. If you store group names without the slash (e.g., `"group-a"`), the match will fail and group-owned records will not be visible to group members.

**Fix:** Always store group identifiers in `_ownerGroups` with the leading slash as delivered by Keycloak.

### 3. `email_verified` missing from token means all writes fail

If the Keycloak token mapper does not include `email_verified`, the claim is absent from `token.payload`. The condition `token.payload.email_verified == true` evaluates to `false`, and every write operation is denied.

**Fix:** Ensure the Keycloak client includes the `email_verified` claim in the token. This is typically part of the built-in `profile` scope.

### 4. Field-level roles use the internal field key, not the JSON path

The field key in the role (e.g., `_createdBy`) must match the key in `fields/mapping.rego`. If you add a new managed field to the persistence service and want to create a field-level role for it, the key must first be added to `mapping.rego`. Using an unmapped key will silently fail — the role will be parsed but no field will be removed from the forbidden list.

### 5. Member `_ownerGroups` validation requires exact match

When a member submits `_ownerGroups: ["/group-a"]` on creation, OPA checks that every group in the array exists in `token.payload.groups`. If even one group in the payload is not in the token, the entire request is denied. Partial group membership is not allowed.

### 6. Expired records: members cannot update them, even to fix them

Members receive `403` when trying to update any record where `_validUntilDateTime` is in the past. This is intentional — only admins and editors can manage expired content. Members cannot "revive" an expired record.

### 7. The `_fromMetadata` / `_toMetadata` fields in relations are forbidden for update

Even admins cannot update `_fromMetadata` and `_toMetadata` on an existing relation via PATCH. If the relation's connected records change, the relation must be deleted and recreated. This is enforced in `fields/data.rego` under the `relations` type definition.

---

## Development Quick Reference

```bash
# Start OPA server with policies loaded
docker run -p 8181:8181 -v $(pwd)/policies:/policies \
  openpolicyagent/opa:latest run --server /policies

# Run all tests
opa test policies/ -v

# Evaluate a specific policy against a sample input
opa eval -d policies/ -i input.json \
  "data.policies.auth.routes.entities.createEntity.policy.allow"

# Evaluate the field filter endpoint
opa eval -d policies/ -i field_input.json \
  "data.policies.gateway.forbidden_fields.policy.result"
```

A sample `input.json` at repo root is available for development use.

---

## How to Grant a Field-Level Exception

**Scenario:** Allow members to set `_validFromDateTime` when creating entities (for scheduled publishing).

1. Add the role `tarcinapp.fields.entities._validFromDateTime.create` to the user in Keycloak.
2. No code change required. On next request, OPA evaluates the role, finds the match via regex in `fields/policy.rego`, removes `_validFromDateTime` from the forbidden list for that user's create operation.

**Scenario:** Allow a data migration service account to set `_createdBy` on any operation.

1. Add the role `tarcinapp.fields.entities._createdBy.manage` to the service account.
2. The `manage` permission covers `find`, `create`, and `update` — no need for three separate roles.

---

## Related Documents

- `00_SYSTEM_MANIFEST.md §5` — Security constitution and core security axioms
- `11_COMPONENT_entity-persistence-gateway.md` — How the gateway calls OPA
- `21_CONCEPT_security-and-authorization.md` — End-to-end security flow
