# 15_COMPONENT_entity-persistence-cache.md

## Component Identity

**Repository:** `entity-persistence-cache` *(planned — not yet created)*  
**Technology:** Java 21 · Quarkus 3.x · Apache Camel (camel-quarkus) · Redisson  
**Layer:** V — Data, Search & Storage  
**Default port:** `3001`  
**Template basis:** Cloned and extended from `entity-persistence-universal-orchestrator`  
**Source of truth for its own docs:** *(repository does not yet exist)*

---

## What It Is

`entity-persistence-cache` (EPC) is a **transparent proxy** that sits between the Orchestration Layer and `entity-persistence-service` and serves two distinct purposes:

1. **Query acceleration (primary purpose)** — caches GET response bodies in Redis with configurable TTLs, dramatically reducing MongoDB load for frequently read resources. Cache entries are invalidated when the underlying data changes, using a tiered invalidation strategy described in the [Response Caching](#response-caching) section.

2. **Write integrity enforcement** — acquires Redis distributed locks keyed on the interpolated uniqueness/limit scope before forwarding write requests to EPS, serialising concurrent writes that would collide on the same logical key and eliminating the TOCTOU race condition in EPS's uniqueness and per-user/per-kind limit checks.

> **What it does NOT do:** EPC does not replace the uniqueness and record-limit checks inside EPS. Those remain as the authoritative enforcement point. EPC's lock layer is an additional guard that eliminates the race window *before* the check runs — making EPS's best-effort behaviour effectively deterministic under normal load.

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
│  EPC PreProcessor                │  ← acquires Redis lock keyed on uniqueness/limit scope
│  (e.g. CreateEntityPreProcessor) │  ← on lock timeout → 429 / 423
└──────────────┬──────────────────┘
               │
       [lock acquired]
               │
               ▼
   [proxy to entity-persistence-service]
               │
               ▼
┌─────────────────────────────────┐
│  EPC PostProcessor               │  ← releases lock (via doFinally)
│                                  │  ← optionally caches GET response in Redis
└──────────────┬──────────────────┘
               │
               ▼
Gateway Response
```

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

EPC and EPS are deployed in the **same Kubernetes pod** (sidecar pattern), sharing `localhost`. The loopback communication between EPC and EPS is as fast as inter-process communication with no network hop.

```
Client → Gateway :8081 → Orchestrator :8079 → EPC :3001 → EPS :3000 → MongoDB
                                                    └── Redis (lock acquire/release)
                                                    └── Redis (GET response cache)
```

When the Orchestration Layer is not deployed, the topology shortens to:

```
Client → Gateway :8081 → EPC :3001 → EPS :3000 → MongoDB
```

The Gateway routes to EPC by setting `app.backend.host` and `app.backend.port` to EPC's address — exactly the same knob used to insert the Orchestrator.

---

## Lock Key Design

### For uniqueness rules

Given a uniqueness rule:

```
ENTITY_UNIQUENESS="where[_kind]=${_kind}&where[_slug]=${_slug}&set[owners][userIds]=${_ownerUsers}"
```

This rule means: *a record is unique per owner, per kind, per slug*. User 1 and user 2 can each have a `book` with slug `the-great-gatsby`; neither can have two. The `set[owners][userIds]=${_ownerUsers}` part scopes the uniqueness check to the owner dimension — see `10_COMPONENT_entity-persistence-service.md §Uniqueness Constraints` for the full semantics.

EPC parses the rule (cached for 10s from `/system-info`), identifies the interpolatable dimensions (`_kind`, `_slug`, `_ownerUsers`), and extracts those values from the incoming request payload.

**When an interpolated field is an array, EPC acquires one lock per array element.** A single lock key built from only the first element would miss races involving the other owners. For example, if request A has `_ownerUsers: ["user-1", "user-2"]` and request B has `_ownerUsers: ["user-2", "user-3"]`, they share `user-2` as a co-owner and would collide on the `user-2` ownership dimension — but if only `[0]` were used, they would get different lock keys and race freely.

For `_ownerUsers: ["user-1", "user-2"]`, EPC acquires **two locks**:

```
BOOKS:epc:lock:uniqueness:entity:book:the-great-gatsby:user-1
BOOKS:epc:lock:uniqueness:entity:book:the-great-gatsby:user-2
```

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

Given a record-limit rule:

```json
{"scope": "where[_ownerUsers]=${_ownerUsers}&where[_kind]=book", "limit": 10}
```

EPC extracts the interpolatable dimensions (`_ownerUsers`) and constructs:

```
{appShortcode}:epc:lock:limit:entity:{scope-hash}:{_ownerUsers[0]}
e.g.  BOOKS:epc:lock:limit:entity:a3f9c2:user-123
```

### Wide-scope and global limits

For limit rules whose scope contains **no interpolatable fields** (e.g. `""` — global cap, or `where[_kind]=book` — kind-wide cap), the lock key would be identical for every create request regardless of who makes it. Acquiring that lock serialises the entire collection globally — unacceptable by default in a multi-tenant environment under normal throughput, but entirely correct and desirable for certain use cases such as hard licence-seat caps.

**EPC behaviour is opt-in, controlled by `enforceSerialisation` on the limit rule.**

```json
{"scope": "",                  "limit": 10,  "enforceSerialisation": true}
{"scope": "where[_kind]=book", "limit": 500, "enforceSerialisation": true}
{"scope": "",                  "limit": 500}
```

When `enforceSerialisation: true`, EPC acquires a lock keyed on the fully resolved (non-interpolated) scope string:

```
BOOKS:epc:lock:limit:entity:global          (scope: "")
BOOKS:epc:lock:limit:entity:kind:book       (scope: "where[_kind]=book")
```

When `enforceSerialisation` is absent or `false` (the default), wide-scope rules remain best-effort — no lock is acquired and EPS's own count check is the sole gate.

**`enforceSerialisation` is defined on the EPS `RecordLimit` schema** and preserved through to `/system-info`. EPS itself never acts on it — it is a passthrough field meaningful only to EPC. See `10_COMPONENT_entity-persistence-service.md §Record Limits` for the full schema and examples.

**Choosing when to set `enforceSerialisation: true`:**

| Scenario | Recommendation |
|:---|:---|
| Hard licence/seat cap (e.g. max 10 total records) | `true` — correctness over throughput |
| Hard per-kind cap at low volume (e.g. max 5 featured articles) | `true` — low contention, safe to serialise |
| Soft global rate limit (e.g. max 2 creates/minute) | `false` — occasional overshoot is acceptable |
| High-volume kind cap (e.g. max 500,000 books) | `false` — global serialisation would bottleneck the system |
| Per-user/per-kind cap with interpolatable scope | N/A — always locked per the interpolated dimensions, no flag needed |

The practical overshoot when `enforceSerialisation: false` for a global limit of N with C concurrent writers is at most C − 1 extra records. For soft quotas this is acceptable. For hard quotas at high volume where serialisation is also unacceptable, a MongoDB counter document with atomic `$inc` remains the correct solution and is out of scope for EPC.

---

## Template Basis: `entity-persistence-universal-orchestrator`

EPC is built by **cloning** `entity-persistence-universal-orchestrator` and replacing the pre/post-processor stubs with lock acquisition / release logic. This choice was deliberate:

| Reason | Detail |
|:---|:---|
| Same API surface | The orchestrator already mirrors all 67 EPS endpoints. EPC inherits this coverage for free. |
| Same proxy mechanics | `bridgeEndpoint=true`, hop-by-hop header stripping, `throwExceptionOnFailure=false` — all already correct in the template. |
| Same CDI + Camel idioms | The processor injection pattern (`@Inject`, `@ApplicationScoped`) maps cleanly to a lock-service CDI bean. |
| Same observability | OpenTelemetry trace propagation, request ID headers, and structured logging are pre-wired. |
| Same configuration model | MicroProfile Config + `application.properties` with env var overrides. |

The only EPC-specific additions on top of the orchestrator template are:

1. A `LockService` CDI bean (wraps Redisson `RLockReactive`, constructs lock keys from config)
2. A `ConfigCacheService` CDI bean (Caffeine cache wrapping EPS `/system-info` call)
3. A `LockKeyBuilder` utility (parses uniqueness/limit scope strings, interpolates field values)
4. Wiring each create/update PreProcessor to call `lockService.acquireLock(...)` and each PostProcessor to call `lockService.releaseLock(...)`

All routing, proxy, and pass-through logic is inherited unchanged from the template.

The EPC-specific additions on top of the orchestrator template are:

1. A `LockService` CDI bean (wraps Redisson `RLockReactive`, constructs lock keys from config)
2. A `ConfigCacheService` CDI bean (Caffeine cache wrapping EPS `/system-info` call)
3. A `LockKeyBuilder` utility (parses uniqueness/limit scope strings, interpolates field values)
4. A `ResponseCacheService` CDI bean (Redis-backed GET response cache with reverse index and tag index)
5. A `CacheInvalidationService` CDI bean (pre-emptive invalidation in PreProcessor; see [Invalidation Timing](#invalidation-timing))
6. A `FilterMatcherPort` utility (in-memory `Where` clause evaluator — Java port of EPS's `FilterMatcher`; used for precise create-time invalidation)
7. Wiring each create/update/delete **PreProcessor** to call `cacheInvalidationService.invalidateBeforeWrite(...)` and `lockService.acquireLock(...)`, and each **PostProcessor** to call `lockService.releaseLock(...)`
8. Wiring each GET PreProcessor to check `responseCacheService.get(...)` and short-circuit on hit; GET PostProcessor to call `responseCacheService.put(...)`

---

## Response Caching

### Purpose and scope

EPC caches the full response body of GET requests in Redis. This covers collection queries (`GET /entities`), single-record fetches (`GET /entities/{id}`), relation traversals (`GET /lists/{id}/entities`), and reaction queries (`GET /entities/{id}/reactions`).

> **Count queries are not cached.** `GET /entities/count` and equivalent count endpoints are excluded from caching. Count values are invalidated by any create or delete in the collection, giving them the lowest possible cache hit rate in write-active systems. They are also cheap for MongoDB on indexed fields. Caching count results would require the broadest possible invalidation surface for the lowest benefit.

**Cache key** is composed of:
- HTTP method + normalised path + sorted query string
- Optionally: a user-identity dimension for private/owner-scoped responses (configurable per route)

```
BOOKS:epc:cache:GET:/entities?filter[where][_kind]=book&filter[limit]=10
BOOKS:epc:cache:GET:/entities/abc-123
BOOKS:epc:cache:GET:/lists/xyz/entities
```

### Invalidation timing

**Invalidation happens in the PreProcessor — before forwarding the write to EPS.**

This is a deliberate design decision. The natural place to invalidate is the PostProcessor (after EPS confirms success), but that approach has a critical failure mode: if EPS persists the change and then EPC crashes or loses the connection before the PostProcessor runs, the cache retains stale data indefinitely (until TTL). A crash that occurs after EPS writes but before EPC invalidates leaves no mechanism to recover — the cache has no way to learn that it missed an invalidation.

By invalidating in the PreProcessor — as soon as EPC has decided to allow the request through — we accept a different trade-off: if EPS ultimately rejects the write (409 uniqueness violation, 422 validation error, 429 limit exceeded), the cache entry was evicted unnecessarily and the next read incurs one cache miss. This is a harmless performance cost, not a data integrity issue.

**Why no no-op optimisation for updates:** An intuitive optimisation would be to skip eviction when the incoming PATCH/PUT payload appears to carry the same values as the cached record. This is not implementable correctly at EPC's position in the pipeline. EPS always decorates every persisted write with managed fields regardless of whether the domain data changed — `_lastUpdatedDateTime` is set to `now`, `_version` is always incremented, `_slug` is always regenerated, `_lastUpdatedBy` is always injected from request context. The EPS response is therefore never byte-for-byte equal to the previously cached record even for a genuine no-op update. Stripping managed fields before comparing would require EPC to know the complete and current managed-field list and to reproduce EPS's field-merge logic for partial PATCH documents — a fragile dependency on EPS internals. Additionally, the gateway itself may modify the incoming payload before EPS sees it (e.g. `AddManagedFieldsInCreation`, OPA-driven field injection), so EPC cannot know the final post-decoration payload without intercepting the gateway's own transformation. **Pre-emptive eviction on every allowed write is the correct and only defensible strategy.** The cost is one extra MongoDB read on the next GET after an unnecessary eviction — a bounded, acceptable performance cost on an already-uncommon code path.

### The invalidation problem

When a write is allowed through, cached responses that contain or were derived from the affected record need to be identified and flushed. Three strategies are layered together.

#### Strategy 1 — Short TTL (safety net, always applied)

Every cache entry carries a TTL (default 60s, configurable per record type). Regardless of explicit invalidation, stale entries expire automatically. This is the unconditional backstop.

#### Strategy 2 — Precise reverse-index invalidation (updates and deletes)

When EPC stores a GET response, it builds a *reverse index* in Redis: for each `_id` appearing in the response body, it adds the cache key to a Redis Set keyed by that `_id`.

```
Redis Set  epc:ridx:entity:abc-123  →  { "BOOKS:epc:cache:GET:/entities?...", "BOOKS:epc:cache:GET:/entities/abc-123" }
Redis Set  epc:ridx:entity:def-456  →  { "BOOKS:epc:cache:GET:/entities?..." }
```

On update or delete of `_id: abc-123` — in the PreProcessor:
1. Look up `epc:ridx:entity:abc-123`
2. Delete each listed cache key
3. Delete the reverse index entry itself

This is **precise** — only entries that actually contained the changed record are evicted. Collection entries that didn't include `abc-123` survive untouched.

**Does not apply to creates:** A newly created record has no prior reverse index entry (it didn't exist when any GET was cached).

#### Strategy 3 — In-memory filter matching (creates)

When a new record is created, EPC needs to determine which cached collection queries would now return a different result — specifically, queries whose filter the new record satisfies. Rather than flushing all queries of that kind (over-invalidation), EPC evaluates each cached query's stored `where` clause against the incoming record body **in memory**, using a Java port of EPS's [`FilterMatcher`](../../entity-persistence-service/src/extensions/utils/filter-matcher.ts).

`FilterMatcher` is a complete in-memory LoopBack `Where` clause evaluator already present in EPS. It handles `eq`, `neq`, `gt`/`gte`/`lt`/`lte`, `between`, `inq`, `nin`, `like`/`ilike`/`nlike`, `regexp`, `exists`, and `and`/`or` boolean operators, including array field membership (e.g. matching `_ownerUsers` array against a scalar condition). EPS already uses it in `RecordLimitCheckerService` to determine whether an incoming record falls within a scope without a database round-trip — the same pattern applies here.

**How it works:**

When EPC stores a collection GET response, it stores alongside the cache key the parsed `Where` object extracted from `filter[where]` in the query string:

```
Redis Hash  epc:tagidx:entity:book  →  {
    "BOOKS:epc:cache:GET:/entities?filter[where][_kind]=book&filter[limit]=10":  {"_kind":"book"},
    "BOOKS:epc:cache:GET:/entities?filter[where][_kind]=book&filter[where][_name][like]=Gats%": {"_kind":"book","_name":{"like":"Gats%"}},
    ...
}
```

On **create** of a new `book` entity (in the PreProcessor, using enriched data available after slug/kind defaults are applied by the gateway):
1. Retrieve `epc:tagidx:entity:book` (the index for this record type + kind)
2. For each entry `{cacheKey, whereClause}`, evaluate `FilterMatcher.matches(newRecord, whereClause)`
3. Evict only the cache keys where the match returns `true`

**Scope boundary:** This in-memory matching applies only to `filter[where]` conditions. Queries that include `filter[set]` clauses (e.g. `set[actives]`, `set[owners][userIds]=...`) require `SetFilterBuilder` resolution to convert into a `Where` object — this is a non-trivial port. For those queries, EPC falls back to tag-based eviction (flush all cached queries for that kind). The tag index stores a flag per entry indicating whether `filter[set]` was present, so the fallback is applied selectively.

**Result:** Creates only evict cache entries whose stored filter actually matches the new record. A cached query for `filter[where][_name][like]=Gats%` is only evicted if the new record's `_name` matches that pattern. All other cached queries survive.

### Invalidation decision matrix

| Write operation | Strategy used | What is evicted |
|:---|:---|:---|
| `POST /entities` (create) | Strategy 3 (in-memory filter match) | Only collection entries whose `where` filter matches the new record; `filter[set]` entries fall back to full kind flush |
| `PUT /entities/{id}` (replace) | Strategy 2 (reverse index) | Exactly the cache entries that contained `{id}`; plus kind flush if `_kind` or `_ownerUsers` changed |
| `PATCH /entities/{id}` (update) | Strategy 2 (reverse index) | Exactly the cache entries that contained `{id}`; plus kind flush if `_kind` or `_ownerUsers` changed |
| `PATCH /entities` (updateAll) | Full kind flush | All cached collection entries for the affected record type + kind (see below) |
| `DELETE /entities/{id}` | Strategy 2 + kind flush | Reverse index entries for `{id}` + kind-level flush (record no longer exists, collection queries change) |
| `POST /relations` | Strategy 3 | Collection entries for `_listId` whose filter matches; full flush for `filter[set]` queries |
| `DELETE /relations/{id}` | Strategy 2 + kind flush | Reverse index entries + `list:{_listId}:members` full flush |
| `POST /entity-reactions` | Strategy 3 | Collection entries for `_entityId` whose filter matches |

All invalidation for the same pattern applies symmetrically to `lists`, `list-reactions`, and all `through` endpoints.

### `updateAll` invalidation

`PATCH /entities` (bulk update) is qualitatively different from single-record writes. EPC receives a `where` filter and a partial update body, but does **not** know which `_id`s are affected — the response is only `{"count": N}`. The reverse index is therefore unusable.

Three approaches were considered:

1. **Full kind flush** — evict all cached collection entries for the record type + kind extracted from the `updateAll` `where` clause. Always correct, maximally over-invalidating.
2. **Reverse filter overlap detection** — for each cached query in the tag index, test whether the `updateAll` `where` clause and the cached query's stored `where` clause can both be satisfied by the same record. Implementable for simple equality conditions but degrades into a constraint satisfaction problem for range conditions, `like`, `inq`, and compound `and/or` trees. Not implementable correctly in the general case.
3. **Fetch affected `_id`s first** — query EPS for the `_id`s that match the `updateAll` filter before forwarding the update, then use the reverse index. Adds a full round-trip query to every bulk update's critical path; also requires the same auth context to be forwarded, making it fragile.

**Decision: full kind flush.**

`updateAll` is an administrative bulk operation, not a hot-path single-record mutation. Evicting all cached collection queries for a kind after a bulk update is proportionate — if N records changed simultaneously, invalidating every collection query that could have contained any of them is the correct conservative response. The cache rebuilds on subsequent reads.

**Kind extraction from the `updateAll` filter:** EPC reads the `filter[where]` query parameter to determine which kinds are affected. If `filter[where][_kind]=book` is present, only the `entity:book` tag is flushed. If no `_kind` condition is present (the update targets all kinds), all kind tags for the record type are flushed. This keeps the flush scoped when the caller has been specific.

### Why write-path invalidation — not CDC

An alternative design would consume MongoDB change events (via Debezium → Redpanda) and invalidate caches reactively. This was considered and rejected:

1. **CDC infrastructure is planned but not yet deployed.** EPC would be undeployable without it.
2. **EPC already sees every write.** The information needed for invalidation is available synchronously in the PreProcessor without any event bus.
3. **Pre-emptive invalidation is crash-safe.** CDC-based invalidation can miss events if the consumer is down when the change occurs. Pre-emptive invalidation in the PreProcessor fires before the write reaches EPS, so no crash window exists between write and invalidation.
4. **Simpler operational model.** No consumer group management, no offset tracking, no reprocessing on consumer restart.

CDC-based invalidation remains a valid future enhancement for scenarios where EPC is bypassed (e.g. bulk MongoDB imports, Debezium-sourced migrations).

### Reverse index TTL management

The reverse index sets (`epc:ridx:entity:{_id}`) and tag indexes (`epc:tagidx:entity:{kind}`) must not outlive the cache entries they reference — otherwise they grow unboundedly. EPC manages this by:

- Setting the TTL of each reverse index entry to match the TTL of its associated cache key (plus a small buffer, e.g. +10s)
- Removing index entries during explicit invalidation atomically via a Redis Lua script (delete cache key + remove from reverse index + remove from tag index in one atomic operation)
- Tag index entries carry the same TTL as their associated cache keys; expired entries are removed lazily on next access

---

## Configuration Reference

| Property | Env var override | Default | Description |
|:---|:---|:---|:---|
| `quarkus.http.port` | `QUARKUS_HTTP_PORT` | `3001` | EPC HTTP listen port |
| `backend.base-url` | `BACKEND_BASE_URL` | `http://localhost:3000` | EPS URL (same pod, localhost) |
| `backend.system-info-path` | `BACKEND_SYSTEM_INFO_PATH` | `/system-info` | EPS config endpoint path |
| `epc.config-cache.ttl-seconds` | `EPC_CONFIG_CACHE_TTL_SECONDS` | `10` | TTL for in-process `/system-info` cache |
| `epc.lock.wait-time` | `EPC_LOCK_WAIT_TIME` | `3s` | Max time to wait for a lock before returning 423 |
| `epc.lock.lease-time` | `EPC_LOCK_LEASE_TIME` | `30s` | Lock TTL in Redis (auto-expires if EPC crashes) |
| `epc.cache.default-ttl` | `EPC_CACHE_DEFAULT_TTL` | `60s` | Default TTL for all GET response cache entries |
| `epc.cache.ttl.entity` | `EPC_CACHE_TTL_ENTITY` | _(inherits default)_ | TTL override for entity GET responses |
| `epc.cache.ttl.list` | `EPC_CACHE_TTL_LIST` | _(inherits default)_ | TTL override for list GET responses |
| `epc.cache.ttl.relation` | `EPC_CACHE_TTL_RELATION` | _(inherits default)_ | TTL override for relation GET responses |
| `epc.cache.ttl.entity-reaction` | `EPC_CACHE_TTL_ENTITY_REACTION` | _(inherits default)_ | TTL override for entity-reaction GET responses |
| `epc.cache.ttl.list-reaction` | `EPC_CACHE_TTL_LIST_REACTION` | _(inherits default)_ | TTL override for list-reaction GET responses |
| `epc.cache.enabled` | `EPC_CACHE_ENABLED` | `true` | Enable/disable GET response caching globally |
| `epc.cache.user-scoped-paths` | `EPC_CACHE_USER_SCOPED_PATHS` | _(none)_ | Comma-separated path patterns whose cache keys include the caller's `X-User-Id` (for owner/private responses) |
| `quarkus.redis.hosts` | `QUARKUS_REDIS_HOSTS` | `redis://localhost:6379` | Redis connection URL |

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
