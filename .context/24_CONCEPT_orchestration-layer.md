# 24_CONCEPT_orchestration-layer.md

## Overview

The Orchestration Layer is the **designated, first-class extension point** for custom business logic in the Tarcinapp suite. It is optional in the sense that simple deployments (pure CRUD with configuration-level rules) may not need it — but it is the intended and expected path for any product requirement that cannot be expressed through gateway configuration or OPA policies alone. Tarcinapp explicitly provides a template repository (`entity-persistence-universal-orchestrator`) with pre-wired stub processors for every endpoint so that adding custom logic is a matter of filling in the right class, not building scaffolding from scratch.

This document explains: what the orchestration layer is, when to use it, how it integrates with the rest of the system, and how to extend the universal orchestrator template for a specific product.

---

## Where It Fits

```
Gateway (Spring Cloud Gateway)
    │
    ▼  ← Gateway routes to either:
    │
    ├─── entity-persistence-universal-orchestrator  (when deployed)
    │         │
    │         └─── entity-persistence-service
    │
    └─── entity-persistence-service (direct, without orchestrator)
```

The Gateway is unaware of whether an orchestrator is present. It proxies to `app.backend.host:app.backend.port`. If that address points to the orchestrator, the orchestrator is in the chain. If it points directly to EPS, the orchestrator is bypassed.

The orchestrator exposes the **exact same API contract as EPS** — same paths, same methods, same request/response shapes. It is a transparent proxy that intercepts at the route level.

---

## The Pre/Post-Processor Pipeline

Every EPS endpoint maps to a **Camel route** in the orchestrator. Each route follows this pattern:

```
[Camel Route]
  from("platform-http:/{path}?httpMethodRestrict={METHOD}")
    .process(preProcessor)
    .toD("http://{{backend.base-url}}/{path}")  ← call EPS
    .process(postProcessor)
```

The orchestrator uses **`toD()`** (dynamic routing) rather than `to()`. This allows the backend URL to be resolved from config at runtime, so the same compiled artifact can target different EPS instances simply by changing `backend.base-url` in the config.

The orchestrator's `platform-http` component listens on **all EPS paths and methods**. Every inbound request from the Gateway is caught by the matching Camel route, passed through the pre-processor, forwarded to EPS, and then passed through the post-processor before the response is returned.

### PreProcessor

Runs **before** the request reaches EPS. The full request (headers, body, query params) is available on the Camel `Exchange`.

**Can do:**
- Add or modify fields in the request body
- Add custom HTTP headers
- Make auxiliary calls to the Gateway or external services
- Short-circuit with an error response (before EPS is called)
- Log or validate custom business rules

**Common use cases:**
- Auto-populate a field from another system (e.g., fetch `categoryName` from a taxonomy service)
- Enforce a cross-record business rule (e.g., "user may not have more than 3 pending orders — check EPS before allowing create")
- Compute a derived field (e.g., generate a `slug` that requires external vocabulary normalization)

### PostProcessor

Runs **after** EPS responds. The EPS response body and status are available.

**Can do:**
- Enrich the response (add computed or aggregated fields)
- Trigger async side effects (post a message, update a counter, notify an external system)
- Transform the response shape
- Log business events

**Common use cases:**
- After creating an entity, publish an event to a message broker
- After deleting a record, clean up related records in another system
- Aggregate data from multiple EPS calls into a single enriched response

---

### Headers Available in Processors

Before the request reaches the orchestrator, the Gateway injects a set of standard HTTP headers. These are always present when the orchestrator is invoked through the normal Gateway flow. Camel processors access them via `exchange.getIn().getHeader(...)`.

| Header | Source | Value |
|:---|:---|:---|
| `X-User-Id` | JWT `sub` claim | The authenticated user's subject identifier |
| `X-Request-Id` | Gateway-generated | A unique ID for this request (useful for correlation logging) |
| `X-User-Roles` | JWT roles claim | Comma-separated list of role names (e.g. `"user,admin"`) |
| `X-User-Groups` | JWT groups claim | Comma-separated list of group names |
| `X-App-Shortcode` | Gateway config | The shortcode of the gateway app (e.g. `"myapp"`) |

**Example — reading gateway-injected headers in a processor:**

```java
@ApplicationScoped
public class CreateEntityPreProcessor implements Processor {
    @Override
    public void process(Exchange exchange) throws Exception {
        String userId    = exchange.getIn().getHeader("X-User-Id",      String.class);
        String requestId = exchange.getIn().getHeader("X-Request-Id",   String.class);
        String roles     = exchange.getIn().getHeader("X-User-Roles",   String.class);
        String groups    = exchange.getIn().getHeader("X-User-Groups",  String.class);
        String shortcode = exchange.getIn().getHeader("X-App-Shortcode", String.class);

        // Use these for enrichment, access checks, or logging
    }
}
```

---

### Body Shape at Each Stage

By the time the request hits the orchestrator's **PreProcessor**, the Gateway has already applied several filters in sequence. Understanding what the body already contains is critical for writing correct processors.

For a `POST /entities` (createEntity) request, the body your PreProcessor receives already has:

1. **`_kind`** — injected by the Gateway's `PlaceKindNameIntoPayload` filter, which resolves the kind alias (e.g. `books → book`) and writes it into the payload.
2. **`_createdBy`**, **`_ownerUsers`**, **`_createdDateTime`** — injected by the Gateway's `AddManagedFieldsInCreation` filter, which reads from the JWT and current time.
3. **Redis lock acquired** — the Gateway's `AcquireLockForCreation` filter has already obtained the distributed lock before routing to the orchestrator.

This means: **your PreProcessor additions and modifications happen AFTER gateway injection.** You are working on an already partially-populated payload. You can safely rely on `_kind` being present. You can augment but should not clobber `_createdBy` unless intentionally overriding managed fields.

For a **PostProcessor**, the exchange body is the **EPS response** (the persisted entity JSON, including its `_id` and all managed fields).

---

### Short-Circuiting

A PreProcessor can abort the pipeline before EPS is called by setting the HTTP response code, writing the response body, and calling `exchange.setRouteStop(true)`. When route stop is set, Camel returns the current exchange state to the caller without proceeding to the `toD()` step.

**Complete example — reject if a business rule is violated:**

```java
@ApplicationScoped
public class CreateEntityPreProcessor implements Processor {

    @Inject
    EntityPersistenceClient gatewayClient;

    @Override
    public void process(Exchange exchange) throws Exception {
        String userId = exchange.getIn().getHeader("X-User-Id", String.class);
        String token  = exchange.getIn().getHeader("Authorization", String.class);

        // Count existing active records for this user
        long activeCount = gatewayClient.countEntitiesByOwner(userId, token);

        if (activeCount >= 5) {
            // Short-circuit: do not call EPS
            exchange.getIn().setHeader(Exchange.HTTP_RESPONSE_CODE, 422);
            exchange.getIn().setHeader("Content-Type", "application/json");
            exchange.getIn().setBody(
                "{\"error\":{\"statusCode\":422," +
                "\"message\":\"Maximum of 5 active records allowed per user.\"}}"
            );
            exchange.setRouteStop(true);  // ← stops the Camel route here
        }
    }
}
```

When `setRouteStop(true)` is called, the `toD()` (EPS call) and the PostProcessor are both skipped. The exchange body at the point of stop becomes the HTTP response.

---

### What Happens to the Redis Lock on Short-Circuit

The Gateway acquires a Redis lock **before** routing to the orchestrator, and it releases that lock in a **PostFilter** that runs after the full round-trip completes — regardless of response status. This is a Gateway-level concern, not an orchestrator concern.

When a PreProcessor short-circuits:
- The orchestrator returns an HTTP response (e.g. 422) to the Gateway.
- The Gateway's PostFilter sees the response and **releases the Redis lock** as normal.
- There is **no lock leak**.

You do not need to write any lock-release logic in your processor. The Gateway handles it transparently whether the EPS call happened or not.

---

## Decision Guide: Gateway vs. OPA vs. Orchestrator

Before implementing logic in the orchestrator, check if it can be expressed in a simpler layer:

| Requirement | Where to implement |
|:---|:---|
| JWT validation | Gateway (filter: `AuthenticateRequest`) |
| "Is this user allowed to perform this operation?" | OPA policy |
| "Which fields can this user see/write?" | OPA field policy |
| JSON schema validation on request body | Gateway (per-kind `schema` config) |
| Rate limiting | Gateway (filter: `RequestRateLimiter`) |
| Distributed locking on concurrent writes | Gateway (filter: `AcquireLockForCreation/Update`) |
| Map `/books` → `_kind=book` | Gateway kind alias config |
| Saved query (`?q=my-books`) | Gateway queries config |
| Field set (`?fieldset=summary`) | Gateway fieldsets config |
| Auto-populate `_createdBy` from JWT | Gateway filter: `AddManagedFieldsInCreation` |
| "Max 5 books per user" (simple count limit) | EPS record limits config |
| "Enforce unique book title per author" | EPS uniqueness config |
| Cross-record business rule (requires multiple reads) | **Orchestrator PreProcessor** |
| Compute a derived score field from multiple sub-fields | **Orchestrator PreProcessor** |
| Async side effect after a write | **Orchestrator PostProcessor** |
| Trigger a webhook after record creation | **Orchestrator PostProcessor** |
| Rollback a just-created record if a downstream service fails | **Orchestrator PostProcessor** (call `EntityPersistenceClient.deleteEntity(id)` if 5xx) |
| Prevent users from deleting their last active subscription | OPA policy (preferred for pure authorization) or **Orchestrator PreProcessor** (when logic requires multiple reads or external state) |
| Data aggregation from multiple sources | **Orchestrator PostProcessor** |
| Custom workflow (multi-step orchestration) | **Orchestrator** |
| Complex approval flow with external system | **Orchestrator** |

**Rule of thumb:** If configuration can express it, use configuration. If OPA can express it, use OPA. Only build orchestrator code for logic that genuinely requires a procedural implementation.

---

## EntityPersistenceClient: Calling Back Through the Gateway

The orchestrator includes an `EntityPersistenceClient` — a MicroProfile REST Client pointing to the **Gateway** (not directly to EPS). This is important: when the orchestrator needs to make auxiliary calls to fetch related data, it goes through the Gateway so that authorization, field masking, and OPA policies are applied consistently.

### Full Coverage

The `EntityPersistenceClient` is a full REST client covering **all 67 EPS endpoints** — one method per endpoint. This includes entity CRUD, reactions, lists, aggregations, and all filter/pagination parameters. You do not need to hand-craft HTTP calls; every EPS operation has a typed method on the client.

### Always Forward the Bearer Token

The client calls the Gateway, and the Gateway authenticates every request. **If you call the client without a `Bearer` token, the Gateway will return 401.** Always extract the `Authorization` header from the incoming exchange and forward it.

```java
@ApplicationScoped
public class CreateEntityPostProcessor implements Processor {

    @Inject
    EntityPersistenceClient gatewayClient;

    @Override
    public void process(Exchange exchange) throws Exception {
        // Forward the caller's token to any outbound Gateway call
        String token = exchange.getIn().getHeader("Authorization", String.class);

        // Use the created entity's ID to fetch related entities
        String responseBody = exchange.getIn().getBody(String.class);
        String entityId = JsonPath.read(responseBody, "$._id");

        Response related = gatewayClient.findReactionsByEntityId(entityId, token);
        // ... merge into response
    }
}
```

### Base URL Configuration

The `GATEWAY_BASE_URL` config property sets the base URL the client uses:

| Environment | Value |
|:---|:---|
| Docker Compose | `http://gateway:8081` |
| Kubernetes | `http://gateway-service:8081` |
| Local dev | `http://localhost:8081` |

```properties
# application.properties
gateway.base-url=http://gateway:8081
```

The MicroProfile REST Client picks this up via `@RegisterRestClient(configKey = "gateway")` and the `gateway/mp-rest/url` property.

---

## Topology in Production

### Minimal topology (no orchestrator)

```
Gateway :8081  →  EPS :3000  →  MongoDB
```

### With orchestrator

```
Gateway :8081  →  Orchestrator :8079  →  EPS :3000  →  MongoDB
```

Configure the Gateway to route to the orchestrator:
```yaml
# entity-persistence-gateway application.yml
app:
  backend:
    host: entity-persistence-universal-orchestrator
    port: 8079
```

The orchestrator forwards to EPS:
```properties
# entity-persistence-universal-orchestrator application.properties
backend.base-url=http://entity-persistence-service:3000
gateway.base-url=http://entity-persistence-gateway:8081
```

### Error propagation

If the orchestrator is deployed but a processor has a bug that causes a 5xx, the Gateway receives that 5xx response and propagates it to the client. **EPS is not called if the PreProcessor throws** — the exception is caught by Camel's error handler, which returns the 5xx to the Gateway. This makes orchestrator bugs observable through normal Gateway error responses; nothing is silently swallowed.

### Advanced topology: selective orchestration

The orchestrator, once deployed, handles **all routes** that the Gateway sends to it. There is no built-in mechanism to tell the orchestrator to intercept only certain routes — every EPS path is wired with a Camel route in the template.

If you need orchestration for only a **subset of routes** (e.g. `POST /entities` but not `GET /entities`), your options are:
1. Implement the relevant processors and leave all others as empty pass-throughs (zero overhead, recommended).
2. For a more extreme case — different teams owning different route groups with completely separate deployments — deploy **multiple Gateway instances**, one pointing to the orchestrator (for orchestrated routes) and one pointing directly to EPS (for bypass routes), with routing differentiated at the load balancer or ingress level.

Option 2 is an advanced pattern and adds significant operational complexity. Prefer option 1 in almost all cases.

---

## Cloning and Extending

1. **Clone** the template:
   ```bash
   git clone https://github.com/tarcinapp/entity-persistence-universal-orchestrator my-app-orchestrator
   cd my-app-orchestrator
   ```

2. **Rename** the artifact in `pom.xml`:
   ```xml
   <artifactId>my-app-orchestrator</artifactId>
   <name>my-app-orchestrator</name>
   ```

3. **Update** `application.properties`:
   ```properties
   backend.base-url=http://entity-persistence-service:3000
   gateway.base-url=http://entity-persistence-gateway:8081
   ```

4. **Implement** business logic in the relevant Pre/Post-Processor class:
   ```java
   // src/main/java/io/tarcinapp/orchestrator/processors/entities/CreateEntityPreProcessor.java
   @ApplicationScoped
   public class CreateEntityPreProcessor implements Processor {
       @Override
       public void process(Exchange exchange) throws Exception {
           String body = exchange.getIn().getBody(String.class);
           // Parse, modify, validate, enrich...
           exchange.getIn().setBody(modifiedBody);
       }
   }
   ```

4.5. **CDI scan** — Quarkus Arc auto-discovers `@ApplicationScoped` beans in all packages under the root package. If you add processors in a new sub-package (e.g. `io.tarcinapp.orchestrator.processors.custom`), they are picked up automatically. You only need to register the package explicitly if you move outside the root package or use a non-standard project layout.

5. **Selective implementation** — you only need to add logic to the processors that matter for your use case. If you only need custom behavior on entity creation, only implement `CreateEntityPreProcessor` and `CreateEntityPostProcessor`. All other processor classes have **empty bodies** and are **transparent pass-throughs with zero overhead**. There is no penalty for leaving processors unimplemented.

6. **Leave untouched** all Pre/Post-Processor classes for endpoints you don't need to customize.

---

## Processor Context: What You Have Access To

Inside a Camel Processor, the Exchange exposes:

```java
// Original request body (JSON string)
String body = exchange.getIn().getBody(String.class);

// HTTP headers (including Gateway-injected headers)
String userId    = exchange.getIn().getHeader("X-User-Id",       String.class);
String requestId = exchange.getIn().getHeader("X-Request-Id",    String.class);
String roles     = exchange.getIn().getHeader("X-User-Roles",    String.class);
String groups    = exchange.getIn().getHeader("X-User-Groups",   String.class);
String shortcode = exchange.getIn().getHeader("X-App-Shortcode", String.class);

// Bearer token (forward to any outbound client call)
String token = exchange.getIn().getHeader("Authorization", String.class);

// Query parameters (on PreProcessor)
String kind = exchange.getIn().getHeader("filter[where][_kind]", String.class);

// HTTP method and path
String method = exchange.getIn().getHeader(Exchange.HTTP_METHOD, String.class);
String path   = exchange.getIn().getHeader(Exchange.HTTP_PATH,   String.class);

// Modify body
exchange.getIn().setBody("{\"_name\":\"Modified\"}");

// Short-circuit with an error (prevents EPS call)
exchange.getIn().setHeader(Exchange.HTTP_RESPONSE_CODE, 422);
exchange.getIn().setHeader("Content-Type", "application/json");
exchange.getIn().setBody("{\"error\":{\"message\":\"Custom validation failed\"}}");
exchange.setRouteStop(true);
```

---

## Common Patterns Cookbook

The following patterns cover the most frequently encountered orchestration scenarios. Each entry includes: the problem statement, the processor type, the key Camel/Java techniques used, and a code sketch.

---

### Pattern 1 — Auto-Enrich from External Service (fetch + inject)

**Problem:** Before persisting an entity, you need to resolve a human-readable label (e.g. `categoryName`) from an external taxonomy service using a code already present in the payload.

**Processor type:** PreProcessor

**Key techniques:** Jackson `ObjectMapper`, outbound HTTP via `OkHttpClient` or `RestTemplate`, mutate body before forwarding.

```java
@Override
public void process(Exchange exchange) throws Exception {
    String token = exchange.getIn().getHeader("Authorization", String.class);
    ObjectMapper mapper = new ObjectMapper();
    JsonNode body = mapper.readTree(exchange.getIn().getBody(String.class));

    String categoryCode = body.path("categoryCode").asText();
    // Call external taxonomy service (or back through Gateway)
    String categoryName = taxonomyClient.resolveName(categoryCode, token);

    ((ObjectNode) body).put("categoryName", categoryName);
    exchange.getIn().setBody(mapper.writeValueAsString(body));
}
```

---

### Pattern 2 — Cross-Record Quota Enforcement (count + reject)

**Problem:** A user may not create more than N records of a given kind. The limit is not a simple static config — it depends on the user's subscription tier stored in another entity.

**Processor type:** PreProcessor

**Key techniques:** `EntityPersistenceClient.countEntities(filter, token)`, short-circuit with `setRouteStop(true)`.

```java
@Override
public void process(Exchange exchange) throws Exception {
    String userId = exchange.getIn().getHeader("X-User-Id", String.class);
    String token  = exchange.getIn().getHeader("Authorization", String.class);

    int tier  = gatewayClient.getUserSubscriptionTier(userId, token); // e.g. returns 1, 2, or 3
    int limit = tier * 10;  // tier 1 → 10 records, tier 2 → 20, tier 3 → 30
    long count = gatewayClient.countEntitiesByOwner(userId, token);

    if (count >= limit) {
        exchange.getIn().setHeader(Exchange.HTTP_RESPONSE_CODE, 422);
        exchange.getIn().setHeader("Content-Type", "application/json");
        exchange.getIn().setBody("{\"error\":{\"statusCode\":422,"
            + "\"message\":\"Quota exceeded for your subscription tier.\"}}");
        exchange.setRouteStop(true);
    }
}
```

---

### Pattern 3 — Async Notification (post-success event publish)

**Problem:** After an entity is successfully created, publish a domain event to a message broker (e.g. Kafka/Redpanda) for downstream consumers.

**Processor type:** PostProcessor

**Key techniques:** Check response status before acting, inject `KafkaProducer` or use Camel's Kafka component, extract `_id` from EPS response.

```java
@Inject
KafkaProducer<String, String> producer;

@Override
public void process(Exchange exchange) throws Exception {
    int statusCode = exchange.getIn().getHeader(
        Exchange.HTTP_RESPONSE_CODE, Integer.class);

    if (statusCode == 200 || statusCode == 201) {
        String responseBody = exchange.getIn().getBody(String.class);
        String entityId = JsonPath.read(responseBody, "$._id");
        String kind     = JsonPath.read(responseBody, "$._kind");

        producer.send(new ProducerRecord<>(
            "entity.created." + kind, entityId, responseBody));
    }
    // Body is not modified — response passes through unchanged
}
```

---

### Pattern 4 — Response Aggregation (multiple EPS calls merged)

**Problem:** The caller needs both the entity and its associated reactions in a single response. EPS does not support this natively in one call.

**Processor type:** PostProcessor

**Key techniques:** Parse EPS response, call `EntityPersistenceClient` for reactions, merge into a new JSON object, write back to body.

```java
@Override
public void process(Exchange exchange) throws Exception {
    String token        = exchange.getIn().getHeader("Authorization", String.class);
    String responseBody = exchange.getIn().getBody(String.class);
    ObjectMapper mapper = new ObjectMapper();
    ObjectNode entity   = (ObjectNode) mapper.readTree(responseBody);

    String entityId  = entity.path("_id").asText();
    String reactions = gatewayClient.findReactionsByEntityId(entityId, token)
                                    .readEntity(String.class);

    entity.set("_reactions", mapper.readTree(reactions));
    exchange.getIn().setBody(mapper.writeValueAsString(entity));
}
```

---

### Pattern 5 — Cascade Soft-Delete (on entity delete, also soft-delete related reactions)

**Problem:** When an entity is soft-deleted (PATCH `_validUntil`), all reactions that reference it should also be soft-deleted to maintain referential consistency.

**Processor type:** PostProcessor (on the PATCH/delete endpoint)

**Key techniques:** Check that the request was a soft-delete (presence of `_validUntil` in patch body), call `EntityPersistenceClient.patchReactionsByEntityId(...)` with the same `_validUntil` timestamp.

```java
@Override
public void process(Exchange exchange) throws Exception {
    String token        = exchange.getIn().getHeader("Authorization", String.class);
    String responseBody = exchange.getIn().getBody(String.class);
    ObjectMapper mapper = new ObjectMapper();
    JsonNode entity     = mapper.readTree(responseBody);

    // Only cascade if this was a soft-delete (validUntil is now set)
    if (entity.has("_validUntil") && !entity.path("_validUntil").isNull()) {
        String entityId    = entity.path("_id").asText();
        String validUntil  = entity.path("_validUntil").asText();
        String patchPayload = "{\"_validUntil\":\"" + validUntil + "\"}";

        gatewayClient.patchReactionsByEntityId(entityId, patchPayload, token);
    }
    // Original response passes through unchanged
}
```

---

## Other Orchestration Components (Planned)

Beyond the universal orchestrator template, the Tarcinapp architecture defines several specialized orchestrators. These are part of the full platform vision but **do not yet exist as separate repositories**. They will each follow the same Camel Quarkus pattern as `entity-persistence-universal-orchestrator`.

| Component | Type | Status | Purpose |
|:---|:---|:---|:---|
| `entity-persistence-bff-orchestrator` | Camel Quarkus | 🔲 Planned | Page aggregator for SSR UIs. Combines multiple EPS/Gateway calls into a single page-ready response. |
| `entity-search-indexer` | Camel Quarkus | 🔲 Planned | Consumes CDC events from Redpanda and writes to Meilisearch indexes. |
| `entity-s3-orchestrator` | Camel Quarkus | 🔲 Planned | Handles S3-compatible object storage operations. |
| `entity-event-transformer` | Camel Quarkus | 🔲 Planned | Converts raw Debezium CDC events into domain events. |
| `entity-event-consumer` | Camel Quarkus | 🔲 Planned | Consumes domain events and triggers reactions by calling the Gateway. |

The `entity-persistence-universal-orchestrator` repository is the template from which all of these will be derived.

---

## Related Documents
- `13_COMPONENT_universal-orchestrator.md` — Orchestrator code structure and config reference
- `11_COMPONENT_entity-persistence-gateway.md` — How the gateway routes to the orchestrator
- `42_EXAMPLE_custom-business-logic.md` — Step-by-step implementation example
