# 25_CONCEPT_concurrency-and-integrity.md

## Overview

Tarcinapp is designed for multi-user, multi-tenant, multi-instance environments. Several of its integrity features — uniqueness constraints, record limits, and idempotency — involve a **read-then-write** pattern that is inherently susceptible to race conditions under concurrent load. This document explains where those races exist, what each layer of the stack does to mitigate them, and what the remaining known limitations are.

---

## The Read-Then-Write Problem (TOCTOU)

Any enforcement pattern of the form:

```
1. Read: count or find existing records matching a condition
2. Check: if violation → reject
3. Write: else → insert
```

...is a **Time-Of-Check / Time-Of-Use (TOCTOU)** race. Two concurrent requests can both execute step 1 at the same moment, both observe a clean state, both pass step 2, and both proceed to step 3 — producing an inconsistency.

MongoDB multi-document transactions with snapshot isolation **do not eliminate this race** for the insert case. Both transactions open at nearly the same time, read the same snapshot (count = 0), and each commits its insert successfully because neither transaction's write is visible to the other's snapshot. The conflict is only observable *after* both commits.

This affects two features in EPS:

| Feature | Race outcome |
|:---|:---|
| Uniqueness constraints | Two concurrent creates with the same unique key both succeed → duplicate records |
| Record limits | C concurrent creates at the boundary all pass the `count < limit` check → up to C − 1 over-limit records |

> **Idempotency note:** `_idempotencyKey` computation has been **removed from the stack** as part of the EPBO initiative. Idempotency is now a **client responsibility** — callers must supply an `X-Idempotency-Key` header. The Gateway's `AcquireLockForCreation` filter uses this header (when present) as the lock key, serialising concurrent requests with the same explicit idempotency key.

---

## Mitigation Layers

The suite applies mitigations at multiple layers. Each layer handles a different scope and granularity.

### Layer 1 — Gateway: `AcquireLockForCreation` (payload-hash lock)

**Component:** `entity-persistence-gateway`  
**Mechanism:** Before forwarding a create request to the backend, the Gateway acquires a Redisson distributed lock on Redis. The lock key is either:
- The `X-Idempotency-Key` request header (if supplied by the client), or
- A SHA-256 hash of the raw request body (fallback)

**What it protects:** Two requests with the **identical payload** (or the same explicit idempotency key) are serialised. The second request either waits for the first to complete or receives 429 Too Many Requests.

**What it does NOT protect:** Two requests with **different payloads that resolve to the same logical unique key** (e.g. `_name: "My Book"` and `_name: "My Book!"` both slugify to `my-book`) have different hash keys and are not serialised. The uniqueness race remains open.

**Reference:** [`AcquireLockForCreation.java`](../../entity-persistence-gateway/src/main/java/com/tarcinapp/entitypersistencegateway/filters/common/request/AcquireLockForCreation.java)

---

### Layer 2 — Gateway: `AcquireLockForUpdate` (record-ID lock)

**Component:** `entity-persistence-gateway`  
**Mechanism:** Before forwarding any PUT or PATCH request, the Gateway acquires a Redisson lock keyed on `{appShortcode}:lock-on-record-update:{recordId}`.

**What it protects:** Two concurrent updates to the **same record** are serialised. Eliminates the lost-update problem and the double-read inefficiency in `replaceById` (which fetches the existing record twice — within the same transaction snapshot, so correctness is preserved, but the lock removes any theoretical staleness concern).

**What it does NOT protect:** Concurrent creates that would violate uniqueness for the target record's key.

**Reference:** [`AcquireLockForUpdate.java`](../../entity-persistence-gateway/src/main/java/com/tarcinapp/entitypersistencegateway/filters/common/request/AcquireLockForUpdate.java)

---

### Layer 3 — EPC: Uniqueness-key and limit-scope locks

**Component:** `entity-persistence-cache`
**Mechanism:** EPC reads the fully resolved uniqueness and record-limit configuration from EPS's `/system-info` endpoint (cached in-process with a 10-second TTL). For each incoming write request, it:

1. Parses the configured uniqueness rule(s) and limit scope(s).
2. Interpolates the incoming record's field values into the rule templates (e.g. `${_kind}` → `book`, `${_ownerUsers}` → `user-123`).
3. Constructs a **lock key from the derived unique dimensions**, not the raw payload hash.
4. Acquires a Redisson lock on that key before forwarding the request to EPS.
5. Releases the lock after EPS responds (via `doFinally` — releases even on error or timeout).

> **EPBO interaction:** Because `entity-persistence-base-orchestrator` (EPBO) sits between the Gateway and EPC in the chain (`EPG → EPBO → EPC → EPS`), **all computed fields are fully resolved before EPC sees the payload**. In particular, `_slug` is always present in payloads arriving at EPC (computed by EPBO from `_name`). EPC's lock key interpolation therefore finds all required field values directly in the payload and never needs to derive computed fields itself. This eliminates the previous design concern where EPC might attempt to build a lock key referencing `${_slug}` on a payload that contained only `_name`.

**Lock key examples:**

```
# Uniqueness rule: where[_kind]=${_kind}&where[_slug]=${_slug}&set[owners][userIds]=${_ownerUsers}
BOOKS:epc:lock:uniqueness:entity:book:the-great-gatsby:user-123

# Limit rule: {"scope":"where[_ownerUsers]=${_ownerUsers}&where[_kind]=book","limit":10}
BOOKS:epc:lock:limit:entity:a3f9c2:user-123
```

**What it protects:** Two requests that would collide on a configured uniqueness rule or a per-user/per-kind limit scope are given the same lock key and serialised. Eliminates the TOCTOU race for the common cases: per-user uniqueness, per-kind uniqueness, per-user limits.

**What it does NOT protect:** See [Remaining Limitations](#remaining-limitations) below.

**Reference:** [`15_COMPONENT_entity-persistence-cache.md`](./15_COMPONENT_entity-persistence-cache.md)

---

### Layer 4 — EPS: Application-level checks (authoritative enforcement)

**Component:** `entity-persistence-service`  
**Mechanism:** EPS always performs its own uniqueness and limit checks regardless of what the layers above do. The check runs inside a MongoDB transaction (snapshot isolation) and returns 409 or 429 if violated.

This layer is the **authoritative enforcement point**. The layers above are guards that reduce the probability of hitting the race; EPS is the layer that definitively rejects violations.

**Reference:** [`record-limit-checker.service.ts`](../../entity-persistence-service/src/services/record-limit-checker.service.ts)

---

### Layer 5 — MongoDB: Unique indexes (defence-in-depth)

For simple scalar uniqueness rules (e.g. `(_kind, _slug)` globally, or `(_listId, _entityId, _kind)` on relations), MongoDB unique indexes provide an **atomic and unconditional final gate**. If all upper layers fail, the index catches the duplicate and returns `E11000 duplicate key error`.

> **Important:** EPS does not create these indexes automatically. They must be created manually or via deployment tooling. See the index recommendations in `10_COMPONENT_entity-persistence-service.md §MongoDB Index Recommendations`.

Currently EPS does not translate `E11000` errors to HTTP 409. This is a known gap — if a duplicate slips through all upper layers, MongoDB will reject it but the client receives an unformatted 500. Adding an `E11000 → 409` error translator in EPS is the recommended hardening step.

---

## Remaining Limitations

### 1. Wide-scope record limits are best-effort

EPC does not acquire a lock for record-limit rules whose scope contains **no interpolatable fields** (e.g. global cap `""`, or static kind cap `where[_kind]=book`). Serialising all creates in the entire collection on a single lock would be unacceptable in a multi-tenant environment.

**Practical impact:** For a global limit of N with C concurrent writers at the boundary, the actual record count may reach N + (C − 1) before the checks converge.

**For deployments that require hard global limits:** A MongoDB counter document with atomic `findOneAndUpdate({scope, count: {$lt: limit}}, {$inc: {count: 1}})` is the correct solution. This is out of scope for the current EPC design.

**Documented behaviour (from EPS docs):** *"Limit counting is not atomic with the create operation (best-effort). For strict quotas in high-concurrency scenarios, consider database-level strategies."*

### 2. EPC is an optional component

EPC must be deployed and inserted between the Gateway/Orchestrator and EPS for the lock-based mitigations to apply. Deployments that route directly to EPS without EPC retain only Layers 1, 2, and 4.

### 3. Direct EPS access bypasses all gateway locks

EPS must never be exposed directly to clients (this is a core architectural constraint; see `21_CONCEPT_security-and-authorization.md`). If EPS is accessed directly — e.g. from an internal migration script or a mis-configured service — no gateway or EPC locks apply and all TOCTOU risks are present.

### 4. Idempotency is client-supplied — not stack-computed

`_idempotencyKey` computation has been **removed from the stack entirely** as part of the EPBO initiative. EPS no longer derives an `_idempotencyKey` field from configured fields. Idempotency is now a **client responsibility**: callers may supply an `X-Idempotency-Key` request header. When present, the Gateway's `AcquireLockForCreation` filter uses this header value as the lock key (instead of a payload hash), serialising requests with the same explicit key.

**What this means in practice:** Two requests that the client considers idempotent (same business operation, same idempotency key) will be serialised at the Gateway — the first succeeds and the second waits. If the client does not supply `X-Idempotency-Key`, the Gateway falls back to a SHA-256 hash of the raw request body; identical bodies are serialised, but logically equivalent bodies with minor differences are not.

---

## Summary: Concurrency Coverage by Feature

| Feature | Layer 1 (GW hash/idem lock) | Layer 2 (GW record lock) | Layer 3 (EPC scope lock) | Layer 4 (EPS check) | Layer 5 (MongoDB index) |
|:---|:---:|:---:|:---:|:---:|:---:|
| Identical-payload duplicate create | ✅ | — | ✅ | ✅ | ✅ (with index) |
| Different-payload same-key duplicate create | ⚠️ partial | — | ✅ (EPC required) | ✅ | ✅ (with index) |
| Concurrent updates to same record | — | ✅ | — | — | — |
| Per-user / per-kind record limit race | — | — | ✅ (EPC required) | ✅ (best-effort) | — |
| Global / wide-scope record limit race | — | — | ❌ by design | ✅ (best-effort) | — |
| Client-supplied idempotency key collision | ✅ (header lock) | — | — | — | — |

Legend: ✅ Covered · ⚠️ Partial · ❌ Not covered by design · — Not applicable

---

## Related Documents

- [`10_COMPONENT_entity-persistence-service.md`](./10_COMPONENT_entity-persistence-service.md) — EPS uniqueness, record limit, and idempotency configuration
- [`11_COMPONENT_entity-persistence-gateway.md`](./11_COMPONENT_entity-persistence-gateway.md) — Gateway lock filters
- [`15_COMPONENT_entity-persistence-cache.md`](./15_COMPONENT_entity-persistence-cache.md) — EPC design and lock key construction
- [`31_OPS_configuration-reference.md`](./31_OPS_configuration-reference.md) — Full env var reference for EPS constraints
