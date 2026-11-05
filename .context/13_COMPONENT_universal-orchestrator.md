# 13_COMPONENT_universal-orchestrator.md

## Component Identity

**Repository:** `entity-persistence-universal-orchestrator`  
**Technology:** Java 17 · Quarkus 3.15.3 · Apache Camel (camel-quarkus)  
**Layer:** IV — Orchestration  
**Default port:** `8079`  
**Source of truth for its own docs:** [`entity-persistence-universal-orchestrator/pom.xml`](../../entity-persistence-universal-orchestrator/pom.xml), [`src/`](../../entity-persistence-universal-orchestrator/src/)

---

## What It Is

`entity-persistence-universal-orchestrator` is the **optional business logic layer** in the Tarcinapp suite. It sits between the Gateway and `entity-persistence-service` and intercepts every request/response to allow custom pre-processing and post-processing logic.

This component is a **template / blueprint** — you clone it and extend it for your specific product. It ships with stub pre- and post-processor classes for every one of the 67 EPS endpoints, all wired into Apache Camel routes. You implement business logic by filling in those stubs.

> The orchestrator is optional. The Gateway can call `entity-persistence-service` directly. You add the orchestrator to the topology only when you need custom logic that cannot be expressed through Gateway filters or OPA policies.

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
└────────────┬────────────┘
             │
             ▼
    [proxy to entity-persistence-service]
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

### RouteBuilder
Each `Route.java` class extends `RouteBuilder` and defines:
- The Camel `from()` endpoint (a `platform-http` listener matching the EPS path and method)
- The pre-processor bean call
- The `toD()` call proxying the request to the backend (`backend.base-url`)
- The post-processor bean call

### PreProcessor
Runs before the request reaches EPS. Can:
- Modify request body (add/remove fields)
- Add/modify headers
- Rewrite query parameters
- Short-circuit with an error response (validation, quota check)
- Make auxiliary calls to the Gateway or other services

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
├── BackendStartupCheck.java         ← health-probes EPS at startup; aborts if unreachable
├── CamelPlatformHttpConfig.java     ← configures the Camel platform-http component
├── gateway/
│   └── EntityPersistenceClient.java ← MP REST Client interface for calling the Gateway
├── routes/
│   ├── entities/                    ← 16 RouteBuilder classes (one per entity endpoint)
│   ├── lists/                       ← 16 RouteBuilder classes
│   ├── relations/                   ← 8 RouteBuilder classes
│   ├── entityreactions/             ← 11 RouteBuilder classes
│   ├── listreactions/               ← 11 RouteBuilder classes
│   └── system/                      ← ping, openapi, system-info routes
└── processors/
    ├── entities/                    ← PreProcessor + PostProcessor pairs per entity op
    ├── lists/
    ├── relations/
    ├── entityreactions/
    ├── listreactions/
    └── system/
```

### Example: `CreateEntityRoute.java`
```java
@ApplicationScoped
public class CreateEntityRoute extends RouteBuilder {
    @Override
    public void configure() {
        from("platform-http:/entities?httpMethodRestrict=POST")
            .process(new CreateEntityPreProcessor())
            .toD("http://{{backend.base-url}}/entities?bridgeEndpoint=true")
            .process(new CreateEntityPostProcessor());
    }
}
```

### Example: `CreateEntityPreProcessor.java`
```java
@ApplicationScoped
public class CreateEntityPreProcessor implements Processor {
    @Override
    public void process(Exchange exchange) throws Exception {
        // TODO: Add your pre-processing logic here.
        // The request body is available as:
        //   exchange.getIn().getBody(String.class)
        // Headers (including JWT claims injected by the gateway) via:
        //   exchange.getIn().getHeader("X-User-Id", String.class)
    }
}
```

---

## EntityPersistenceClient

The `EntityPersistenceClient` is a MicroProfile REST Client that points **back to the Gateway** (not directly to EPS). This allows processors to make authenticated calls to the full Gateway stack (with authorization, field masking, etc.) from within the orchestration logic.

```java
@Path("/")
@RegisterRestClient(configKey = "entity-persistence-gateway")
public interface EntityPersistenceClient {
    @GET
    @Path("/entities/{id}")
    Response findEntityById(@PathParam("id") String id, ...);
    
    // ... one method per EPS endpoint
}
```

Config: `quarkus.rest-client."entity-persistence-gateway".url=${GATEWAY_BASE_URL}`

---

## Configuration

| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `quarkus.http.port` | `QUARKUS_HTTP_PORT` | `8079` | Orchestrator HTTP listen port |
| `backend.base-url` | `BACKEND_BASE_URL` | `http://localhost:3000` | EPS URL (direct, no gateway) |
| `gateway.base-url` | `GATEWAY_BASE_URL` | `http://localhost:8081` | Gateway URL (for EntityPersistenceClient) |
| `backend.health-check.enabled` | `BACKEND_HEALTH_CHECK_ENABLED` | `true` | Probe EPS at startup |
| `backend.health-check.timeout-seconds` | `BACKEND_HEALTH_CHECK_TIMEOUT_SECONDS` | `10` | Startup probe timeout |
| `quarkus.otel.enabled` | `QUARKUS_OTEL_ENABLED` | `true` | Enable distributed tracing |
| `quarkus.otel.exporter.otlp.endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | OTLP collector endpoint |

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
Gateway :8081 → Orchestrator :8079 → EPS :3000 → MongoDB
```

The Gateway doesn't know (or care) whether the backend is EPS or an orchestrator — it just proxies to `app.backend.host:port`. The orchestrator exposes the same EPS API contract.

---

## When to Use the Orchestrator

Use the orchestrator when you need logic that **cannot** be expressed through:
- Gateway filter configuration (env vars/YAML)
- OPA policies (Rego)

**Good use cases for the orchestrator:**
- Auto-populating fields from external services (e.g., fetch a category name from another API and inject it)
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

---

## How to Clone and Extend

1. Clone the repository: `git clone https://github.com/tarcinapp/entity-persistence-universal-orchestrator my-product-orchestrator`
2. Rename the artifact in `pom.xml`: `<artifactId>my-product-orchestrator</artifactId>`
3. Update `application.properties` with your Gateway and EPS URLs.
4. Implement your logic in the specific PreProcessor/PostProcessor classes for the endpoints you need.
5. Leave untouched pre/post-processors as no-ops — they pass through transparently.

**Tip:** Only implement the processors for the operations where you need custom logic. Empty processors are zero-overhead pass-throughs.

---

## OpenTelemetry Tracing

Every Camel Exchange is automatically instrumented with an OpenTelemetry span (`camel-quarkus-opentelemetry`). The span propagates W3C TraceContext and B3 headers to all outbound HTTP calls, linking Gateway → Orchestrator → EPS traces in your APM tool.

Config:
```properties
quarkus.otel.propagators=tracecontext,baggage,b3,b3multi
quarkus.otel.resource.attributes=service.name=entity-persistence-universal-orchestrator
```

---

## Related Documents
- `00_SYSTEM_MANIFEST.md §2 Layer IV` — Orchestration layer description
- `24_CONCEPT_orchestration-layer.md` — When to use orchestration vs. gateway vs. OPA
- `11_COMPONENT_entity-persistence-gateway.md` — How the gateway routes to the orchestrator
- `10_COMPONENT_entity-persistence-service.md` — The service the orchestrator proxies to
