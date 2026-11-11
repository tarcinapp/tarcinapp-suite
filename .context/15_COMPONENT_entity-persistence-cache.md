# 15_COMPONENT_entity-persistence-cache.md

## Component Identity

**Repository:** `entity-persistence-cache`
**Technology:** Java 21 · Quarkus 3.x · Apache Camel (camel-quarkus) · Redisson
**Layer:** V — Data, Search & Storage
**Default port:** `3001`
**Template basis:** Cloned and extended from `entity-persistence-universal-orchestrator`
**Chain position:** `EPG :8081 → EPBO :3002 → EPC :3001 → EPS :3000 → MongoDB`

---

## What It Is

`entity-persistence-cache` (EPC) is a **transparent proxy** that sits between the Orchestration Layer and `entity-persistence-service` and serves two distinct purposes:

1. **Write integrity enforcement (primary purpose)** — acquires Redis distributed locks keyed on the interpolated uniqueness/limit scope before forwarding write requests to EPS, serialising concurrent writes that would collide on the same logical key and eliminating the TOCTOU race condition in EPS's uniqueness and per-user/per-kind limit checks.

2. **Single-record response caching** — caches `GET /entities/{id}`, `GET /lists/{id}`, and equivalent by-ID endpoints in Redis with configurable TTLs. Invalidation is exact: a write to a known `_id` evicts exactly that cache key. Collection/query response caching is explicitly out of scope — see [Why Collection Caching Is Not Implemented](#why-collection-caching-is-not-implemented).

> **What it does NOT do:** EPC does not replace the uniqueness and record-limit checks inside EPS. Those remain as the authoritative enforcement point. EPC's lock layer is an additional guard that eliminates the race window *before* the check runs — making EPS's best-effort behaviour effectively deterministic under normal load.

---

## Implementation Phases

EPC is built incrementally in three phases:

| Phase | Scope | Status |
|:---|:---|:---|
| **Phase 1** | Distributed locking (uniqueness + record-limit scope locks) | ✅ Complete |
| **Phase 2** | Single-record (`findById`) GET response caching | ✅ Complete |
| **Phase 3** | Visitor (public + active) collection caching with TTL-only invalidation | Committed — see [Phase 3: Visitor Collection Caching](#phase-3-visitor-collection-caching) |

---

## Why This Component Exists

### The TOCTOU problem in EPS

EPS enforces uniqueness and record limits using a **check-then-act** pattern:

```
count existing records matching the rule   ← read
if count violates limit → reject
else → insert                              ← write
```

Even though EPS wraps this in a MongoDB transaction with snapshot isolation, two concurrent requests opening transactions at the same moment both read the same snapshot (e.g. count = 0), both pass the check, and both insert — producing a duplicate or over-limit record. This is a classic **Time-Of-Check / Time-Of-Use (TOCTOU)** race.

The Gateway's `AcquireLockForCreation` filter partially mitigates this by serialising requests with **identical payloads** (same SHA-256 hash). But two requests with slightly different payloads that resolve to the same unique key (e.g. `_name: "Book"` vs `_name: "Book!"` both slugify to `book`) are given different lock keys and race freely.

EPC closes this gap by locking on the **derived uniqueness key** — the actual field values that the uniqueness rule compares — rather than the raw payload hash.

### Why not a MongoDB unique index?

MongoDB unique indexes are the gold standard for scalar uniqueness, and the recommended indexes in `10_COMPONENT_entity-persistence-service.md` should still be created for defence-in-depth. However, Tarcinapp uniqueness rules are **scope-aware and dynamically configured**:

- Uniqueness can be restricted to a named set (`set[actives]`, `set[owners]`) — not a simple equality condition.
- The uniqueness scope can include array fields like `_ownerUsers` — MongoDB multikey indexes do not support compound uniqueness across array elements in the general case.
- The rules are expressed as filter template strings and can be changed per deployment without schema changes.

A partial unique index covers simple cases; EPC's lock layer covers the full configuration space.

---

## Architecture

EPC is implemented using the same **Camel RouteBuilder + Pre/PostProcessor** pattern as `entity-persistence-universal-orchestrator`. It exposes the same 67-endpoint API surface as EPS, making it a drop-in transparent proxy.

```
Gateway Request
      │
      ▼
┌─────────────────────────────────┐
│  EPC RouteBuilder                │  ← Camel route, same path/method as EPS
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  EPC PreProcessor                │  ← GET /entities/{id}: cache hit → short-circuit
│                                  │  ← POST/PUT/PATCH/DELETE: evict by-ID cache entry
│                                  │  ← POST/PUT/PATCH: acquire Redis lock
│                                  │  ← on lock timeout → 423
└──────────────┬──────────────────┘
               │
       [lock acquired / cache miss]
               │
               ▼
   [proxy to entity-persistence-service]
               │
               ▼
┌─────────────────────────────────┐
│  EPC PostProcessor               │  ← releases lock (via doFinally)
│                                  │  ← GET /entities/{id} cache miss: populate cache
└──────────────┬──────────────────┘
               │
               ▼
Gateway Response
```

---

## Redis Infrastructure

EPC uses Redis for two purposes with **conflicting eviction requirements**: scope locks must never be evicted while held (`noeviction`), while cache entries are safe to evict under memory pressure (`allkeys-lfu`). EPC is designed to handle this with two independent Redis clients, each configurable separately.

### EPC Redis client model

EPC has **two independent Redis clients** — they can point at the same instance or at different instances via env-var configuration alone (no code change):

| Client | Env var | Used by | Purpose |
|:---|:---|:---|:---|
| Quarkus Redis client | `QUARKUS_REDIS_HOSTS` | `FindByIdCacheService` | findById response cache |
| Redisson client | `EPC_REDIS_URL` | `LockService` | Scope locks |

By default both inherit the same value (`epc.redis.url` defaults to `${quarkus.redis.hosts}`), so a single Redis instance is used out of the box — which is correct for development and acceptable for low-load deployments where the instance is sized so memory pressure never occurs while a lock is held (scope locks are held for < 1 second under normal conditions).

### Redis instance topology options

| Topology | When to use | Configuration |
|:---|:---|:---|
| **Single shared `redis-epc`** (default) | Development; low-load deployments where `redis-epc` is sized well above `#active_records × avg_record_bytes × 2` | `QUARKUS_REDIS_HOSTS` and `EPC_REDIS_URL` point at the same instance. Use `allkeys-lfu` policy and size `maxmemory` generously enough that eviction never occurs during a lock hold window. |
| **Separate `redis-epc-locks` + `redis-epc-cache`** | Production under load; any deployment where memory pressure on the cache Redis is possible | `QUARKUS_REDIS_HOSTS=redis://redis-epc-cache:6379` (cache, `allkeys-lfu`); `EPC_REDIS_URL=redis://redis-epc-locks:6379` (locks, `noeviction`). |

### Full instance inventory

| Instance | Consumer | Purpose | Required eviction policy | Persistence |
|:---|:---|:---|:---|:---|
| `redis-gateway` | EPG | EPG distributed locks, rate-limiting counters | `noeviction` | Disabled |
| `redis-epc-locks` | EPC `LockService` (Redisson) | Scope locks | `noeviction` | Disabled |
| `redis-epc-cache` | EPC `FindByIdCacheService` (Quarkus Redis) | findById response cache | `allkeys-lfu` | Disabled |

> **Development shortcut:** `redis-epc-locks` and `redis-epc-cache` are the same instance (`redis-epc` on `:6380`). This is safe in development because the instance is never under memory pressure. In production they must be separated — or `redis-epc` must be given a `maxmemory` large enough that `allkeys-lfu` eviction is never triggered while a scope lock is held.

**Why `noeviction` is required for lock keys:** `allkeys-lfu` evicts any key — including keys with a TTL that has not yet expired — when `maxmemory` is reached. A scope lock evicted mid-hold means a second concurrent writer will fail to see the lock and race past EPC's serialisation. This is a correctness defect, not just a performance issue.

**Why persistence is disabled on all instances:** Lock keys auto-expire via `lease-time`; a lock key surviving a Redis restart would be stale and permanently block the corresponding scope. Cache entries rebuild on first read after a restart — a cold cache is operationally acceptable.

**Sentinel HA — deployment-time config:** Application source files remain configured for single-node Redis. Sentinel/Cluster config is supplied entirely at deployment time via Kubernetes ConfigMap / Secret or `docker-compose` `.env` overrides. No application code change is required. Full documentation in `entity-persistence-gateway/.context/63-FEATURE-REDIS-SENTINEL-CONFIGURATION.md`. Integration tests continue to use single-node Redis.

**`maxmemory` sizing for `redis-epc-cache`:** Estimate as `#active_records × avg_record_bytes × 2`. Set via `--maxmemory` flag at deployment time. See `32_OPS_deployment-kubernetes.md` for Helm command examples.

---

## Configuration Source: EPS `/system-info`

EPC derives its lock key dimensions by reading the uniqueness and record-limit configuration directly from EPS's `/system-info` endpoint. EPS exposes its fully resolved configuration there — no database round-trip, pure in-memory serialisation.

### Fetch strategy: per-call with short TTL in-process cache

EPC fetches `/system-info` on **every request** but caches the result in a **Caffeine in-process cache with a 10-second TTL**:

- **No staleness risk in practice** — configuration changes happen at deployment time (EPS restart), not mid-flight. A 10-second window is operationally negligible.
- **No startup coupling** — EPC does not need a special startup phase or a pub/sub refresh channel. The cache self-heals within 10 seconds of any EPS configuration change.
- **EPS unavailability is bounded** — if EPS is slow or restarting, only the first request in the 10-second window incurs the wait; subsequent requests are served from cache until EPS recovers.
- **No Redis round-trip for the config itself** — the cache is in-process (heap), keeping the config fetch on the critical path negligible (~1-2ms over localhost loopback).

```java
// Pseudocode — actual implementation in EPC repository
LoadingCache<String, SystemInfo> configCache = Caffeine.newBuilder()
    .expireAfterWrite(10, TimeUnit.SECONDS)
    .build(key -> epsClient.getSystemInfo());   // fetched at most once per 10s
```

### Deployment topology

EPC and EPS are deployed in the **same Kubernetes pod** (sidecar pattern), sharing `localhost`. EPBO sits directly in front of EPC in the request chain.

```
Client → Gateway :8081 → EPBO :3002 → EPC :3001 → EPS :3000 → MongoDB
                │                                        │
                └── redis-gateway (locks,                └── redis-epc (scope locks,
                    rate limiting)                           findById cache)
```

> **Payload pre-resolution:** Because EPBO sits between the Gateway and EPC, **all managed fields are fully resolved before EPC sees the payload**. In particular, `_slug` is always present in payloads arriving at EPC (computed by EPBO from `_name`). EPC's `LockKeyBuilder` therefore finds all interpolation values directly in the payload — no derivation needed.

When EPBO is not deployed (e.g. minimal dev topology), the topology shortens to:

```
Client → Gateway :8081 → EPC :3001 → EPS :3000 → MongoDB
```

The Gateway routes to EPC by setting `app.backend.host` and `app.backend.port` to EPC's address. EPBO sets its own `backend.base-url` to EPC's address (`http://localhost:3001`). EPC's `backend.base-url` points to EPS (`http://localhost:3000`). Each service in the chain knows only the next hop.

> **EPC does not call EPBO.** EPC's only external dependency is EPS `/system-info` (for uniqueness/limit config). EPC never needs an `epbo.base-url` property and should not have one.

---

## Lock Key Design

### For uniqueness rules

Given a uniqueness rule:

```
ENTITY_UNIQUENESS="where[_kind]=${_kind}&where[_slug]=${_slug}&set[owners][userIds]=${_ownerUsers}"
```

This rule means: *a record is unique per owner, per kind, per slug*. User 1 and user 2 can each have a `book` with slug `the-great-gatsby`; neither can have two. The `set[owners][userIds]=${_ownerUsers}` part scopes the uniqueness check to the owner dimension — see `10_COMPONENT_entity-persistence-service.md §Uniqueness Constraints` for the full semantics.

EPC parses the rule (cached for 10s from `/system-info`), identifies the interpolatable dimensions (`_kind`, `_slug`, `_ownerUsers`), and extracts those values from the **merged record node** — see [Lock key source for PATCH requests](#lock-key-source-for-patch-requests) below.

**When an interpolated field is an array, EPC acquires one lock per array element.** A single lock key built from only the first element would miss races involving the other owners. For example, if request A has `_ownerUsers: ["user-1", "user-2"]` and request B has `_ownerUsers: ["user-2", "user-3"]`, they share `user-2` as a co-owner and would collide on the `user-2` ownership dimension — but if only `[0]` were used, they would get different lock keys and race freely.

For `_ownerUsers: ["user-1", "user-2"]`, EPC acquires **two locks**:

```
books:epc:lock:uniqueness:entity:book:the-great-gatsby:user-1
books:epc:lock:uniqueness:entity:book:the-great-gatsby:user-2
```

> **`{APP_SHORTCODE}` resolution** — same pattern as the cache key: EPC reads `X-App-Shortcode` from the incoming HTTP request (injected by the gateway, forwarded by the orchestrator). See the Cache Key section below for the full resolution and fallback strategy.

All locks must be acquired before the request proceeds. If any one acquisition times out, the entire operation returns 423 Locked and all already-acquired locks are released.

**The lock keys encode the uniqueness scope exactly.** Two requests that would collide — same kind, same slug, overlapping owner — share at least one lock key and are serialised. Two requests from *completely disjoint owners* for the same slug produce entirely different lock key sets and proceed in parallel — which is correct, because the uniqueness rule permits them to coexist.

| Request | Lock keys acquired | Serialised against request A? |
|:---|:---|:---:|
| A: user-1 creates `book:the-great-gatsby` | `...user-1` | — |
| A again: user-1 creates `book:the-great-gatsby` | `...user-1` | ✅ yes — same key |
| B: user-2 creates `book:the-great-gatsby` | `...user-2` | ✅ yes — user-2 is also in A's `_ownerUsers` |
| C: user-3 creates `book:the-great-gatsby` | `...user-3` | ❌ no — no shared owner with A |

The second request in each pair still reaches EPS's own uniqueness check as the authoritative gate; the locks ensure that requests sharing any owner dimension do not race past that check simultaneously.

> **EPC always acquires a lock for uniqueness rules — no opt-in flag is needed.** Every valid uniqueness rule must contain at least one interpolatable field (e.g. `${_kind}`, `${_slug}`, `${_ownerUsers}`) — a uniqueness rule with only static literal values would mean "only one record with these exact hardcoded field values can ever exist", which has no practical use case. Because at least one interpolated dimension is always present, the lock key is always scoped to specific runtime values and never global. The wide-scope serialisation problem that requires `enforceSerialisation` on record-limit rules simply does not arise for uniqueness.

### For record-limit rules

EPC **never acquires a lock for a record-limit rule unless `enforceSerialisation: true` is explicitly set** on that rule, regardless of whether the scope contains interpolatable `${…}` fields.

**Why the flag is always required:** A limit scope like `where[_kind]=${_kind}&set[actives]` has a `${_kind}` placeholder, but the resulting lock key (`...:book`) is the same for every user creating a book. Acquiring that lock unconditionally serialises all book creates globally — unacceptable in a multi-tenant system. The operator must opt in to any serialisation deliberately.

**`enforceSerialisation` is defined on the EPS `RecordLimit` schema** and preserved through to `/system-info`. EPS itself never acts on it — it is a passthrough field meaningful only to EPC. See `10_COMPONENT_entity-persistence-service.md §Record Limits` for the full schema and examples.

When `enforceSerialisation: true`, EPC builds the lock key from all `${…}` interpolatable dimensions in the scope:

```json
{"scope": "where[_kind]=${_kind}&set[owners][userIds]=${_ownerUsers}", "limit": 10, "enforceSerialisation": true}
```
```
BOOKS:epc:lock:limit:entity:{scopeHash}:book:user-123
```

When the scope has no interpolatable fields, the lock key is derived from the static scope content:

```json
{"scope": "",                  "limit": 10,  "enforceSerialisation": true}
{"scope": "where[_kind]=book", "limit": 500, "enforceSerialisation": true}
```
```
BOOKS:epc:lock:limit:entity:global          (scope: "")
BOOKS:epc:lock:limit:entity:kind:book       (scope: "where[_kind]=book")
```

When `enforceSerialisation` is absent or `false` (the default), no lock is acquired — EPS's own count check is the sole gate (best-effort).

**Important:** `set[actives]`, `set[publics]`, and similar time/visibility predicates in the scope string contribute nothing to the lock key. They are EPS-side counting filters only. The lock key is built solely from `${…}` placeholder values. When these predicates are part of the scope, the lock granularity is determined entirely by the remaining interpolatable dimensions:

```
where[_kind]=${_kind}&set[actives]&set[owners][userIds]=${_ownerUsers}
→ lock key: ...:book:user-123   (per-user, per-kind — correct)

where[_kind]=${_kind}&set[actives]
→ lock key: ...:book            (all users for that kind — intentionally coarse)
```

**Choosing when to set `enforceSerialisation: true`:**

| Scenario | Recommendation |
|:---|:---|
| Hard licence/seat cap (e.g. max 10 total records globally) | `true` — correctness over throughput |
| Hard per-kind cap at low volume (e.g. max 5 featured articles) | `true` — low contention, safe to serialise |
| Per-user/per-kind cap (e.g. max 10 books per user) | `true` with `${_ownerUsers}` in scope — serialises per-user only |
| Soft global rate limit (e.g. max 2 creates/minute) | `false` — occasional overshoot is acceptable |
| High-volume kind cap (e.g. max 500,000 books) | `false` — global serialisation would bottleneck the system |

The practical overshoot when `enforceSerialisation: false` for a limit of N with C concurrent writers is at most C − 1 extra records. For soft quotas this is acceptable.

### Lock key source for PATCH requests

A PATCH payload contains only the fields the caller intends to change — the rest are absent. If the uniqueness rule references fields that are not in the payload (e.g. `_kind` and `_name` when only `foo` is being patched), `LockKeyBuilder` would fall back to `__missing__` placeholders for those dimensions. Using `__missing__` causes over-serialisation — every PATCH on any record of that type is serialised regardless of whether they actually share a uniqueness dimension — inflating unnecessary lock contention.

**The correct source for lock key building on PATCH paths is the post-patch state of the record** — i.e. the current stored record with the PATCH payload fields merged over it. EPC derives this by reading the full-field cached version of the record and merging the PATCH payload in memory.

> **Why there is no stale-snapshot TOCTOU risk here:** A concern might arise that the fetched record is stale — i.e. another concurrent writer modified the same `_id` between EPC's fetch and EPC's lock acquisition, making the derived lock keys incorrect. This race is **structurally closed by the Gateway's `AcquireLockForUpdate` filter**, which acquires a per-record lock keyed on `{appShortcode}:lock-on-record-update:{id}` and holds it across the **entire downstream chain** (EPBO → EPC → EPS). Any second PATCH targeting the same `_id` is blocked at the Gateway until the first has fully committed and the Gateway lock is released. EPC's record fetch therefore always sees the true current state of the record — there is no concurrent writer that could have changed it between fetch and lock acquisition. EPC's scope locks serve a different purpose: they serialise concurrent writes that share a **uniqueness dimension** (e.g. same `_slug` + `_ownerUsers`) even when they target *different* record IDs (e.g. two concurrent POSTs).

#### Why the full-field cache entry is available

When authentication and authorisation are enabled in the Gateway, the Gateway evaluates authorisation on every write by first issuing `GET /entities/{id}` to EPS through EPC. This GET populates EPC's findById cache with the full-field record (`{APP_SHORTCODE}:epc:cache:{recordType}:{id}:`) before the PATCH arrives at EPC's write PreProcessor. The record is therefore virtually always in the cache when the PreProcessor runs under normal auth-enabled topology.

When authentication and authorisation are disabled, the Gateway skips the authorisation GET. The record may still be in the cache from a prior client GET, but a cache miss is structurally more likely. The fallback path (see below) handles this case.

#### Cache entry eligibility: full-field entries only

A cached entry is eligible for lock key building **only if it was stored without any `filter[fields]` restriction**, i.e. the cache key suffix is empty (`{id}:`). Entries stored with a field projection (e.g. `{id}:fieldset=summary` or `{id}:filter%5Bfields%5D%5B_name%5D=true`) may be missing fields that the uniqueness rule references. Treat any entry with a non-empty query-string suffix as a miss for this purpose.

When scanning `{APP_SHORTCODE}:epc:cache:{recordType}:{id}:*` during the PATCH PreProcessor, EPC must specifically target the zero-suffix entry `{id}:`. If that key is absent or holds a 404 response, it is a miss.

#### On cache miss: fall through to EPS

When the full-field cache entry is absent, EPC issues `GET /entities/{id}` directly to EPS over the localhost loopback (the same channel used for `/system-info` calls). This is a blocking call on a Camel worker thread — the same execution model as the existing `configCacheService.getConfig()` call — so no reactive chain changes are required.

The EPS response is handled as follows:

| EPS response | EPC action |
|:---|:---|
| `200 OK` | Use the response body as the current record for merge and lock key building |
| `404 Not Found` | The record does not exist; return 404 to the caller immediately — no lock acquisition needed |
| `5xx` / unreachable | Return `503 Service Unavailable` — EPS is unavailable; the write cannot be safely serialised |

EPC does **not** write this EPS response into the findById cache. The PATCH PreProcessor immediately evicts the cache entry in the next step anyway; caching it here would only be evicted a millisecond later.

**Why falling through to EPS is correct in both scenarios:**

- *Auth enabled (scenario a2 — rare miss):* A miss means either the TTL expired in the sub-second window between the Gateway's authorisation GET and the PATCH arriving, or Redis was temporarily unavailable during the authorisation GET. In both cases the record exists in EPS. Falling through retrieves the current state without any client-visible failure.
- *Auth disabled (scenario b2 — common miss):* No proactive cache warming occurs. A direct EPS fetch is the normal hot path. The record is on localhost; the cost is negligible. Failing the request instead would require the client or Gateway to retry, adding a round-trip with no benefit — the second attempt would also be a cache miss and would have to fall through anyway.

Failing the request on a cache miss is not a viable strategy in either scenario: it makes correctness dependent on Redis availability and TTL timing, neither of which has any bearing on whether the underlying write is valid.

#### The merge

The merge is a **shallow, non-mutating overlay** of the PATCH payload over the fetched/cached record: for each top-level field present in the PATCH payload, the payload value replaces the corresponding field in the record; all other fields are inherited unchanged. This matches EPS's own PATCH semantics. The result is a `JsonNode` used solely for lock key building — it is never written back to cache or forwarded to EPS.

#### Complete PATCH PreProcessor operation order

The required order in the PATCH write PreProcessor is:

```
1. Read full-field cache entry: {APP_SHORTCODE}:epc:cache:{recordType}:{id}:
       hit  → use cached body as current record JsonNode
       miss → GET /entities/{id} from EPS
                 200 → use EPS response body as current record JsonNode
                 404 → return 404 to caller (no further steps)
                 5xx → return 503 to caller (no further steps)

2. Merge: shallow-overlay PATCH payload fields over current record → merged JsonNode

3. Evict cache: DEL {APP_SHORTCODE}:epc:cache:{recordType}:{id}:*

4. Acquire scope locks using merged JsonNode for key interpolation

5. Forward PATCH to EPS
```

Step 3 (evict) must follow step 1 (read): evicting before reading would guarantee a cache miss and force every PATCH into an EPS fetch. Step 3 must precede step 4 (acquire lock) per the pre-existing eviction ordering requirement — reversing them creates a window where a concurrent reader re-populates the cache with stale data between lock acquisition and write completion.

**When EPS rejects the write (409, 422, 429) after step 5:** the cache was evicted in step 3 unnecessarily. The next GET for this record will incur one extra MongoDB round-trip. This is a harmless performance cost, not a correctness issue — it is the same pre-existing behaviour documented in the Invalidation section.

---

## Template Basis: `entity-persistence-universal-orchestrator`

EPC is built by **cloning** `entity-persistence-universal-orchestrator` (Java 21 / Quarkus 3.15.3) and replacing the pre/post-processor stubs with lock acquisition / release logic and findById caching. This choice was deliberate:

| Reason | Detail |
|:---|:---|
| Same API surface | The orchestrator already mirrors all 67 EPS endpoints. EPC inherits this coverage for free. |
| Same proxy mechanics | `bridgeEndpoint=true`, hop-by-hop header stripping, `throwExceptionOnFailure=false` — all already correct in the template. |
| Same CDI + Camel idioms | The processor injection pattern (`@Inject`, `@ApplicationScoped`) maps cleanly to a lock-service CDI bean. |
| Same observability | OpenTelemetry trace propagation, request ID headers, and structured logging are pre-wired. |
| Same configuration model | MicroProfile Config + `application.properties` with env var overrides. |

The EPC-specific additions on top of the orchestrator template are:

**Phase 1 (locking):**
1. A `LockService` CDI bean — wraps Redisson blocking `RLock.tryLock(waitTime, leaseTime, TimeUnit)`, which is safe on Camel worker threads (not event-loop threads); constructs lock keys from config
2. A `ConfigCacheService` CDI bean — Caffeine in-process cache (10 s TTL) wrapping EPS `/system-info` call; provides uniqueness and record-limit config to lock key builders
3. A `LockKeyBuilder` utility — parses uniqueness/limit scope strings, extracts interpolation dimensions, builds one lock key per array-element combination
4. A `PatchMergeHelper` CDI bean — fetches the current stored record (from findById cache or direct EPS GET via `EpsClient.getRecordById`), performs a shallow non-mutating overlay of the PATCH payload, and returns the merged `JsonNode` used for lock key interpolation on PATCH paths
5. `EpsClient` extended with `getRecordById(recordType, id)` — used by `PatchMergeHelper` on cache miss to fetch the current record directly from EPS over localhost loopback
6. Wiring `AbstractWriteLockPreProcessor` to: (a) call `beforeLocks()` for pre-lock housekeeping, (b) read the merged node from the `epc.patch.merged.node` exchange property set by PATCH pre-processors, (c) acquire all lock keys, (d) store lock handles on the exchange for release in the post-processor
7. All five `Update*ByIdPreProcessor` classes wired with `PatchMergeHelper`: fetch → merge → evict cache → stash merged node → (base class) acquire locks

**Phase 2 (findById caching):**
8. A `FindByIdCacheService` CDI bean (Redis-backed by-ID GET response cache; stores response body + selected headers)
9. Wiring each `GET /{recordType}/{id}` PreProcessor to check `findByIdCacheService.get(cacheKey)` and short-circuit on hit; PostProcessor to call `findByIdCacheService.put(cacheKey, body, headers, ttl)`
10. Wiring each write PreProcessor (PUT/PATCH/DELETE on `/{id}`) to call `findByIdCacheService.evict(cacheKey)` before forwarding

All routing, proxy, and pass-through logic is inherited unchanged from the template.

### Count route startup ordering

Camel Quarkus uses Vert.x as the HTTP layer. Vert.x resolves routes by **registration order** — not by path specificity — using a `TreeSet<RouteImpl>` sorted by integer order value. This means `GET /entities/{id}` can intercept `GET /entities/count` if it is registered first.

`@Priority` annotations on `RouteBuilder` CDI beans do **not** affect Vert.x route registration order. Camel's `RegistryRoutesLoaders` collects `RoutesBuilder` beans from the CDI registry as an unordered `Set`; `@Priority` is never read during this step.

The correct fix is Camel's **`startupOrder(int)`** DSL method on the route definition:
- All five count routes (`/entities/count`, `/lists/count`, `/relations/count`, `/entity-reactions/count`, `/list-reactions/count`) declare `.startupOrder(1)` through `.startupOrder(5)`.
- `findById` routes carry no explicit `startupOrder` and receive higher auto-incremented values.
- Because Camel starts routes in ascending `startupOrder` order (`InternalRouteStartupManager` uses a `TreeMap<Integer, RouteStartupOrder>`), count routes' consumers call `VertxPlatformHttpConsumer.doStart()` first, registering their Vert.x routes before any `{id}` path-parameter route.

This fix is applied identically in EPC, EPUO, and EPBO. `@Priority` annotations are removed from all 10 affected route files in each repo (they were misleading dead code).

---

## Single-Record (findById) Response Caching

### Purpose and scope

EPC caches the response body **and selected HTTP response headers** of by-ID GET requests in Redis. This covers:

- `GET /entities/{id}`
- `GET /lists/{id}`
- `GET /relations/{id}`
- `GET /entity-reactions/{id}`
- `GET /list-reactions/{id}`

Collection queries (`GET /entities`, `GET /lists/{id}/entities`, etc.) are explicitly **not cached**. See [Why Collection Caching Is Not Implemented](#why-collection-caching-is-not-implemented).

> **`filter[include]` bypass:** If the incoming request's query string contains `filter[include]` (or its percent-encoded form `filter%5Binclude%5D`), EPC skips caching entirely for that request — both the read check and the write. The `filter[include]` parameter causes EPS to embed nested related records in the response, making the response body dependent on related data that EPC cannot invalidate correctly. All other query string parameters (including `filter[fields]`, `filter[order]`, `filter[limit]`, `fieldset`) are captured in the cache key.

### Cache key

```
{APP_SHORTCODE}:epc:cache:{recordType}:{id}:{sortedQueryString}

e.g.  books:epc:cache:entity:abc-123:                                  (no query params)
      books:epc:cache:entity:abc-123:fieldset=summary                  (fieldset applied)
      books:epc:cache:entity:abc-123:filter%5Bfields%5D%5B_name%5D=true (field projection)
```

The key encodes the record type, the immutable `_id`, and the **sorted, normalised query string**. The query string component is required because `GET /{type}/{id}` callers may request different field projections (`filter[fields]`, `fieldset`) that produce different response shapes — these must be cached separately.

> **Field masking and caller identity:** Field masking is applied by the Gateway on the *response path* (after EPS and EPC return), not by EPS. The EPS response body is therefore caller-agnostic for the same query string — all callers using the same field projection get the same EPS response. No user-identity dimension is needed in the cache key.

**`{APP_SHORTCODE}` resolution in EPC:**

EPC resolves the application shortcode from the `X-App-Shortcode` HTTP header, which the Gateway injects on every proxied request via `spring.cloud.gateway.default-filters: AddRequestHeader=X-App-Shortcode, ${app.shortcode}` (see `entity-persistence-gateway/.context/62-FEATURE-APP-SHORTCODE-PROPAGATION.md`). The header is forwarded by the Orchestrator (if present in the topology) without modification, so EPC always receives the correct value.

This design keeps `app.shortcode` as a single source of truth in the gateway — EPC does not need its own application shortcode configuration. The header approach is also topology-agnostic: whether the call path is `Gateway → EPC → EPS` or `Gateway → Orchestrator → EPC → EPS`, `X-App-Shortcode` is present at EPC's inbound boundary.

EPC accepts `EPC_APP_SHORTCODE` as a **startup-time fallback** for scenarios where EPC is called directly without a gateway (e.g. migration scripts, administrative tools). When both the header and the env var are present, the header takes precedence.

### Cached HTTP status codes

EPC caches responses with the following HTTP status codes:

| Status | Cached | Rationale |
|:---|:---:|:---|
| `200 OK` | ✅ | Normal found response |
| `404 Not Found` | ✅ | Negative cache — prevents repeated MongoDB lookups for non-existent IDs (polling patterns) |
| All other 4xx / 5xx | ❌ | Transient or caller-specific errors; must not be replayed |

**POST evicts cached 404 on create:** When a `POST /{type}` response contains a `_id` field in the response body, EPC issues a wildcard DEL for `{APP_SHORTCODE}:epc:cache:{type}:{newId}:*`. This evicts any previously cached 404 for that ID so the next `GET /{type}/{newId}` fetches the newly created record from EPS.

### Cache key versioning

No version segment is included in the key format. A cache schema change cold-starts the cache by flushing `redis-epc` at deploy time (acceptable — cache rebuilds on first read). FLUSHDB during deployment is simpler than a version-segment bump mechanism.

### What is cached

EPC caches the full response body plus a selected subset of HTTP response headers. Modelled on the gateway's `DynamicLocalCache` implementation:

| Category | Stored | Notes |
|:---|:---:|:---|
| Response body | ✅ | Full JSON body from EPS |
| `Content-Type` | ✅ | Replayed on cache hit |
| `ETag` | ✅ | Computed by EPC (MD5 of response body) on first store; replayed on hit |
| `Cache-Control` | ✅ | Normalised; `max-age` derived from TTL |
| `X-Cache-Status` | ✅ | Set to `HIT` on cache hit, `MISS` on first population |
| `X-Request-Id` | ❌ | Not stored — each response gets the caller's own request ID |
| `Authorization`, `Cookie`, `Set-Cookie` | ❌ | Never stored |
| Hop-by-hop headers | ❌ | Stripped per HTTP spec |

**Conditional request support:** On a cache hit, EPC evaluates `If-None-Match` (against the stored `ETag`) and returns `304 Not Modified` when the validator matches, avoiding body transmission.

### Cache bypass

EPC honours the same bypass semantics as the Gateway's local cache:

| Client request header | EPC behaviour |
|:---|:---|
| `Cache-Control: no-cache` | Skip cache read; fetch from EPS; populate cache with the fresh response |
| `Cache-Control: no-store` | Skip cache read; fetch from EPS; do **not** write to cache |

These headers allow debugging tools and integration tests to bypass the cache without disabling it globally.

### Invalidation

Invalidation is exact and trivial. Cache key construction uses the same `{APP_SHORTCODE}:epc:cache:{recordType}:{id}:{sortedQueryString}` format, but on write operations the eviction uses a **key-scan pattern** `{APP_SHORTCODE}:epc:cache:{recordType}:{id}:*` — this ensures all cached variants (different field projections) of the same record ID are evicted together.

- **PUT /entities/{id}** (replace) → evict all keys matching `books:epc:cache:entity:{id}:*` in the PreProcessor
- **PATCH /entities/{id}** (update) → same
- **DELETE /entities/{id}** → same

On a **POST /entities** (create), no invalidation is needed — the new `_id` has no existing cache entries.

**Bulk write operations (deleteAll / updateAll):**

`DELETE /entities` (deleteAll by filter) and `PATCH /entities` (updateAll by filter) affect an unknown set of records — only a count is returned. The affected `_id`s are unknowable without a pre-fetch round-trip to EPS. EPC does **not** attempt to invalidate findById cache entries for these operations. Cache entries for affected records will be stale until TTL expiry. These are administrative bulk operations where a bounded staleness window is an acceptable trade-off. The TTL backstop is the sole invalidation mechanism for bulk operations. This is a named known limitation.

Invalidation fires in the **PreProcessor** — before the write is forwarded to EPS. If EPS ultimately rejects the write (409, 422, 429), the cache entry was evicted unnecessarily and the next read incurs one extra MongoDB round-trip. This is a harmless performance cost, not a correctness issue.

### Post-eviction stale-read window (known limitation)

Invalidation is pre-emptive (PreProcessor), but a race window exists between eviction and re-population:

```
T1: Writer  — PreProcessor evicts cache key for {id}
T2: Reader  — PreProcessor: cache miss; forwards GET to EPS
T3: Writer  — write reaches EPS and commits
T4: Reader  — PostProcessor: caches the EPS response (which reflects T2's read — pre-T3 state)
T5: Others  — served the T4-cached stale response until TTL
```

This window is structural in any cache-aside system and is not eliminated by pre-emptive eviction. The TTL (configurable, default 60s) is the sole backstop. In practice the window is very narrow (the time between T1 and T3 is the EPS write latency, typically < 50ms over localhost) and the stale response is the previous valid state of the record, not an error.

If specific workflows require **read-your-write consistency** (e.g. the writer's own subsequent GET must see the updated record), the recommended mechanism is a `Cache-Control: no-cache` header on the follow-up GET — this forces EPC to bypass the cache read and re-fetch from EPS, then re-populate with the fresh value.

### Concurrency and thundering herd

**Thundering herd:** When a hot record's TTL expires, concurrent readers all forward simultaneously to EPS. For findById this is low severity — single-record reads are cheap and MongoDB handles parallel by-ID reads efficiently. No request coalescing is implemented in Phase 2. If post-deployment metrics show a problematic burst rate on the same key, add `SETNX`-based coalescing as a follow-on.

**Lock acquisition — blocking `tryLock` on Camel worker threads:** EPC's Camel processors run on Camel worker threads, not on Vert.x event-loop threads. Blocking `tryLock(waitTime, leaseTime, TimeUnit)` is therefore safe here — it does not starve the event loop. `RLockReactive.tryLockAsync` would be required only if lock acquisition were placed directly on a Vert.x event-loop thread, which it is not. The design doc previously noted `RLockReactive.tryLockAsync` as a requirement; that note was incorrect for this execution model and has been removed. If EPC is ever moved to a fully reactive Camel setup (all processors on event-loop threads), replace with `RLockReactive.tryLockAsync` at that point.

**Write operation ordering in PATCH PreProcessor:** The required order for PATCH (update-by-id) is defined in full in [Complete PATCH PreProcessor operation order](#complete-patch-preprocessor-operation-order). In summary:
1. Read full-field cache entry; on miss fall through to EPS
2. Merge PATCH payload over fetched record → merged `JsonNode` (used **only** for lock key interpolation — never written back to cache or forwarded to EPS; the original sparse PATCH body is what EPS receives)
3. Evict findById cache entry (`DEL` wildcard)
4. Acquire scope locks using merged record
5. Forward **original** PATCH body to EPS

For non-PATCH writes (PUT, DELETE by id), steps 1 and 2 are omitted — no merge is needed. The order for those operations is: evict → acquire lock → forward.

Placing eviction before lock acquisition (step 3 before step 4) is mandatory: reversing them creates a window where a concurrent reader re-populates the cache with a stale response between lock acquisition and write completion.

**Why there is no TOCTOU risk in the PATCH record fetch:** The Gateway's `AcquireLockForUpdate` filter holds a per-record lock (`{appShortcode}:lock-on-record-update:{id}`) across the full downstream chain for the duration of the PATCH. A second concurrent PATCH to the same `_id` cannot enter EPC until the first has fully committed. EPC's record fetch (step 1) therefore always reads the true current state — no concurrent writer can have changed it between fetch and lock acquisition. See [Lock key source for PATCH requests](#lock-key-source-for-patch-requests) for the full analysis.

**Redis unavailability:**
- **Locks** — fail fast, return `503 Service Unavailable`. Lock acquisition is required for correctness; degrading silently would allow TOCTOU races.
- **findById cache** — degrade gracefully, pass GET through to EPS without caching. Cache is a performance optimisation, not a correctness requirement.
- A **Resilience4j circuit breaker** wraps all Redis calls to prevent cascading latency under slow-Redis conditions.

### TTL configuration — multi-layer hierarchy

TTL for findById cache entries is resolved through a three-level hierarchy. The first level that has an explicit value wins:

```
1. Kind-level   epc.cache.ttl.{recordType}.kinds.{kind}   (most specific)
2. Type-level   epc.cache.ttl.{recordType}                (e.g. entity, list)
3. Global       epc.cache.default-ttl                     (fallback for all types)
```

Example resolution for a `GET /entities/{id}` where `_kind=book`:
1. Check `epc.cache.ttl.entity.kinds.book` → if set, use it
2. Check `epc.cache.ttl.entity` → if set, use it
3. Fall back to `epc.cache.default-ttl` (default: 60s)

This mirrors the configuration hierarchy in the gateway's `DynamicLocalCache` (`app.local-cache.{recordType}.kinds.{kind}.timeToLive` → `app.local-cache.{recordType}.default.timeToLive` → `app.local-cache.default.timeToLive`).

**Runtime configurability:** TTL values are sourced from MicroProfile Config. When backed by a refreshable config source (e.g. Kubernetes ConfigMap with Quarkus config reload, or Consul), TTL changes take effect on the next cache miss without restarting EPC. Entries already in Redis retain their original TTL — only newly written entries pick up the new value.

---

## Why Collection Caching Is Not Implemented

Collection query responses (`GET /entities?filter[where][_kind]=book&...`) were considered for caching and explicitly rejected. The root cause is a fundamental mismatch: **EPC is a transparent proxy that does not fully understand the LoopBack query language it would need to evaluate for correct invalidation**.

Correct collection cache invalidation requires EPC to answer the question: *"does this cached response need to be evicted because of this write?"* For single-record caches, the answer is trivially `key == {type}:{id}`. For collection caches, the answer requires evaluating the full query — `filter[where]`, `filter[set]`, `filter[include]`, `filter[order]`, `filter[skip]`, `filter[limit]` — against the changed record.

The specific unsolvable problems:

### 1. `filter[set]` clauses are not evaluable at EPC's layer

The Gateway injects `set` clauses into every request based on the caller's role and identity:
- **visitor:** `sets[actives]=true&sets[publics]=true`
- **member:** `sets[owners][userIds]={sub}&sets[audience][groupIds]={groups}`

In practice, the overwhelming majority of production collection queries arrive at EPC with at least one `filter[set]` clause. Each set is a semantic shorthand for a complex `filter[where]` expression — for example, `sets[actives]=true` expands to `_validFromDateTime ≤ now AND (_validUntilDateTime IS NULL OR _validUntilDateTime > now)`. Evaluating these set expressions requires porting EPS's `SetFilterBuilder` to Java and keeping it in parity. This is a significant ongoing maintenance liability with no clean boundary.

Without set evaluation, EPC must fall back to a **full kind flush** on every create for any cached query that included a `set` clause. Because set clauses are present on virtually all non-admin queries, Strategy 3 (precise filter matching) degenerates into full kind flushing for member and visitor traffic — eliminating its only advantage over a simpler design.

### 2. `filter[include]` responses embed nested records

A response to `GET /entities?filter[include][0][relation]=_reactions` contains embedded reaction records. A subsequent reaction write should invalidate this cached parent-entity response. This requires EPC to traverse nested included objects and register secondary reverse-index entries — adding structural complexity and a dependency on EPS's include-response schema.

### 3. Bulk write operations make affected `_id`s unknowable

`PATCH /entities` (updateAll), `PATCH /lists/{id}/entities`, and `DELETE /lists/{id}/entities` affect an unknown set of records. Without a pre-fetch round-trip to EPS (which adds latency and auth-context forwarding complexity), EPC cannot determine which collection cache entries are stale.

### 4. Per-user (member) collection queries have near-zero cache hit rate

The Gateway injects `sets[audience][userIds]={sub}` for member requests, making each member's query string unique. Two requests from different members for `GET /entities` produce different cache keys even if their responses are identical. The collection cache entry for user A is never reusable by user B. Cache hit rate for member traffic is structurally near-zero, making the caching cost (storage, invalidation complexity, stale-data risk) unjustified.

### The correct tool for collection query acceleration

Collection query performance at scale is properly addressed by:
- **MongoDB indexes** on `_kind`, `_validFromDateTime`, `_visibility`, and compound indexes on common query patterns — already documented in `10_COMPONENT_entity-persistence-service.md`
- **Meilisearch** (`entity-search-gateway`, planned) — the dedicated search engine in the suite, designed for high-volume read queries with its own indexing and relevance model
- **Named queries (`?q=`)** — pre-defined, server-side query templates that avoid sending complex filter strings over the wire

---

## Phase 3: Visitor Collection Caching

Visitor traffic (`sets[actives]=true&sets[publics]=true` injected by the Gateway) is the one case where collection caching is viable:

- The query string is **deterministic and role-agnostic** — all visitors making the same request get the same response, so cache entries are fully shareable.
- The set clause is **static** — `sets[actives]=true&sets[publics]=true` always expands to the same time-window + visibility filter. There is no per-user identity component.

**Phase 3 is committed.** The strategy is **TTL-only invalidation** — no explicit eviction on writes:
- Cache visitor collection queries with a configurable TTL (default: 30s, via `epc.visitor-cache.ttl`).
- Accept that a newly created public+active record will not appear in visitor collection responses for up to TTL seconds.
- Accept that a deleted or deactivated record may remain visible in cached visitor responses for up to TTL.
- No reverse index, no tag index, no FilterMatcher, no set evaluation.

### Enable flag

Phase 3 caching is gated by a dedicated runtime flag (`epc.visitor-cache.enabled`, default: `false`) so that the code ships with Phase 3 but operators enable it only once they observe visitor collection query load justifying the overhead. Flipping the flag via a refreshable MicroProfile Config source (Kubernetes ConfigMap, Consul) takes effect immediately — no restart required.

### TTL configurability

The visitor collection TTL is sourced from `epc.visitor-cache.ttl` (`EPC_VISITOR_CACHE_TTL`, default: `30s`) via a refreshable MicroProfile Config source. Operators lower the TTL if UX freshness requirements tighten; raise it to reduce MongoDB read load. Changes apply to new cache writes only — existing Redis entries retain their original TTL until expiry.

### Known limitation

The stale window (up to TTL) is a fundamental property of TTL-only invalidation: a newly created, modified, or deactivated record will not be reflected in visitor collection responses until the cache entry expires. This is an accepted trade-off. The TTL backstop is the sole invalidation mechanism for Phase 3 visitor collection cache entries.

---

## Observability

### Metrics (Micrometer)

All counters carry a `record_type` tag (`entity`, `list`, `relation`, `entity-reaction`, `list-reaction`).

| Metric | Type | Additional tags | Description |
|:---|:---|:---|:---|
| `epc.cache.hit` | Counter | `record_type` | findById cache hit |
| `epc.cache.miss` | Counter | `record_type` | findById cache miss |
| `epc.cache.put` | Counter | `record_type`, `status: [200, 404]` | Entry written to cache |
| `epc.cache.evict` | Counter | `record_type`, `trigger: [write_single, write_delete, write_bulk_noop, ttl_expired, bypass]` | Entry evicted. `write_bulk_noop` is incremented on updateAll/deleteAll to surface the known-limitation in metrics even though no actual eviction occurs |
| `epc.cache.conditional_hit` | Counter | `record_type` | `If-None-Match` matched stored ETag → 304 returned |
| `epc.lock.record_fetch` | Counter | `record_type`, `source: [cache_hit, eps_fallback]` | Record fetched to build PATCH lock key. `cache_hit` — full-field cache entry used; `eps_fallback` — direct EPS GET was required (auth disabled, cold cache, or TTL expiry) |
| `epc.lock.acquired` | Counter | `lock_type: [uniqueness, limit, global]` | Lock acquired successfully |
| `epc.lock.released` | Counter | `lock_type` | Lock released |
| `epc.lock.timeout` | Counter | `lock_type` | Lock wait exceeded `wait-time` → 423 |
| `epc.lock.wait_time` | Histogram | `lock_type` | Time spent waiting to acquire lock |
| `epc.lock.held_time` | Histogram | `lock_type` | Time lock was held (acquisition to release) |

### Alerting thresholds

| Condition | Severity | Notes |
|:---|:---|:---|
| findById cache hit rate < 50% over 5 min | Warn | Baseline may need adjustment post-deployment |
| Lock timeout rate > 1% over 1 min | Critical | Indicates contention or Redis latency |
| Redis connection errors > 0 over 1 min | Critical | |
| `epc.cache.evict` rate spikes 10× 15-min baseline over 1 min | Warn | Possible bulk import bypassing EPC |

### Structured logging

JSON structured logging. MDC field `requestId` is populated from the inbound `X-Request-Id` header (set by the Gateway, forwarded by the Orchestrator). EPC does **not** generate its own request IDs.

| Event | Level | When |
|:---|:---|:---|
| `CACHE_HIT` | DEBUG | findById served from cache |
| `CACHE_MISS` | DEBUG | findById forwarded to EPS |
| `CACHE_BYPASS` | DEBUG | `Cache-Control: no-cache` or `no-store` received |
| `CACHE_CONDITIONAL_HIT` | DEBUG | `If-None-Match` matched → 304 |
| `CACHE_EVICT` | INFO | Cache entry evicted (write path) |
| `CACHE_PUT` | DEBUG | Cache entry written |
| `LOCK_RECORD_FETCH_HIT` | DEBUG | Full-field cache entry found and used for PATCH lock key merge |
| `LOCK_RECORD_FETCH_EPS_FALLBACK` | INFO | Full-field cache entry absent; direct EPS GET used for PATCH lock key merge (normal when auth is disabled; transient when auth is enabled) |
| `LOCK_RECORD_NOT_FOUND` | INFO | EPS returned 404 during PATCH record fetch — returning 404 to caller |
| `LOCK_ACQUIRED` | DEBUG | Scope lock acquired |
| `LOCK_RELEASED` | DEBUG | Scope lock released |
| `LOCK_TIMEOUT` | WARN | Lock wait exceeded threshold → 423 |
| `REDIS_UNAVAILABLE` | ERROR | Redis connection failed |

### OpenTelemetry

Span events added to the Camel route span: `cache.hit`, `cache.miss`, `cache.bypass`, `cache.conditional_hit`, `lock.acquired`, `lock.released`. Lock keys are stored as **truncated/hashed** span attributes — never raw. No auth tokens, user IDs, or record body content in span attributes (KVKK compliance).

---

## Configuration Reference

| Property | Env var override | Default | Description |
|:---|:---|:---|:---|
| `quarkus.http.port` | `QUARKUS_HTTP_PORT` | `3001` | EPC HTTP listen port |
| `backend.base-url` | `BACKEND_BASE_URL` | `http://localhost:3000` | EPS URL (same pod, localhost) |
| `backend.system-info-path` | `BACKEND_SYSTEM_INFO_PATH` | `/system-info` | EPS config endpoint path |
| `epc.app-shortcode` | `EPC_APP_SHORTCODE` | _(none)_ | Fallback app shortcode when `X-App-Shortcode` header is absent (e.g. direct calls without the gateway). Header takes precedence when both are present. |
| `epc.config-cache.ttl-seconds` | `EPC_CONFIG_CACHE_TTL_SECONDS` | `10` | TTL for in-process `/system-info` cache |
| `epc.lock.wait-time` | `EPC_LOCK_WAIT_TIME` | `3s` | Max time to wait for a lock before returning 423 |
| `epc.lock.lease-time` | `EPC_LOCK_LEASE_TIME` | `30s` | Lock TTL in Redis (auto-expires if EPC crashes) |
| `epc.cache.enabled` | `EPC_CACHE_ENABLED` | `true` | Master switch — when `false`, all findById caching is disabled globally; EPC acts as a transparent pass-through for GETs while still acquiring/releasing locks |
| `epc.cache.default-ttl` | `EPC_CACHE_DEFAULT_TTL` | `60s` | Global fallback TTL for all findById cache entries (level 3 of hierarchy) |
| `epc.cache.ttl.entity` | `EPC_CACHE_TTL_ENTITY` | _(inherits global default)_ | TTL for entity findById — overrides global default (level 2) |
| `epc.cache.ttl.entity.kinds.{kind}` | `EPC_CACHE_TTL_ENTITY_KINDS_{KIND}` | _(inherits type TTL)_ | Per-kind TTL override for entities (level 1 — most specific). Example: `EPC_CACHE_TTL_ENTITY_KINDS_BOOK=120s` |
| `epc.cache.ttl.list` | `EPC_CACHE_TTL_LIST` | _(inherits global default)_ | TTL for list findById (level 2) |
| `epc.cache.ttl.list.kinds.{kind}` | `EPC_CACHE_TTL_LIST_KINDS_{KIND}` | _(inherits type TTL)_ | Per-kind TTL override for lists (level 1) |
| `epc.cache.ttl.relation` | `EPC_CACHE_TTL_RELATION` | _(inherits global default)_ | TTL for relation findById (level 2) |
| `epc.cache.ttl.relation.kinds.{kind}` | `EPC_CACHE_TTL_RELATION_KINDS_{KIND}` | _(inherits type TTL)_ | Per-kind TTL override for relations (level 1) |
| `epc.cache.ttl.entity-reaction` | `EPC_CACHE_TTL_ENTITY_REACTION` | _(inherits global default)_ | TTL for entity-reaction findById (level 2) |
| `epc.cache.ttl.entity-reaction.kinds.{kind}` | `EPC_CACHE_TTL_ENTITY_REACTION_KINDS_{KIND}` | _(inherits type TTL)_ | Per-kind TTL override for entity-reactions (level 1) |
| `epc.cache.ttl.list-reaction` | `EPC_CACHE_TTL_LIST_REACTION` | _(inherits global default)_ | TTL for list-reaction findById (level 2) |
| `epc.cache.ttl.list-reaction.kinds.{kind}` | `EPC_CACHE_TTL_LIST_REACTION_KINDS_{KIND}` | _(inherits type TTL)_ | Per-kind TTL override for list-reactions (level 1) |
| `epc.visitor-cache.enabled` | `EPC_VISITOR_CACHE_ENABLED` | `false` | Phase 3 master switch — when `true`, visitor collection GET responses are cached with TTL-only invalidation. Sourced from a refreshable config source; takes effect immediately without restart. |
| `epc.visitor-cache.ttl` | `EPC_VISITOR_CACHE_TTL` | `30s` | TTL for Phase 3 visitor collection cache entries. Refreshable at runtime — applies to new writes only; existing Redis entries retain their original TTL until expiry. |
| `quarkus.redis.hosts` | `QUARKUS_REDIS_HOSTS` | `redis://localhost:6379` | Redis URL for the **findById cache client** (Quarkus Redis / `FindByIdCacheService`). Use `rediss://` for TLS; include password as `rediss://:password@host:port`. In production, point this at a dedicated `allkeys-lfu` Redis instance. |
| `epc.redis.url` | `EPC_REDIS_URL` | _(inherits `QUARKUS_REDIS_HOSTS`)_ | Redis URL for the **scope lock client** (Redisson / `LockService`). Defaults to the same value as `quarkus.redis.hosts` — both clients share one instance by default. In production, point this at a dedicated `noeviction` Redis instance to guarantee lock keys are never evicted while held. |

---

## Operational Notes

- **EPS must be reachable before EPC starts.** EPC inherits the `BackendStartupCheck` from the orchestrator template and probes `/ping` on EPS at startup.
- **Redis must be available.** Without Redis, EPC cannot acquire locks and will fail fast. If Redis goes down mid-operation, Redisson's lock will expire after `lease-time` — no permanent lock leaks.
- **EPC does not need to be deployed.** Like the orchestrator, EPC is optional. Deployments that accept best-effort uniqueness/limit enforcement (e.g. development, low-concurrency internal tools) can route the Gateway directly to EPS and skip EPC entirely.
- **EPC and the orchestrator can both be in the chain.** If the orchestrator is deployed, the topology is: `Gateway → Orchestrator → EPC → EPS`. The orchestrator does not need to know about EPC.

---

## Related Documents

- [`00_SYSTEM_MANIFEST.md`](./00_SYSTEM_MANIFEST.md) — Layer V component list; Redis usage note
- [`10_COMPONENT_entity-persistence-service.md`](./10_COMPONENT_entity-persistence-service.md) — EPS uniqueness/limit config and known TOCTOU limitations
- [`13_COMPONENT_universal-orchestrator.md`](./13_COMPONENT_universal-orchestrator.md) — The template this component is cloned from
- [`25_CONCEPT_concurrency-and-integrity.md`](./25_CONCEPT_concurrency-and-integrity.md) — Full analysis of concurrency risks and mitigations across the suite
- [`31_OPS_configuration-reference.md`](./31_OPS_configuration-reference.md) — `ENTITY_UNIQUENESS`, `ENTITY_RECORD_LIMITS`, and related EPS env vars
