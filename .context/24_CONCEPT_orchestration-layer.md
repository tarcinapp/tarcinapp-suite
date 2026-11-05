# 24_CONCEPT_orchestration-layer.md

## Overview

The Orchestration Layer is the designated location for custom business logic in the Tarcinapp suite. It is entirely optional — the system works without it. You add it when you need behavior that cannot be expressed through gateway configuration or OPA policies.

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
| Async side effect after a write | **Orchestrator PostProcessor** |
| Data aggregation from multiple sources | **Orchestrator PostProcessor** |
| Custom workflow (multi-step orchestration) | **Orchestrator** |
| Complex approval flow with external system | **Orchestrator** |

**Rule of thumb:** If configuration can express it, use configuration. If OPA can express it, use OPA. Only build orchestrator code for logic that genuinely requires a procedural implementation.

---

## EntityPersistenceClient: Calling Back Through the Gateway

The orchestrator includes a `EntityPersistenceClient` — a MicroProfile REST Client pointing to the **Gateway** (not directly to EPS). This is important: when the orchestrator needs to make auxiliary calls to fetch related data, it should go through the Gateway so that authorization and field masking are applied.

```java
@Inject
EntityPersistenceClient gatewayClient;

// In a PreProcessor:
Response existingEntity = gatewayClient.findEntityById(entityId, bearerToken, ...);
```

The `bearerToken` is the caller's original JWT, forwarded through the orchestration call to maintain the authorization context.

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
```

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

5. **Leave untouched** all Pre/Post-Processor classes for endpoints you don't need to customize — they are transparent pass-throughs.

---

## Processor Context: What You Have Access To

Inside a Camel Processor, the Exchange exposes:

```java
// Original request body (JSON string)
String body = exchange.getIn().getBody(String.class);

// HTTP headers (including Gateway-injected headers)
String userId = exchange.getIn().getHeader("X-User-Id", String.class);
String requestId = exchange.getIn().getHeader("X-Request-Id", String.class);

// Query parameters (on PreProcessor)
String kind = exchange.getIn().getHeader("filter[where][_kind]", String.class);

// HTTP method and path
String method = exchange.getIn().getHeader(Exchange.HTTP_METHOD, String.class);
String path = exchange.getIn().getHeader(Exchange.HTTP_PATH, String.class);

// Modify body
exchange.getIn().setBody("{\"_name\":\"Modified\"}");

// Short-circuit with an error (prevents EPS call)
exchange.getIn().setHeader(Exchange.HTTP_RESPONSE_CODE, 422);
exchange.getIn().setBody("{\"error\":{\"message\":\"Custom validation failed\"}}");
exchange.setRouteStop(true);
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
