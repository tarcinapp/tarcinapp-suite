# 13_COMPONENT_universal-orchestrator.md

## Component Identity

**Repository:** `entity-persistence-universal-orchestrator`  
**Technology:** Java 17 · Quarkus 3.15.3 · Apache Camel (camel-quarkus)  
**Layer:** IV — Orchestration  
**Default port:** `8079`  
**Source of truth for its own docs:** [`entity-persistence-universal-orchestrator/pom.xml`](../../entity-persistence-universal-orchestrator/pom.xml), [`src/`](../../entity-persistence-universal-orchestrator/src/)

---

## What It Is

`entity-persistence-universal-orchestrator` is the **designated code extension point** of the Tarcinapp suite. It sits between the Gateway and `entity-persistence-service` and intercepts every request/response to allow custom pre-processing and post-processing logic.

This component is a **template / blueprint** — you clone it and extend it for your specific product. It ships with stub pre- and post-processor classes for every one of the EPS endpoints (74 processor classes across 37 operations), all wired into Apache Camel routes. You implement business logic by filling in those stubs. Unimplemented stubs are zero-overhead pass-throughs — you only add code where your product actually needs it.

> **When to deploy it:** Simple deployments that rely purely on configuration (kind aliases, JSON schema validation, record limits, OPA rules) do not need the orchestrator in the topology. Add it when your product requires cross-record enrichment, external integrations, complex conditional flows, or async side effects — anything that genuinely requires procedural code. The framework is designed to make this a clear, low-friction step, not a last resort.

---

## Technology Stack

| Component | Detail |
|:---|:---|
| Runtime | Java 17 |
| Platform | Quarkus 3.15.3 (CDI, reactive) |
| Routing | Apache Camel (`camel-quarkus-platform-http`, `camel-quarkus-http`) |
| HTTP Client | MP REST Client (`quarkus-rest-client-reactive`) |
| Tracing | OpenTelemetry (`camel-quarkus-opentelemetry`, `quarkus-opentelemetry`) |

---

## Architecture: The Pre/Post-Processor Pipeline

Every EPS endpoint has exactly three components in the orchestrator:

```
Gateway Request
      │
      ▼
┌─────────────────────────┐
│   RouteBuilder           │  ← defines the Camel route
│   (e.g. CreateEntityRoute)│    from("platform-http:/entities POST")
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│   PreProcessor           │  ← runs BEFORE the backend call
│   (CreateEntityPreProc)  │    can modify request body, headers, query params
│                          │    can short-circuit with an error response
└────────────┬────────────┘
             │
     [if NOT short-circuited]
             │
             ▼
  [proxy to entity-persistence-service]
  (hop-by-hop headers stripped;
   4xx/5xx passed through transparently)
             │
             ▼
┌─────────────────────────┐
│   PostProcessor          │  ← runs AFTER the backend response
│   (CreateEntityPostProc) │    can modify response body, enrich data, trigger side effects
└────────────┬────────────┘
             │
             ▼
Gateway Response (returned to caller)
```

The short-circuit mechanism is implemented directly in the `RouteBuilder` using a Camel `choice()` block that checks the exchange property `CamelRouteStop`. If the PreProcessor sets this property to `Boolean.TRUE`, the backend call and PostProcessor are both skipped.

### RouteBuilder
Each `Route.java` class extends `RouteBuilder` and defines:
- The Camel `from()` endpoint (a `platform-http` listener matching the EPS path and method)
- The pre-processor CDI bean call (injected via `@Inject`)
- A `choice()` that checks `CamelRouteStop` for short-circuit
- The `toD()` call proxying the request to the backend (`backend.base-url`), with `bridgeEndpoint=true&throwExceptionOnFailure=false`
- The post-processor CDI bean call

The `throwExceptionOnFailure=false` option is important: it means 4xx and 5xx responses from EPS are delivered to the PostProcessor normally instead of raising a `CamelHttpOperationFailedException`. Hop-by-hop headers (`Content-Length`, `Transfer-Encoding`) are stripped before the backend call to avoid HTTP/1.1 framing issues.

### PreProcessor
Runs before the request reaches EPS. Can:
- Modify request body (add/remove fields)
- Add/modify headers
- Rewrite query parameters
- Short-circuit with an error response (validation, quota check)
- Make auxiliary calls back through the Gateway via `EntityPersistenceClient`

### PostProcessor
Runs after EPS responds. Can:
- Enrich the response (add computed fields, resolve references)
- Trigger async side effects (push a message, update a counter)
- Log or audit the operation
- Transform the response shape for the client

---

## Code Structure

```
src/main/java/io/tarcinapp/orchestrator/
├── BackendStartupCheck.java         ← probes EPS at startup; aborts if unreachable
├── CamelPlatformHttpConfig.java     ← configures the Camel platform-http component
├── gateway/
│   └── EntityPersistenceClient.java ← MP REST Client interface for calling back through Gateway
├── routes/
│   ├── entities/                    ← 16 RouteBuilder classes (one per entity endpoint)
│   ├── lists/                       ← 19 RouteBuilder classes
│   ├── relations/                   ← 8 RouteBuilder classes
│   ├── entityreactions/             ← 11 RouteBuilder classes
│   ├── listreactions/               ← 11 RouteBuilder classes
│   └── system/                      ← 3 routes: PingRoute, GetOpenApiJsonRoute, GetSystemInfoRoute
└── processors/
    ├── entities/                    ← 32 processor classes (16 Pre + 16 Post)
    ├── lists/                       ← 38 processor classes (19 Pre + 19 Post)
    ├── relations/                   ← 16 processor classes (8 Pre + 8 Post)
    ├── entityreactions/             ← 22 processor classes (11 Pre + 11 Post)
    ├── listreactions/               ← 22 processor classes (11 Pre + 11 Post)
    └── system/
```

### Verified Route Counts (from directory listing)

The orchestrator exposes **68 Camel routes** in total: it mirrors all **67 EPS endpoints** (adding a pass-through for `/openapi.json` that EPS itself does not serve) plus a `/system-info` proxy. The **65 domain routes** each have a Pre/Post-processor pair; the 3 system routes (`ping`, `openapi`, `system-info`) pass through without custom processor logic.

| Resource group | Route classes | Processor pairs | Operations covered |
|:---|:---:|:---:|:---|
| `entities/` | 16 | 16 | countEntities, findEntities, createEntity, updateEntities, findEntityById, replaceEntityById, updateEntityById, deleteEntityById, createChildEntity, findChildrenByEntityId, findListsByEntityId, findParentsByEntityId, createReactionByEntityId, findReactionsByEntityId, updateReactionsByEntityId, deleteReactionsByEntityId |
| `lists/` | 19 | 19 | countLists, findLists, createList, updateLists, findListById, replaceListById, updateListById, deleteListById, createChildList, findChildrenByListId, findParentsByListId, createEntityByListId, findEntitiesByListId, updateEntitiesByListId, deleteEntitiesByListId, createReactionByListId, findReactionsByListId, updateReactionsByListId, deleteReactionsByListId |
| `relations/` | 8 | 8 | countRelations, findRelations, createRelation, updateRelations, findRelationById, replaceRelationById, updateRelationById, deleteRelationById |
| `entityreactions/` | 11 | 11 | countEntityReactions, findEntityReactions, createEntityReaction, updateEntityReactions, findEntityReactionById, replaceEntityReactionById, updateEntityReactionById, deleteEntityReactionById, createChildEntityReaction, findChildrenByEntityReactionId, findParentsByEntityReactionId |
| `listreactions/` | 11 | 11 | countListReactions, findListReactions, createListReaction, updateListReactions, findListReactionById, replaceListReactionById, updateListReactionById, deleteListReactionById, createChildListReaction, findChildrenByListReactionId, findParentsByListReactionId |
| `system/` | 3 | — | ping, getOpenApiJson, getSystemInfo |
| **Total (orchestrator routes)** | **68** | **65** | 67 EPS endpoints + 1 openapi pass-through |

---

## Actual Route Structure: `CreateEntityRoute.java`

The real route implementation (not a simplified stub) uses CDI injection and a `choice()` block:

```java
@ApplicationScoped
public class CreateEntityRoute extends RouteBuilder {

    @Inject
    CreateEntityPreProcessor preProcessor;

    @Inject
    CreateEntityPostProcessor postProcessor;

    @Override
    public void configure() {
        from("platform-http:/entities?httpMethodRestrict=POST")
            .routeId("createEntity")
            .process(preProcessor)
            .choice()
                .when(exchangeProperty("CamelRouteStop").isEqualTo(Boolean.TRUE))
                    .log("Route ${routeId} short-circuited by pre-processor — skipping backend and post-processor")
                .otherwise()
                    // Strip hop-by-hop headers that must not be forwarded
                    .removeHeader("Content-Length")
                    .removeHeader("Transfer-Encoding")
                    // bridgeEndpoint=true forwards the original URI query string.
                    // throwExceptionOnFailure=false passes 4xx/5xx responses through
                    // to the PostProcessor instead of raising CamelHttpOperationFailedException.
                    .toD("{{backend.base-url}}/entities?bridgeEndpoint=true&throwExceptionOnFailure=false")
                    .process(postProcessor)
            .end();
    }
}
```

Key points:
- Processors are CDI beans injected with `@Inject` (not instantiated with `new`), so they can themselves use `@Inject` for other CDI beans.
- The `routeId("createEntity")` matches the EPS `operationId` — useful for Camel metrics and log correlation.
- `bridgeEndpoint=true` prevents Camel from rewriting the URL; the original path and query string are forwarded as-is.

---

## What Headers the Gateway Injects

Before a request reaches the orchestrator, the Gateway has already processed the JWT and enriched the request with headers that identify the caller. These headers are available on `exchange.getIn()` in every PreProcessor and PostProcessor.

| Header | Source | Description |
|:---|:---|:---|
| `X-User-Id` | JWT `sub` claim | The authenticated user's subject identifier (e.g., `user-42`). `null` if unauthenticated (anonymous request). |
| `X-Request-Id` | Gateway `GenerateRequestId` filter | Composite request ID in the format `APP-{authParty}-{timestamp}-{random}` (e.g., `BOOKS-USER42-20260203091534-A7K9M`). Useful for log correlation. |
| `X-User-Roles` | JWT `roles` claim | Comma-separated list of role strings extracted from the JWT (e.g., `tarcinapp.admin,tarcinapp.editor`). |
| `X-User-Groups` | JWT `groups` claim | Comma-separated list of group strings extracted from the JWT. Used by audience-based visibility rules. |
| `X-App-Shortcode` | Gateway configuration | Short identifier for the application (e.g., `BOOKS`). Matches `app.shortCode` in the Gateway config. Used in request ID generation and multi-tenancy scenarios. |

These headers are forwarded by the Gateway's proxy step to the orchestrator and are already present on the incoming `Exchange` when your processor runs. They are also forwarded to EPS in the backend call (the orchestrator does not strip them).

**Reading headers in a processor:**
```java
String userId    = exchange.getIn().getHeader("X-User-Id",     String.class);
String requestId = exchange.getIn().getHeader("X-Request-Id",  String.class);
String roles     = exchange.getIn().getHeader("X-User-Roles",  String.class);
String groups    = exchange.getIn().getHeader("X-User-Groups", String.class);
String appCode   = exchange.getIn().getHeader("X-App-Shortcode", String.class);
```

---

## PreProcessor Example: Header-Aware Body Modification

The following example shows a `CreateEntityPreProcessor` that reads the caller's user ID from the gateway-injected header and conditionally adds a field to the request body:

```java
@ApplicationScoped
public class CreateEntityPreProcessor implements Processor {

    @Inject
    @RestClient
    EntityPersistenceClient gatewayClient;

    @Override
    public void process(Exchange exchange) throws Exception {
        // Read the caller identity injected by the Gateway
        String userId = exchange.getIn().getHeader("X-User-Id", String.class);
        String roles  = exchange.getIn().getHeader("X-User-Roles", String.class);

        // Parse the incoming JSON body
        String bodyStr = exchange.getIn().getBody(String.class);
        // (use your preferred JSON library — Jackson, JSON-B, jakarta.json, etc.)
        // ObjectMapper mapper = new ObjectMapper();
        // Map<String, Object> body = mapper.readValue(bodyStr, new TypeReference<>(){});

        // Example: inject a custom field based on the user's role
        if (roles != null && roles.contains("premium-seller")) {
            // body.put("_featuredListingEligible", true);
            // exchange.getIn().setBody(mapper.writeValueAsString(body));
        }

        // Example: enforce a business rule — quota check
        // Response existing = gatewayClient.findEntities(null,
        //     "{\"where\":{\"_createdBy\":\"" + userId + "\",\"_kind\":\"product\"}}");
        // int count = parseCount(existing);
        // if (count >= 50) {
        //     exchange.getIn().setHeader(Exchange.HTTP_RESPONSE_CODE, 422);
        //     exchange.getIn().setBody("{\"error\":{\"message\":\"Quota exceeded: max 50 products\"}}");
        //     exchange.setProperty("CamelRouteStop", Boolean.TRUE);
        //     return;
        // }
    }
}
```

---

## Error Handling and Short-Circuiting

To reject a request from a PreProcessor (skip the backend call and return immediately to the caller), set three things on the exchange:

```java
@Override
public void process(Exchange exchange) throws Exception {
    String userId = exchange.getIn().getHeader("X-User-Id", String.class);

    if (userId == null) {
        // 1. Set the HTTP response code
        exchange.getIn().setHeader(Exchange.HTTP_RESPONSE_CODE, 401);

        // 2. Set the response body
        exchange.getIn().setBody(
            "{\"error\":{\"statusCode\":401,\"message\":\"Authentication required\"}}"
        );

        // 3. Signal the route to stop (skips backend call AND PostProcessor)
        exchange.setProperty("CamelRouteStop", Boolean.TRUE);
        return;
    }

    // ... normal pre-processing continues
}
```

The route's `choice()` block (in the RouteBuilder) checks `exchangeProperty("CamelRouteStop").isEqualTo(Boolean.TRUE)` and branches to a short-circuit log step instead of calling the backend. This is the only supported short-circuit mechanism — do not throw exceptions, as Camel's exception handling will produce a different response shape.

**Common short-circuit status codes:**

| Scenario | HTTP code |
|:---|:---:|
| Custom validation failure | `422` |
| Business rule violation (quota, state) | `409` |
| Permission denied (supplement to OPA) | `403` |
| Unauthenticated (missing header) | `401` |
| Pre-computed result (cache hit) | `200` |

---

## PostProcessor Example: Response Enrichment

A PostProcessor receives the EPS response on the exchange. The response body and status code are available via `exchange.getMessage()` (note: use `getMessage()` not `getIn()` for the post-backend state):

```java
@ApplicationScoped
public class CreateEntityPostProcessor implements Processor {

    @Inject
    @RestClient
    EntityPersistenceClient gatewayClient;

    @Override
    public void process(Exchange exchange) throws Exception {
        // Read the EPS response
        int statusCode = exchange.getMessage()
            .getHeader(Exchange.HTTP_RESPONSE_CODE, Integer.class);
        String responseBody = exchange.getMessage().getBody(String.class);

        // Only enrich on success
        if (statusCode == 201) {
            // Example: parse the created entity's ID and fetch a related record
            // ObjectMapper mapper = new ObjectMapper();
            // Map<String, Object> entity = mapper.readValue(responseBody, new TypeReference<>(){});
            // String entityId = (String) entity.get("id");

            // Fetch related data via the gateway (goes through full auth stack)
            // Response related = gatewayClient.findListsByEntityId(entityId, null, null, null, null);
            // entity.put("_memberOfLists", parseBodyAsList(related));

            // Write the enriched body back
            // exchange.getMessage().setBody(mapper.writeValueAsString(entity));
        }
    }
}
```

---

## Async Side Effects Pattern

To fire-and-forget a notification or trigger a side effect without blocking the response, inject a CDI bean that runs the work asynchronously. The key constraint is that the PostProcessor must return quickly — do not make synchronous blocking calls to slow external services inside `process()`.

```java
@ApplicationScoped
public class CreateEntityPostProcessor implements Processor {

    @Inject
    NotificationService notificationService;  // your CDI @ApplicationScoped bean

    @Override
    public void process(Exchange exchange) throws Exception {
        int statusCode = exchange.getMessage()
            .getHeader(Exchange.HTTP_RESPONSE_CODE, Integer.class);

        if (statusCode == 201) {
            String body = exchange.getMessage().getBody(String.class);
            String userId = exchange.getIn().getHeader("X-User-Id", String.class);

            // Fire-and-forget: schedule async work without waiting for completion
            // NotificationService is a @ApplicationScoped bean with @Asynchronous methods (CDI/Quarkus)
            // notificationService.sendCreationNotificationAsync(userId, body);
        }
    }
}
```

**Using Camel `ProducerTemplate` for async messaging:**
```java
@Inject
ProducerTemplate producerTemplate;

// Sends to a Camel endpoint asynchronously (e.g., a Kafka or AMQP route)
// producerTemplate.asyncSendBody("direct:notify-creation", body);
```

The `ProducerTemplate` approach is preferred when you have a dedicated Camel route for the side effect, because it keeps the processor decoupled from the delivery mechanism and benefits from Camel's error handling and retry policies on that route.

---

## EntityPersistenceClient

The `EntityPersistenceClient` is a MicroProfile REST Client interface that processors can inject to make calls to the Tarcinapp stack from within their logic.

### ⚠️ It calls BACK to the Gateway, not directly to EPS

```
Your Processor
    │
    │  EntityPersistenceClient.findEntities(...)
    ▼
Gateway :8081  ←── full auth + authz + field masking apply here
    │
    ▼
EPS :3000
```

This is intentional and important: because the client calls the Gateway (not EPS directly), **all Gateway authorization rules, field masking, set-based visibility filters, and OPA policies apply to those calls**. The processor's calls are subject to the same security rules as any other client. There is no "backdoor" to EPS from within the orchestrator.

This means:
- Calls made via `EntityPersistenceClient` require a valid authorization context. The gateway-injected headers (`X-User-Id`, `X-User-Roles`, etc.) are not automatically propagated to the client — you must forward them explicitly if the call needs to run in the caller's security context.
- If you need a privileged (admin-level) call from within a processor, configure a separate service account token or use a dedicated Gateway route that accepts an internal API key.

**Configuration:**
```properties
# application.properties
quarkus.rest-client."entity-persistence-gateway".url=${GATEWAY_BASE_URL:${gateway.base-url}}
quarkus.rest-client."entity-persistence-gateway".scope=jakarta.inject.Singleton
quarkus.rest-client."entity-persistence-gateway".connect-timeout=5000
quarkus.rest-client."entity-persistence-gateway".read-timeout=30000
```

**Injection in processors:**
```java
@Inject
@RestClient
EntityPersistenceClient gatewayClient;
```

The client mirrors every EPS endpoint. Example signatures:
```java
Response findEntities(@QueryParam("set") String set, @QueryParam("filter") String filter);
Response createEntity(Object body);
Response findEntityById(@PathParam("id") String id, @QueryParam("filter") String filter);
Response findListsByEntityId(@PathParam("id") String id,
    @QueryParam("set") String set, @QueryParam("filter") String filter,
    @QueryParam("setThrough") String setThrough, @QueryParam("filterThrough") String filterThrough);
// ... one method per EPS endpoint
```

Query parameters that accept LoopBack filter/where objects are typed as `String` and must be JSON-serialized by the caller. All methods return `jakarta.ws.rs.core.Response` so callers can inspect the status code, headers, and body.

---

## Health and Readiness Probes

### Quarkus Managed Endpoints

The orchestrator exposes the standard Quarkus SmallRye Health endpoints:

| Path | Purpose |
|:---|:---|
| `GET /q/health` | Combined liveness + readiness summary |
| `GET /q/health/live` | Liveness probe — is the JVM/Camel context alive? |
| `GET /q/health/ready` | Readiness probe — is the app ready to serve traffic? |

These are automatically provided by `quarkus-smallrye-health` and include Camel context health, CDI context health, and any custom checks.

### `BackendStartupCheck.java`

In addition to the Quarkus health probes (which run continuously), the orchestrator performs a **startup-time reachability check** of the EPS backend implemented in `BackendStartupCheck.java`. This check runs once via a CDI `@Observes StartupEvent` and **aborts the JVM startup** if EPS is unreachable.

It probes two paths sequentially:
1. `GET {backend.base-url}/ping` — verifies the EPS process is alive
2. `GET {backend.base-url}/openapi.json` — verifies the EPS API is initialized

If either probe returns HTTP 5xx or throws a connection exception within the configured timeout, a `RuntimeException` is thrown, causing Quarkus to abort startup with a clear error message in the logs.

**Configuration:**
```properties
backend.health-check.enabled=true              # set false to skip (useful in tests)
backend.health-check.path=/ping                # primary probe path
backend.health-check.openapi-path=/openapi.json  # secondary probe path
backend.health-check.timeout-seconds=10        # connect + read timeout per probe
```

This means the orchestrator **will not start** if EPS is not running, which makes container health checks simpler (if the orchestrator pod is Running, EPS is known to be reachable).

---

## OpenTelemetry Trace Propagation

Every Camel Exchange is automatically instrumented with an OpenTelemetry span (`camel-quarkus-opentelemetry`). The following propagation formats are enabled by default:

```properties
quarkus.otel.propagators=tracecontext,baggage,b3,b3multi
```

### Headers propagated on inbound requests (from Gateway)

| Header | Format | Description |
|:---|:---|:---|
| `traceparent` | W3C TraceContext | Primary trace + span ID in W3C format: `00-{traceId}-{spanId}-{flags}` |
| `tracestate` | W3C TraceContext | Vendor-specific trace state key-value pairs |
| `b3` | B3 single-header | Combined trace ID, span ID, and sampling flag in one header |
| `X-B3-TraceId` | B3 multi-header | 64-bit or 128-bit trace ID |
| `X-B3-SpanId` | B3 multi-header | 64-bit parent span ID |
| `X-B3-Sampled` | B3 multi-header | Sampling decision (`0` or `1`) |
| `X-B3-ParentSpanId` | B3 multi-header | Parent span ID for hierarchical tracing |
| `baggage` | W3C Baggage | Key-value propagation (e.g., correlation IDs, feature flags) |

### How the chain links in your APM

```
Client
  │  traceparent: 00-abc123-span1-01
  ▼
Gateway :8081          ← creates child span, propagates traceparent + b3
  │  traceparent: 00-abc123-span2-01
  ▼
Orchestrator :8079     ← creates child span (Camel auto-instrumentation)
  │  traceparent: 00-abc123-span3-01
  ▼
EPS :3000              ← creates child span
  │  traceparent: 00-abc123-span4-01
  ▼
MongoDB
```

All spans share `traceId = abc123`, so a single APM query by trace ID shows the complete request chain across all four services. The Camel context name (`entity-persistence-orchestrator`) and service name (`entity-persistence-universal-orchestrator`) are reported as `service.name` and `camel.context.name` resource attributes on every span.

**OutboundOtel for `EntityPersistenceClient`:** The Quarkus OpenTelemetry extension automatically instruments the MicroProfile REST Client, so calls made from processors via `EntityPersistenceClient` also carry the current span context. The Gateway will see these as a child span of the current orchestrator span, correctly linking the full call tree in your APM.

---

## Configuration Reference

All keys can be overridden via environment variables using the MicroProfile Config convention: `property.key` → `PROPERTY_KEY` (dots and hyphens → underscores, upper-cased).

| Property | Env var override | Default | Description |
|:---|:---|:---|:---|
| `quarkus.http.port` | `QUARKUS_HTTP_PORT` | `8079` | Orchestrator HTTP listen port |
| `backend.base-url` | `BACKEND_BASE_URL` | `http://localhost:3000` | EPS URL (direct, bypasses gateway) — no trailing slash |
| `gateway.base-url` | `GATEWAY_BASE_URL` | `http://localhost:8081` | Gateway URL used by `EntityPersistenceClient` — no trailing slash |
| `backend.health-check.enabled` | `BACKEND_HEALTH_CHECK_ENABLED` | `true` | Probe EPS at startup |
| `backend.health-check.path` | `BACKEND_HEALTH_CHECK_PATH` | `/ping` | Primary probe path on EPS |
| `backend.health-check.openapi-path` | `BACKEND_HEALTH_CHECK_OPENAPI_PATH` | `/openapi.json` | Secondary probe path on EPS |
| `backend.health-check.timeout-seconds` | `BACKEND_HEALTH_CHECK_TIMEOUT_SECONDS` | `10` | Startup probe timeout (seconds) |
| `camel.context.name` | — | `entity-persistence-orchestrator` | Camel context name (shown in metrics/logs) |
| `camel.component.http.connect-timeout` | — | `5000` | Backend HTTP connect timeout (ms) |
| `camel.component.http.so-timeout` | — | `30000` | Backend HTTP read timeout (ms) |
| `quarkus.rest-client."entity-persistence-gateway".connect-timeout` | — | `5000` | Gateway client connect timeout (ms) |
| `quarkus.rest-client."entity-persistence-gateway".read-timeout` | — | `30000` | Gateway client read timeout (ms) |
| `quarkus.otel.enabled` | `QUARKUS_OTEL_ENABLED` | `true` | Enable distributed tracing |
| `quarkus.otel.exporter.otlp.endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | OTLP collector endpoint |
| `quarkus.otel.propagators` | — | `tracecontext,baggage,b3,b3multi` | Trace propagation formats |
| `quarkus.otel.resource.attributes` | — | `service.name=entity-persistence-universal-orchestrator` | APM service label |
| `quarkus.log.level` | — | `INFO` | Root log level |
| `quarkus.log.category."io.tarcinapp".level` | — | `DEBUG` | Tarcinapp package log level |

**Dev-mode profile** (`%dev`): OTel disabled, `backend.base-url=http://localhost:3000`, `gateway.base-url=http://localhost:8080`.  
**Test-mode profile** (`%test`): OTel disabled, backend health check disabled.

---

## Topology: Gateway → Orchestrator → EPS

When the orchestrator is deployed, the Gateway routes to it instead of directly to EPS:

```yaml
# In entity-persistence-gateway application-routes.yaml
app:
  backend:
    host: entity-persistence-universal-orchestrator
    port: 8079
```

The orchestrator then forwards to EPS:
```
Client → Gateway :8081 → Orchestrator :8079 → EPS :3000 → MongoDB
```

The Gateway doesn't know (or care) whether the backend is EPS or an orchestrator — it just proxies to `app.backend.host:port`. The orchestrator exposes the same EPS API surface, so the Gateway's routing, auth, and filtering logic is entirely unaffected by the presence of the orchestrator.

---

## When to Use the Orchestrator

Use the orchestrator when you need logic that **cannot** be expressed through:
- Gateway filter configuration (env vars/YAML)
- OPA policies (Rego)

**Good use cases for the orchestrator:**
- Auto-populating fields from external services (e.g., fetch a category name from another API and inject it into the body before the EPS call)
- Enforcing cross-record business rules (e.g., "max 3 active promotions per seller" with complex counting logic)
- Triggering side effects after a create (e.g., send a notification, update a counter in another system)
- Aggregating data from multiple EPS calls into a single response
- Running data migrations or backfills via custom endpoints

**Do NOT use the orchestrator for:**
- Authentication (handled by Gateway)
- Authorization / field masking (handled by OPA + Gateway)
- JSON schema validation (handled by Gateway)
- Rate limiting, locking, caching (handled by Gateway)
- Simple `_kind` filtering (handled by Kind Aliasing)
- Uniqueness / record-limit distributed locking (handled by `entity-persistence-cache` — see below)

---

## This Repository as a Template

`entity-persistence-universal-orchestrator` is not only a runnable service — it is the **canonical template** for building any transparent proxy component in the Tarcinapp suite that needs to intercept EPS traffic. Components built on this template inherit the full route coverage (68 Camel routes mirroring all 67 EPS endpoints), correct proxy mechanics (`bridgeEndpoint=true`, hop-by-hop header stripping), OpenTelemetry tracing, and the CDI processor injection pattern.

**Planned components built from this template:**

| Component | Purpose |
|:---|:---|
| `entity-persistence-cache` *(planned)* | Distributed lock enforcement for uniqueness/limit TOCTOU + GET response caching. See [`15_COMPONENT_entity-persistence-cache.md`](./15_COMPONENT_entity-persistence-cache.md). |

When cloning this template for a new infrastructure component (rather than a product-specific orchestrator), replace the business-logic stubs with the infrastructure service's CDI beans, update `application.properties` defaults, and rename the artifact in `pom.xml`.

---

## How to Clone and Extend

1. Clone the repository: `git clone https://github.com/tarcinapp/entity-persistence-universal-orchestrator my-product-orchestrator`
2. Rename the artifact in `pom.xml`: `<artifactId>my-product-orchestrator</artifactId>`
3. Update `application.properties` with your Gateway and EPS URLs.
4. Implement your logic in the specific PreProcessor/PostProcessor classes for the endpoints you need.
5. Leave untouched pre/post-processors as no-ops — they contain only an empty `process()` body and are zero-overhead pass-throughs.

**Tip:** Only implement the processors for the operations where you need custom logic. Empty processors cost nothing — the route will simply proxy transparently to EPS.

---

## Related Documents
- `00_SYSTEM_MANIFEST.md §2 Layer IV` — Orchestration layer description
- `15_COMPONENT_entity-persistence-cache.md` — EPC: a sibling component built from this template
- `24_CONCEPT_orchestration-layer.md` — When to use orchestration vs. gateway vs. OPA
- `25_CONCEPT_concurrency-and-integrity.md` — TOCTOU analysis and the role of EPC locks
- `11_COMPONENT_entity-persistence-gateway.md` — How the gateway routes to the orchestrator
- `10_COMPONENT_entity-persistence-service.md` — The service the orchestrator proxies to
