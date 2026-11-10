# 16_COMPONENT_entity-persistence-base-orchestrator.md

## Component Identity

**Repository:** `entity-persistence-base-orchestrator`
**Technology:** Java 21 · Quarkus 3.40.1 · Apache Camel (camel-quarkus) · Jackson
**Layer:** IV — Orchestration
**Default port:** `3002`
**Template basis:** `entity-persistence-universal-orchestrator`
**Chain position:** `EPG :8081 → EPBO :3002 → EPC :3001 → EPS :3000 → MongoDB`

---

## What It Is

`entity-persistence-base-orchestrator` (EPBO) is a **stateless payload normalization layer** that sits between the API Gateway (EPG) and the cache/lock layer (EPC). Its sole purpose is to inspect every mutation request (POST, PUT, PATCH) and inject managed fields that the client did not supply — before the request reaches EPC where those fields must already be present for correct lock key construction.

EPBO has **no Redis dependency, no caching, no distributed locking, and no database calls**. Every field computation is pure in-memory work based on the request payload and the set of environment variables EPBO is started with.

> **What it does NOT do:** EPBO never validates records against business rules, never enforces uniqueness, and never enforces record limits. Those are EPS responsibilities. EPBO only computes and injects fields that the client was permitted to omit, and it does so in a deterministic, stateless way.

---

## Why This Component Exists

### The computed-field lock key gap in EPC

EPC builds Redis lock keys by interpolating field values from the incoming request payload against the uniqueness and record-limit rules fetched from EPS `/system-info`. A uniqueness rule might reference `_slug` — for example, "no two active entities of the same kind may have the same `_slug`". To acquire the correct lock, EPC must see the resolved `_slug` value **before** forwarding to EPS.

EPBO runs field computation before EPC, so EPC always sees a payload with all derived fields already resolved. Without EPBO in the chain, two concurrent POSTs with `_name: "My Book"` and `_name: "My Book!"` would resolve to the same slug but acquire different lock keys, race through EPC, and both pass the uniqueness check at EPS.

### Clean separation of concerns

Each layer in the chain owns a distinct category of responsibility:

| Layer | Responsibility |
|:---|:---|
| EPG | Audit field injection (`_createdBy`, `_lastUpdatedBy`, `_createdDateTime`, `_lastUpdatedDateTime`) |
| EPBO | Default field injection (`_kind`, `_visibility`, `_validFromDateTime`, `_validUntilDateTime`, `_slug`) |
| EPC | Distributed locking; single-record response caching |
| EPS | Schema validation; uniqueness; record limits; `_version` increment; count fields |

---

## Architecture

### Chain diagram

```
 Client
   │
   ▼
┌─────────────────────────────────────────────────┐
│  EPG  :8081                                      │
│  - Auth (EPGP/OPA)                               │
│  - Injects: _createdBy, _lastUpdatedBy,          │
│             _createdDateTime, _lastUpdatedDateTime│
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  EPBO  :3002   (this component)                  │
│  - Injects: _kind, _visibility,                  │
│             _validFromDateTime,                  │
│             _validUntilDateTime (→ null),         │
│             _slug                                │
│  - Stateless; no Redis; no DB                    │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  EPC   :3001                                     │
│  - Distributed locking (uniqueness / limits)     │
│  - Single-record GET caching                     │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  EPS   :3000   (entity-persistence-service)      │
│  - Schema validation                             │
│  - Uniqueness & record limits                    │
│  - _version increment; count fields              │
│  - MongoDB persistence                           │
└─────────────────────────────────────────────────┘
```

> **EPUO note:** `entity-persistence-universal-orchestrator` (EPUO) is **not** part of this runtime chain. It is not started by `dev.sh`.

### Pre/PostProcessor pipeline

EPBO uses the same **RouteBuilder + PreProcessor + PostProcessor** pattern as EPC and EPUO. There is one `RouteBuilder` per EPS endpoint (67 data endpoints + `/openapi.json` pass-through + `/ping` + `/system-info` = 70 routes total).

```
Incoming HTTP request
        │
        ▼
 ┌─────────────────┐
 │  RouteBuilder    │  ← Camel platform-http consumer; same path/method as EPS
 └────────┬────────┘
          │
          ▼
 ┌─────────────────┐
 │  PreProcessor   │  ← For mutation routes: calls FieldNormalizationService
 │                 │    to inject managed fields into the JSON body.
 │                 │    For /system-info: short-circuits; returns EPBO config JSON.
 │                 │    For GET/DELETE/COUNT: no-op pass-through.
 └────────┬────────┘
          │
  [proxy to EPC :3001]
          │
          ▼
 ┌─────────────────┐
 │  PostProcessor  │  ← No-op pass-through (EPBO does nothing post-response).
 └────────┬────────┘
          │
          ▼
 Outgoing HTTP response
```

**Read routes (GET, COUNT, DELETE) have empty PreProcessors** — EPBO does not modify read requests or responses.

---

## Normalization Rules

### Summary table

| Managed field | Operations | Condition | Record types |
|:---|:---|:---|:---|
| `_kind` | CREATE, REPLACE | absent from payload | all 5 |
| `_visibility` | CREATE, REPLACE | absent from payload | entity, list, entityReaction, listReaction |
| `_validFromDateTime` | CREATE, REPLACE | absent AND `AUTO_APPROVE=true` | all 5 |
| `_validUntilDateTime` | CREATE, REPLACE | absent | all 5 (coerced to `null`) |
| `_slug` | CREATE, REPLACE, PATCH | `_name` present AND `_slug` absent | entity, list, entityReaction, listReaction |
| `_createdDateTime` | CREATE | absent (secondary injector) | all 5 |
| `_lastUpdatedDateTime` | CREATE, REPLACE, PATCH | absent (secondary injector) | all 5 |

### Fields EPBO never touches

| Field | Owner | Reason |
|:---|:---|:---|
| `_createdBy` | EPG | Injected by `AddManagedFieldsInCreation` filter before request reaches EPBO |
| `_lastUpdatedBy` | EPG | Injected by EPG filter before request reaches EPBO |
| `_version` | EPS | Requires reading the existing record's version — EPS already fetches this in its update logic |
| `_ownerUsersCount`, `_ownerGroupsCount`, `_viewerUsersCount`, `_viewerGroupsCount`, `_parentsCount` | EPS | Count fields derived from array membership; used internally by EPS set-helper query builder |

### Injection order for CREATE and REPLACE (PUT) — hard constraint

The order is non-negotiable: steps 2 and 3 depend on the `_kind` value resolved in step 1 (per-kind override lookups for `_visibility` and `_validFromDateTime` require the final kind value).

```
Step 1  _kind             → inject default from {TYPE}_DEFAULT_KIND if absent
Step 2  _visibility       → inject default from {TYPE}_DEFAULT_VISIBILITY[_FOR_{KIND_KEY}] if absent
                            (skipped for relation records — no _visibility field)
Step 3  _validFromDateTime → inject now() if absent AND {TYPE}_AUTO_APPROVE[_FOR_{KIND_KEY}]=true
Step 4  _validUntilDateTime → coerce to explicit JSON null if absent
Step 5  _slug             → compute slugify(_name) if _name present and _slug absent
                            (skipped for relation records — no _name field)
Step 6  _createdDateTime  → inject now() if absent (secondary; EPG is primary)
        _lastUpdatedDateTime → inject now() if absent (secondary; EPG is primary)
```

### Injection rules for PATCH

PATCH is a partial update. EPBO must **not** re-inject config-driven defaults (`_kind`, `_visibility`, `_validFromDateTime`) on PATCH because the stored record already carries those values from the original CREATE — re-injecting them would silently overwrite intentional stored values.

Only payload-driven derivations apply on PATCH:

| Rule | Condition |
|:---|:---|
| Inject `_slug = slugify(_name)` | `_name` present in PATCH payload AND `_slug` absent AND record type ≠ relation |
| Inject `_lastUpdatedDateTime = now()` | absent from PATCH payload (secondary injector; EPG is primary) |

All other fields (`_kind`, `_visibility`, `_validFromDateTime`, `_validUntilDateTime`) are **never injected on PATCH**.

### `_slug` computation algorithm

EPBO's `SlugService.slugify()` mirrors `slugify(input, { lower: true, strict: true })` from the npm `slugify` package:

1. Lowercase the entire string
2. NFD Unicode decomposition (separates base characters from combining diacritical marks)
3. Remove combining diacritical marks (Unicode category `Mn`) — this transliterates `é→e`, `ü→u`, `ğ→g`, `ş→s`, `ç→c`, `ö→o`, etc.
4. Strip any character not in `[a-z0-9\s-]`
5. Collapse runs of whitespace and hyphens to a single hyphen
6. Trim leading and trailing hyphens

**Examples:**

| `_name` input | `_slug` output |
|:---|:---|
| `Hello World` | `hello-world` |
| `My Test Book` | `my-test-book` |
| `Türkçe Kitap` | `turkce-kitap` |
| `café au lait` | `cafe-au-lait` |
| `görev tipi` | `gorev-tipi` |
| `e-book` | `e-book` |
| `Star Wars: A New Hope` | `star-wars-a-new-hope` |
| `book-123` | `book-123` |

**Known minor divergence from npm:** npm `slugify` has an internal symbol replacement map that converts `%` → `percent`. EPBO's Java implementation does not replicate this map. This is not a production concern because `%` cannot appear in a valid EPS `_name` value — EPS's kind validation rules prohibit `%` in field values that undergo slugification, and the normal API flow never produces `%` in `_name`.

### `_visibility` valid values

Accepted values: `private` | `protected` | `public`

EPBO injects the configured string verbatim. Validation that the value is one of the three accepted strings is performed by EPS schema validation downstream.

---

## Configuration Reference

EPBO reads all normalization configuration from environment variables. No normalization config is stored in a database or fetched from another service.

### Naming convention (T-05 schema)

```
{TYPE}_{CONCERN}                   # base var
{TYPE}_{CONCERN}_FOR_{KIND_KEY}    # per-kind override
```

**Type tokens:**

| Record type | Token |
|:---|:---|
| entity | `ENTITY` |
| list | `LIST` |
| relation (ListToEntityRelation) | `RELATION` |
| entityReaction | `ENTITY_REACTION` |
| listReaction | `LIST_REACTION` |

**Kind key encoding:** A stored kind value (already in `[a-z0-9-]+` form — EPS enforces this at create time) is encoded as:
```
{KIND_KEY} = kind.toUpperCase().replace('-', '_')
```
Example: kind `e-book` → `E_BOOK`, kind `book` → `BOOK`.

This encoding is injective (one-to-one) because EPS prohibits underscores in kind names — every `_` in a `{KIND_KEY}` always represents a `-` in the original kind, so the reverse mapping `KIND_KEY.toLowerCase().replace('_', '-')` is unambiguous.

### Resolution order

For any `{TYPE}` and `{CONCERN}`:

1. If `{TYPE}_{CONCERN}_FOR_{KIND_KEY}` is set → use its value (per-kind override wins)
2. Else if `{TYPE}_{CONCERN}` is set → use its value (base default)
3. Else → do not inject the field (no default applied)

**Exception — auto-approve:** When `{TYPE}_AUTO_APPROVE` is absent, the effective base default is `false` (not "no injection"). This allows a per-kind `true` override to work correctly even when the base var is not configured.

### `_kind` defaults

EPBO injects `_kind` on CREATE and REPLACE when the payload does not include `_kind`. PATCH never injects `_kind`.

| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `ENTITY_DEFAULT_KIND` | string | *(not set)* | Default `_kind` for entity records when absent from payload. If not set, no default is injected — EPS will reject if its `ENTITY_KINDS` list requires a valid kind. |
| `LIST_DEFAULT_KIND` | string | *(not set)* | Default `_kind` for list records. |
| `RELATION_DEFAULT_KIND` | string | *(not set)* | Default `_kind` for relation records. |
| `ENTITY_REACTION_DEFAULT_KIND` | string | *(not set)* | Default `_kind` for entityReaction records. |
| `LIST_REACTION_DEFAULT_KIND` | string | *(not set)* | Default `_kind` for listReaction records. |

Per-kind overrides are **not applicable** to `_kind` defaults — the `_kind` field is itself the per-kind override key; a per-kind default would be circular.

### `_visibility` defaults

EPBO injects `_visibility` on CREATE and REPLACE when absent from payload. `_visibility` does not apply to relation records (the relation model has no such field). PATCH never injects `_visibility`.

| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `ENTITY_DEFAULT_VISIBILITY` | string | *(not set)* | Default `_visibility` for entity records. Valid values: `private`, `protected`, `public`. |
| `ENTITY_DEFAULT_VISIBILITY_FOR_{KIND_KEY}` | string | *(inherits base)* | Per-kind override. Example: kind `book` → `ENTITY_DEFAULT_VISIBILITY_FOR_BOOK=public` |
| `LIST_DEFAULT_VISIBILITY` | string | *(not set)* | Default `_visibility` for list records. |
| `LIST_DEFAULT_VISIBILITY_FOR_{KIND_KEY}` | string | *(inherits base)* | Per-kind override for list. Example: kind `e-book` → `LIST_DEFAULT_VISIBILITY_FOR_E_BOOK` |
| `ENTITY_REACTION_DEFAULT_VISIBILITY` | string | *(not set)* | Default `_visibility` for entityReaction records. |
| `ENTITY_REACTION_DEFAULT_VISIBILITY_FOR_{KIND_KEY}` | string | *(inherits base)* | Per-kind override for entityReaction. |
| `LIST_REACTION_DEFAULT_VISIBILITY` | string | *(not set)* | Default `_visibility` for listReaction records. |
| `LIST_REACTION_DEFAULT_VISIBILITY_FOR_{KIND_KEY}` | string | *(inherits base)* | Per-kind override for listReaction. |

**Behavior when unset:** `_visibility` is not injected; the payload is forwarded as-is.

### `_validFromDateTime` auto-approve

When `true`, EPBO sets `_validFromDateTime` to the current UTC timestamp (ISO 8601) on CREATE and REPLACE when `_validFromDateTime` is absent from the payload. When `false` or not set, `_validFromDateTime` is left absent — the record will be created without a publish date and will not yet be visible to the `set[actives]` filter. PATCH never injects `_validFromDateTime`.

| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `ENTITY_AUTO_APPROVE` | boolean | `false` | When `true`, sets `_validFromDateTime = now` for entity records when absent. |
| `ENTITY_AUTO_APPROVE_FOR_{KIND_KEY}` | boolean | *(inherits base)* | Per-kind override. Example: kind `book` → `ENTITY_AUTO_APPROVE_FOR_BOOK=true` |
| `LIST_AUTO_APPROVE` | boolean | `false` | Auto-approve for list records. |
| `LIST_AUTO_APPROVE_FOR_{KIND_KEY}` | boolean | *(inherits base)* | Per-kind override for list. |
| `RELATION_AUTO_APPROVE` | boolean | `false` | Auto-approve for relation records. |
| `RELATION_AUTO_APPROVE_FOR_{KIND_KEY}` | boolean | *(inherits base)* | Per-kind override for relation. |
| `ENTITY_REACTION_AUTO_APPROVE` | boolean | `false` | Auto-approve for entityReaction records. |
| `ENTITY_REACTION_AUTO_APPROVE_FOR_{KIND_KEY}` | boolean | *(inherits base)* | Per-kind override for entityReaction. |
| `LIST_REACTION_AUTO_APPROVE` | boolean | `false` | Auto-approve for listReaction records. |
| `LIST_REACTION_AUTO_APPROVE_FOR_{KIND_KEY}` | boolean | *(inherits base)* | Per-kind override for listReaction. |

**Boolean parsing:** `"true"` (case-insensitive) = enabled. Any other value (including absent) = disabled.

### Fields with no configuration

These fields are always computed algorithmically — no env var controls them:

| Managed field | Behavior | Config |
|:---|:---|:---|
| `_validUntilDateTime` | Always coerced to explicit JSON `null` when absent. Applies to all 5 record types on CREATE and REPLACE only. | None |
| `_slug` | Derived via `slugify(_name, {lower:true, strict:true})` when `_name` is present and `_slug` is absent. Applies to entity, list, entityReaction, listReaction only — not to relation records. | None |
| `_createdDateTime` | Set to `now` when absent (secondary injector — EPG is primary). | None |
| `_lastUpdatedDateTime` | Set to `now` when absent (secondary injector — EPG is primary). | None |

### Complete variable listing

```
# _kind defaults
ENTITY_DEFAULT_KIND
ENTITY_REACTION_DEFAULT_KIND
LIST_DEFAULT_KIND
LIST_REACTION_DEFAULT_KIND
RELATION_DEFAULT_KIND

# _visibility defaults (base)
ENTITY_DEFAULT_VISIBILITY
ENTITY_REACTION_DEFAULT_VISIBILITY
LIST_DEFAULT_VISIBILITY
LIST_REACTION_DEFAULT_VISIBILITY

# _visibility defaults (per-kind override)
ENTITY_DEFAULT_VISIBILITY_FOR_{KIND_KEY}
ENTITY_REACTION_DEFAULT_VISIBILITY_FOR_{KIND_KEY}
LIST_DEFAULT_VISIBILITY_FOR_{KIND_KEY}
LIST_REACTION_DEFAULT_VISIBILITY_FOR_{KIND_KEY}

# _validFromDateTime auto-approve (base)
ENTITY_AUTO_APPROVE
ENTITY_REACTION_AUTO_APPROVE
LIST_AUTO_APPROVE
LIST_REACTION_AUTO_APPROVE
RELATION_AUTO_APPROVE

# _validFromDateTime auto-approve (per-kind override)
ENTITY_AUTO_APPROVE_FOR_{KIND_KEY}
ENTITY_REACTION_AUTO_APPROVE_FOR_{KIND_KEY}
LIST_AUTO_APPROVE_FOR_{KIND_KEY}
LIST_REACTION_AUTO_APPROVE_FOR_{KIND_KEY}
RELATION_AUTO_APPROVE_FOR_{KIND_KEY}
```

---

## `/system-info` Endpoint

EPBO short-circuits `GET /system-info` — it does **not** proxy this to EPC. The response reflects all resolved normalization configuration values as seen by this EPBO instance.

**Response shape:**

```json
{
  "normalization": {
    "entity": {
      "defaultKind": "book",
      "defaultVisibility": "public",
      "autoApprove": false,
      "perKindOverrides": {
        "book":   { "autoApprove": true },
        "e-book": { "defaultVisibility": "public", "autoApprove": false }
      }
    },
    "list": {
      "defaultKind": "shelf",
      "defaultVisibility": "private",
      "autoApprove": false
    },
    "relation": {
      "defaultKind": null,
      "autoApprove": false
    },
    "entityReaction": {
      "defaultKind": "review",
      "defaultVisibility": "public",
      "autoApprove": false,
      "perKindOverrides": {
        "review": { "autoApprove": true }
      }
    },
    "listReaction": {
      "defaultKind": null,
      "defaultVisibility": null,
      "autoApprove": false
    }
  }
}
```

Notes:
- `perKindOverrides` keys use the original kind name (e.g. `"e-book"`), not the env var encoding (`E_BOOK`).
- `perKindOverrides` is omitted from the type object when no per-kind overrides are configured.
- `relation` has no `defaultVisibility` key — relation records have no `_visibility` field.

---

## Template Basis: `entity-persistence-universal-orchestrator`

EPBO is built on the same **RouteBuilder + PreProcessor + PostProcessor** scaffold as EPUO and EPC. The key differences from the template:

| Aspect | EPUO (template source) | EPBO (this service) |
|:---|:---|:---|
| `artifactId` | `entity-persistence-universal-orchestrator` | `entity-persistence-base-orchestrator` |
| Java package | `com.tarcinapp.orchestrator` | `com.tarcinapp.epbo` |
| Default port | `8079` | `3002` |
| Backend target | `http://localhost:3001` (EPC) | `http://localhost:3001` (EPC — same) |
| `gateway.base-url` | `http://localhost:8081` | **removed** |
| `EntityPersistenceClient` | Present — callbacks to EPG | **removed** — EPBO is stateless; no callbacks |
| Redis dependency | None | None (same — EPUO has no Redis) |
| Jackson dependency | None | Added (`quarkus-jackson`) for JSON mutation |
| PreProcessor logic | Empty stubs (custom business logic per deployment) | `FieldNormalizationService` wired into all mutation PreProcessors |
| Runtime role | Custom business logic extension point (not in standard chain) | Payload normalization (in standard chain) |

### What EPBO inherits from EPUO unchanged

- The full 67-route Camel topology (one `RouteBuilder` per EPS endpoint)
- `CamelPlatformHttpConfig` — strips `[` and `]` from query-parameter header names that Camel would otherwise leak into response headers (required for EPS filter syntax)
- `BackendStartupCheck` — probes EPC (`/ping` and `/openapi.json`) at startup; aborts with a clear error if EPC is not running
- `TraceLoggingRouteBuilder` — OpenTelemetry span instrumentation on every exchange
- Maven/Quarkus build infrastructure, Maven wrapper, Dockerfile

---

## Local Development

EPBO is started by `dev.sh` as part of the standard dev stack startup sequence.

**Startup sequence:**

```
Redis (local :6379) → OPA (:8181) → EPS (:3000) → EPC (:3001) → EPBO (:3002) → EPG (:8081)
```

EPBO must start **after EPC** (it probes EPC on startup) and **before EPG** (EPG routes to EPBO).

**Manual start:**
```bash
cd entity-persistence-base-orchestrator
./mvnw quarkus:dev
```

Logs are written to `/logs/epbo.log`.

**Partial start/stop subcommands:**
```bash
entity-persistence-gateway/dev.sh start-epbo
entity-persistence-gateway/dev.sh stop-epbo
```

**EPG routing target (application-dev.properties):**
```properties
app.outbound.routing-target.port=3002
```
EPG routes all requests to EPBO (`:3002`).

---

## Known Limitations

1. **Config-defaulted fields are not re-injected on PATCH.** When a client sends a PATCH request, EPBO does not re-apply `_visibility`, `_validFromDateTime`, or `_kind` defaults. The stored values for those fields remain unchanged. This is correct PATCH semantics — a PATCH updates only the fields the caller explicitly provides; it must not silently overwrite stored managed fields with config defaults. This is a design decision, not a deficiency.

2. **`_slug` is not computed for relation (`ListToEntityRelation`) records.** Relation records have no `_name` field in the EPS model, so there is no `_name` value from which to derive a slug. EPBO's `FieldNormalizationService` and `SlugService` skip slug computation when the record type is `RELATION`. This is a design decision: slug computation is only meaningful for records with a name.

---

## Related Documents

- [`tarcinapp-suite/.context/00_SYSTEM_MANIFEST.md`](00_SYSTEM_MANIFEST.md) — System-level architecture including the full chain topology
- [`tarcinapp-suite/.context/20_CONCEPT_data-model.md`](20_CONCEPT_data-model.md) — All five record types and their managed fields
- [`tarcinapp-suite/.context/25_CONCEPT_concurrency-and-integrity.md`](25_CONCEPT_concurrency-and-integrity.md) — How EPBO and EPC together eliminate the computed-field TOCTOU race
- [`tarcinapp-suite/.context/15_COMPONENT_entity-persistence-cache.md`](15_COMPONENT_entity-persistence-cache.md) — EPC: the layer EPBO forwards to
- [`tarcinapp-suite/.context/10_COMPONENT_entity-persistence-service.md`](10_COMPONENT_entity-persistence-service.md) — EPS: the persistence layer
- [`tarcinapp-suite/.context/31_OPS_configuration-reference.md`](31_OPS_configuration-reference.md) — Full env var reference including EPBO section
- [`epbo-initiative/analysis/T-05-config-schema.md`](../../epbo-initiative/analysis/T-05-config-schema.md) — Authoritative config schema design rationale
- [`epbo-initiative/analysis/T-09-implementation.md`](../../epbo-initiative/analysis/T-09-implementation.md) — Normalization implementation details and trade-offs
