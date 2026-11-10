# 42_EXAMPLE_custom-business-logic.md

## Overview

This guide demonstrates how to add custom business logic to a Tarcinapp deployment using the `entity-persistence-universal-orchestrator`. The example extends the books application from `40_EXAMPLE_books-app.md` with a real-world use case:

**Rule:** When a book is created, automatically look up the author entity and copy the author's `country` field onto the new book record as `authorCountry`.

---

## Prerequisites

- Books app running (see `40_EXAMPLE_books-app.md`)
- `entity-persistence-universal-orchestrator` cloned and buildable

---

## Step 1: Decide Where the Logic Belongs

First, check `24_CONCEPT_orchestration-layer.md` to confirm the orchestrator is the right place.

**Our rule: "auto-copy author's country onto new book"**

This rule requires two operations: (1) read the author entity by ID, and (2) inject a field into the book create request body before it reaches EPS. Before implementing in the orchestrator, systematically rule out every other layer:

### Why OPA cannot handle this

OPA is a policy engine. The Tarcinapp Gateway calls OPA with a fixed input shape (the JWT claims, the operation, the entity kind, and the request body) and expects a fixed output shape: `allow: true/false` and optionally `forbiddenFields: [...]`. That is all OPA can return.

OPA is a **pure function of its input** — it has no ability to make external calls or fetch records. It cannot say "look up entity X and copy field Y". If you tried to express this rule in Rego, the policy would need to access the author record, which OPA cannot do at evaluation time.

### Why the Gateway filter layer cannot handle this

Gateway filters run as part of the request pipeline before routing, and they have access to the JWT and the incoming request body. However, they are **configuration-driven** (YAML/properties) and designed for structural operations: adding managed fields, validating schema, enforcing locks, injecting `_kind`. There is no Gateway filter extension point that supports "make an outbound read call to fetch a related record and inject its fields". Filters can only enrich the body from what is already known at filter time (the JWT, the request, the config).

### Why EPS config cannot handle this

EPS configuration supports constraints on record creation — uniqueness rules, record-count limits, field-level defaults. These are **constraints**, not enrichment. EPS has no concept of "before persisting this record, look up another record and copy a field from it". That would require EPS to understand the application's domain graph, which it intentionally does not.

### Why this belongs in the Orchestrator PreProcessor

The Orchestrator PreProcessor is the **only layer** where both necessary capabilities coexist:

1. **Access to the full Camel Exchange** — you can read the incoming body, headers (including the caller's JWT), and query parameters.
2. **The ability to make outbound calls** — via `EntityPersistenceClient` you can call the Gateway to fetch the author record (with full authorization context).
3. **The ability to mutate the request body** — you set the enriched body back on the exchange before the pipeline forwards it to EPS.

No other layer has all three. The Orchestrator PreProcessor is the correct and only place for this logic.

---

## Step 2: Clone and Set Up the Orchestrator

```bash
git clone https://github.com/tarcinapp/entity-persistence-universal-orchestrator books-app-orchestrator
cd books-app-orchestrator
```

Update `pom.xml`:
```xml
<artifactId>books-app-orchestrator</artifactId>
<name>books-app-orchestrator</name>
```

Update `src/main/resources/application.properties`:
```properties
quarkus.http.port=8079
backend.base-url=http://localhost:3000
gateway.base-url=http://localhost:8081
backend.health-check.enabled=true
```

---

## Step 3: Implement the PreProcessor

Open `src/main/java/io/tarcinapp/orchestrator/processors/entities/CreateEntityPreProcessor.java`.

The default implementation is an empty pass-through. Replace it with:

### What the body already contains when the PreProcessor runs

Before the request reaches the orchestrator's PreProcessor, the Gateway has already applied several filters in sequence. Your processor does **not** receive the raw client request — it receives a partially-populated payload. Specifically, for a `POST /entities` (createEntity) call:

- **`_kind`** is already present — the Gateway's `PlaceKindNameIntoPayload` filter resolved the kind alias (`books` → `book`) and injected it into the payload before routing. You can rely on `_kind` being set; you do not need to infer it from the URL.
- **`_createdBy`**, **`_ownerUsers`**, **`_createdDateTime`** are already present — injected by `AddManagedFieldsInCreation`.
- **The Redis distributed lock is already held** — acquired by the Gateway's `AcquireLockForCreation` filter. The lock is released by a Gateway PostFilter after the full round-trip completes, regardless of what the orchestrator does.

### Why forwarding the Authorization header is critical

The `EntityPersistenceClient` calls the **Gateway** (not EPS directly) — see Step 4. The Gateway authenticates every inbound request. If you call the client without a `Bearer` token, the Gateway returns 401.

The orchestrator itself does not have its own JWT. You must extract the `Authorization` header from the incoming exchange (forwarded from the original caller) and pass it to every `EntityPersistenceClient` call. This means the author lookup runs **as the original caller** — the caller's OPA policies and field masking apply to the author record they receive. If the calling user is not authorized to see the author entity, the author lookup will return 403.

### What happens when the author field is a plain string

The `author` field might not always be a `tapp://` URI. A caller might send `"author": "Leo Tolstoy"` as a plain string. In that case, `authorNode.asText().startsWith("tapp://")` returns `false` and the enrichment is skipped — the book is stored with the raw string in the `author` field and no `authorCountry` is added.

This is a **design choice**: the processor treats `tapp://` references as structured data (resolved against the entity store) and plain strings as opaque values (stored as-is). If your application requires that only `tapp://` author references are valid, you should reject plain strings with a short-circuit 422 instead of silently skipping.

### Error handling: 404 and 403 from the author lookup

When the author lookup fails:
- **404** — the author entity does not exist (deleted, wrong ID, etc.)
- **403** — the calling user is not authorized to see the author

In the implementation below, both cases result in a **silent skip** (the enrichment is omitted, the book is still created without `authorCountry`). This is appropriate for optional enrichment.

If `authorCountry` is **mandatory** (e.g., business rules require every book to have it), the processor should short-circuit with a 422 instead — see the hard-fail pattern in the Error Handling section below.

```java
package com.tarcinapp.orchestrator.processors.entities;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import jakarta.ws.rs.core.Response;
import org.apache.camel.Exchange;
import org.apache.camel.Processor;
import org.eclipse.microprofile.rest.client.inject.RestClient;

import com.tarcinapp.orchestrator.gateway.EntityPersistenceClient;

import java.util.logging.Logger;

@ApplicationScoped
public class CreateEntityPreProcessor implements Processor {

    private static final Logger LOG = Logger.getLogger(CreateEntityPreProcessor.class.getName());
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Inject
    @RestClient
    EntityPersistenceClient gatewayClient;

    @Override
    public void process(Exchange exchange) throws Exception {

        String body = exchange.getIn().getBody(String.class);
        if (body == null || body.isBlank()) {
            return; // nothing to enrich
        }

        ObjectNode payload;
        try {
            payload = (ObjectNode) MAPPER.readTree(body);
        } catch (Exception e) {
            LOG.warning("CreateEntityPreProcessor: could not parse body as JSON, skipping enrichment");
            return;
        }

        // _kind is already injected by the Gateway's PlaceKindNameIntoPayload filter.
        // By the time this processor runs, _kind is guaranteed to be present.
        JsonNode kindNode = payload.get("_kind");
        if (kindNode == null || !"book".equals(kindNode.asText())) {
            return; // only enrich book entities
        }

        JsonNode authorNode = payload.get("author");
        if (authorNode == null) {
            return; // no author field at all, nothing to resolve
        }

        String authorValue = authorNode.asText();

        // Design choice: only resolve structured tapp:// references.
        // Plain strings (e.g. "Leo Tolstoy") are treated as opaque and stored as-is.
        if (!authorValue.startsWith("tapp://")) {
            LOG.info("CreateEntityPreProcessor: author field is a plain string (\"" + authorValue
                + "\"), skipping URI resolution — book will be stored without authorCountry");
            return;
        }

        // Extract the entity UUID from the tapp:// URI.
        // Expected format: tapp://localhost/entity/{uuid}
        String authorId = authorValue.replaceFirst("tapp://[^/]+/entity/", "");

        // Always forward the caller's JWT. The orchestrator has no JWT of its own.
        // The author lookup runs as the original caller — OPA and field masking apply.
        String bearerToken = exchange.getIn().getHeader("Authorization", String.class);

        try {
            Response authorResponse = gatewayClient.findEntityById(authorId, bearerToken);
            int status = authorResponse.getStatus();

            if (status == 404) {
                // Author not found — silent skip (optional enrichment)
                LOG.warning("CreateEntityPreProcessor: author " + authorId
                    + " not found (404), skipping authorCountry enrichment");
                return;
            }

            if (status == 403) {
                // Caller cannot see the author — silent skip (optional enrichment)
                LOG.warning("CreateEntityPreProcessor: caller cannot access author " + authorId
                    + " (403), skipping authorCountry enrichment");
                return;
            }

            if (status != 200) {
                LOG.warning("CreateEntityPreProcessor: unexpected status " + status
                    + " from author lookup, skipping authorCountry enrichment");
                return;
            }

            String authorBody = authorResponse.readEntity(String.class);
            JsonNode authorData = MAPPER.readTree(authorBody);

            JsonNode countryNode = authorData.get("country");
            if (countryNode != null && !countryNode.isNull()) {
                payload.put("authorCountry", countryNode.asText());
                LOG.info("CreateEntityPreProcessor: enriched book with authorCountry="
                    + countryNode.asText());
            } else {
                LOG.info("CreateEntityPreProcessor: author " + authorId
                    + " has no country field, book stored without authorCountry");
            }

        } catch (Exception e) {
            // Non-fatal: if author lookup throws (timeout, network error, etc.),
            // proceed without enrichment rather than failing the entire book creation.
            LOG.warning("CreateEntityPreProcessor: could not fetch author "
                + authorId + ": " + e.getMessage());
        }

        exchange.getIn().setBody(MAPPER.writeValueAsString(payload));
    }
}
```

---

## Step 4: Implement EntityPersistenceClient (if not already present)

The `EntityPersistenceClient` is a MicroProfile REST Client interface that calls **back to the Gateway** (not directly to EPS). This is architecturally intentional: because all calls go through the Gateway, all OPA policies, field masking, set-based visibility filters, and authorization rules apply consistently. There is no backdoor to EPS from within the orchestrator.

```
Your Processor
    │
    │  EntityPersistenceClient.findEntityById(...)
    ▼
Gateway :8081  ←── full auth + authz + field masking apply here
    │
    ▼
EPS :3000
```

The `EntityPersistenceClient` interface ships with the orchestrator template and covers all EPS endpoints. Verify it contains at minimum the methods you need, and extend it if necessary. The complete interface signature for the five most commonly used methods:

```java
package com.tarcinapp.orchestrator.gateway;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import org.eclipse.microprofile.rest.client.inject.RegisterRestClient;

@Path("/")
@RegisterRestClient(configKey = "entity-persistence-gateway")
@Consumes(MediaType.APPLICATION_JSON)
@Produces(MediaType.APPLICATION_JSON)
public interface EntityPersistenceClient {

    /**
     * Fetch a single entity by its ID. Returns the entity JSON or 404 if not found.
     * The caller's Authorization header is forwarded so that OPA and field masking apply.
     */
    @GET
    @Path("/api/v1/entities/{id}")
    Response findEntityById(
        @PathParam("id") String id,
        @HeaderParam("Authorization") String authorization
    );

    /**
     * Query entities with optional LoopBack filter and set expression.
     * The filter parameter must be a JSON-serialized LoopBack where/order/limit/skip object.
     */
    @GET
    @Path("/api/v1/entities")
    Response findEntities(
        @QueryParam("set") String set,
        @QueryParam("filter") String filter,
        @HeaderParam("Authorization") String authorization
    );

    /**
     * Create a new entity. Body must be a JSON object matching the EPS entity schema.
     */
    @POST
    @Path("/api/v1/entities")
    Response createEntity(
        String body,
        @HeaderParam("Authorization") String authorization
    );

    /**
     * Partially update an entity by ID. Body is a JSON patch object.
     */
    @PATCH
    @Path("/api/v1/entities/{id}")
    Response updateEntityById(
        @PathParam("id") String id,
        String body,
        @HeaderParam("Authorization") String authorization
    );

    /**
     * Delete an entity by ID.
     */
    @DELETE
    @Path("/api/v1/entities/{id}")
    Response deleteEntityById(
        @PathParam("id") String id,
        @HeaderParam("Authorization") String authorization
    );

    // ... one method per EPS endpoint (all 67 endpoints are covered in the full interface)
}
```

**Important:** All methods return `jakarta.ws.rs.core.Response` so that processors can inspect the status code before consuming the body. Query parameters that accept LoopBack filter/where objects are typed as `String` and must be JSON-serialized by the caller.

The `@Consumes` and `@Produces` annotations on the interface declare the content type contract. Jackson is used for JSON serialization by the Quarkus REST client runtime — you do not need to configure it separately.

The base URL is configured in `application.properties`:
```properties
quarkus.rest-client."entity-persistence-gateway".url=${GATEWAY_BASE_URL:http://localhost:8081}
quarkus.rest-client."entity-persistence-gateway".scope=jakarta.inject.Singleton
quarkus.rest-client."entity-persistence-gateway".connect-timeout=5000
quarkus.rest-client."entity-persistence-gateway".read-timeout=30000
```

**Injection in processors — always use `@RestClient`:**
```java
@Inject
@RestClient
EntityPersistenceClient gatewayClient;
```

---

## Step 5: Build and Run

```bash
# Dev mode (live reload on save)
./mvnw quarkus:dev

# Or build JAR
./mvnw package -DskipTests
java -jar target/quarkus-app/quarkus-run.jar
```

---

## Step 6: Wire the Gateway to the Orchestrator

Update the gateway's backend config to point to the orchestrator:

```bash
APP_BACKEND_HOST=localhost        # or container name in Docker
APP_BACKEND_PORT=8079
```

Restart the gateway. After this, all requests to the gateway's `/api/v1/books` endpoint are proxied to the orchestrator on port 8079, which applies pre/post-processing and then forwards to EPS on port 3000.

**Verify the chain:**
```
Client → Gateway :8081 → Orchestrator :8079 → EPS :3000
```

To confirm the orchestrator is in the chain, check the gateway logs — you should see requests being routed to `http://localhost:8079`. If you accidentally bypass the orchestrator by hitting EPS directly (`http://localhost:3000`), you will not see `authorCountry` enrichment.

---

## Step 7: Test

### Set up: create an author first
```bash
TOKEN="eyJhbGci..."

curl -X POST http://localhost:8081/api/v1/authors \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "Leo Tolstoy",
    "country": "Russia",
    "birthYear": 1828
  }'
# Save the returned _id, e.g.: author-uuid-123
```

### Scenario A: Happy path — author resolved successfully

```bash
curl -X POST http://localhost:8081/api/v1/books \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "Anna Karenina",
    "author": "tapp://localhost/entity/author-uuid-123",
    "isbn": "978-0-14-303500-9"
  }'
```

**Expected behavior:**
1. Request arrives at the gateway
2. Gateway authenticates, authorizes, validates schema
3. Gateway's `PlaceKindNameIntoPayload` filter injects `"_kind": "book"` into the payload
4. Gateway's `AddManagedFieldsInCreation` filter injects `_createdBy`, `_ownerUsers`, `_createdDateTime`
5. Gateway acquires Redis lock and proxies to orchestrator `POST /entities`
6. Orchestrator's `CreateEntityPreProcessor` runs:
   - Detects `_kind=book` (already present from gateway injection)
   - Detects `author` is a `tapp://` URI
   - Calls `GET /api/v1/entities/author-uuid-123` through the gateway, forwarding the `Authorization` header
   - Reads `country: "Russia"` from the author record
   - Injects `"authorCountry": "Russia"` into the request body
7. Orchestrator proxies enriched body to EPS `POST /entities`
8. EPS stores the book with `authorCountry: "Russia"`

**Expected response (partial):**
```json
{
  "_id": "new-book-uuid",
  "_name": "Anna Karenina",
  "_kind": "book",
  "author": "tapp://localhost/entity/author-uuid-123",
  "authorCountry": "Russia",
  "isbn": "978-0-14-303500-9"
}
```

**Verify:**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8081/api/v1/books/new-book-uuid

# Response should include:
# "authorCountry": "Russia"
```

---

### Scenario B: Author not found (404) — enrichment silently skipped

If the author ID does not exist or the record was deleted:

```bash
curl -X POST http://localhost:8081/api/v1/books \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "War and Peace",
    "author": "tapp://localhost/entity/nonexistent-uuid",
    "isbn": "978-0-19-923276-8"
  }'
```

**Expected behavior:** The author lookup returns 404. The PreProcessor logs a warning and skips the enrichment. The book is created **without** `authorCountry`.

**Expected response (partial):**
```json
{
  "_id": "another-book-uuid",
  "_name": "War and Peace",
  "_kind": "book",
  "author": "tapp://localhost/entity/nonexistent-uuid"
}
```

Note: `authorCountry` is absent. The book creation succeeds — the lookup failure is non-fatal.

---

### Scenario C: Author field is a plain string — enrichment skipped

```bash
curl -X POST http://localhost:8081/api/v1/books \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "Resurrection",
    "author": "Leo Tolstoy",
    "isbn": "978-0-14-044184-2"
  }'
```

**Expected behavior:** `"Leo Tolstoy"` does not start with `tapp://`, so the URI resolution branch is skipped entirely. The book is stored with the plain string in `author` and no `authorCountry`.

**Expected response (partial):**
```json
{
  "_id": "third-book-uuid",
  "_name": "Resurrection",
  "_kind": "book",
  "author": "Leo Tolstoy"
}
```

This is intentional behavior per the design choice documented in Step 3. To change this to a hard failure, see the Error Handling section below.

---

### Scenario D: Orchestrator NOT in the chain — verify the chain

If the gateway is configured to route directly to EPS (skipping the orchestrator), enrichment will not happen. To verify the orchestrator is active:

1. **Check the gateway config:** `APP_BACKEND_HOST` and `APP_BACKEND_PORT` should point to the orchestrator, not EPS.

2. **Create a book and check for enrichment:** If `authorCountry` is missing when it should be present, the orchestrator is not in the chain.

3. **Check gateway routing logs:**
   ```bash
   docker-compose logs gateway | grep "backend"
   # Should show: routing to http://localhost:8079 (orchestrator)
   # NOT: routing to http://localhost:3000 (EPS direct)
   ```

---

### Troubleshooting

**Check orchestrator logs for PreProcessor activity:**
```bash
docker-compose logs orchestrator | grep "CreateEntityPreProcessor"
# Should show enrichment or skip messages per the scenarios above
```

**Test the orchestrator directly (bypassing the gateway):**
```bash
curl -X POST http://localhost:8079/entities \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "test",
    "_kind": "book",
    "author": "tapp://localhost/entity/author-uuid-123"
  }'
```

Note: When calling the orchestrator directly, you must include `_kind` in the body yourself (the gateway normally injects it via `PlaceKindNameIntoPayload`). This is only for debugging — in production, all traffic should enter through the gateway.

**Test the gateway-to-orchestrator connection:**
```bash
curl http://localhost:8079/q/health
# Should return: {"status":"UP"}
```

---

## Step 8: PostProcessor Example (Side Effect with Notification)

To trigger a notification after a book is created, implement `CreateEntityPostProcessor.java`. The following is a complete working class that:
1. Checks the response status (201 = created, anything else is skipped)
2. Parses the created book entity from the EPS response
3. Fires a notification via an injected CDI `NotificationService`
4. Adds a custom response header `X-Notification-Sent: true`

```java
package com.tarcinapp.orchestrator.processors.entities;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import org.apache.camel.Exchange;
import org.apache.camel.Processor;

import com.tarcinapp.orchestrator.services.NotificationService;

import java.util.logging.Logger;

@ApplicationScoped
public class CreateEntityPostProcessor implements Processor {

    private static final Logger LOG = Logger.getLogger(CreateEntityPostProcessor.class.getName());
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Inject
    NotificationService notificationService;

    @Override
    public void process(Exchange exchange) throws Exception {
        // In PostProcessors, use getMessage() (not getIn()) to read the EPS response.
        Integer statusCode = exchange.getMessage()
            .getHeader(Exchange.HTTP_RESPONSE_CODE, Integer.class);

        if (statusCode == null || statusCode != 201) {
            // EPS did not create the entity (e.g. validation error from EPS itself)
            return;
        }

        String responseBody = exchange.getMessage().getBody(String.class);
        JsonNode createdBook;
        try {
            createdBook = MAPPER.readTree(responseBody);
        } catch (Exception e) {
            LOG.warning("CreateEntityPostProcessor: could not parse EPS response as JSON");
            return;
        }

        // Only send notification for book entities
        String kind = createdBook.path("_kind").asText();
        if (!"book".equals(kind)) {
            return;
        }

        String bookId   = createdBook.path("_id").asText();
        String bookName = createdBook.path("_name").asText();
        String userId   = exchange.getIn().getHeader("X-User-Id", String.class);

        LOG.info("CreateEntityPostProcessor: book created id=" + bookId + " name=" + bookName);

        // Fire notification asynchronously — do not block the response
        notificationService.notifyBookCreatedAsync(userId, bookId, bookName);

        // Add a custom response header to signal to the caller that a notification was sent
        exchange.getMessage().setHeader("X-Notification-Sent", "true");
        // Note: the body is NOT modified — the EPS response passes through unchanged
    }
}
```

**NotificationService stub (CDI bean):**

```java
package com.tarcinapp.orchestrator.services;

import jakarta.enterprise.context.ApplicationScoped;
import java.util.logging.Logger;

@ApplicationScoped
public class NotificationService {

    private static final Logger LOG = Logger.getLogger(NotificationService.class.getName());

    /**
     * Fires a book-created notification asynchronously.
     * In production, replace this stub with Kafka publish, webhook call, etc.
     * Use @Asynchronous (CDI) or Mutiny/Uni for true async execution.
     */
    public void notifyBookCreatedAsync(String userId, String bookId, String bookName) {
        // TODO: replace with real notification delivery
        LOG.info("NotificationService: book.created event — userId=" + userId
            + " bookId=" + bookId + " bookName=" + bookName);
    }
}
```

---

## New Section: Testing the Orchestrator in Isolation

### Unit Testing with Camel Quarkus Test Framework

Processors can be unit-tested using `@QuarkusTest` with Camel's `ProducerTemplate` to inject exchanges directly into a route, bypassing the HTTP layer. This lets you verify processor logic without standing up the full stack.

Add the test dependency to `pom.xml`:
```xml
<dependency>
    <groupId>io.quarkus</groupId>
    <artifactId>quarkus-test</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.apache.camel.quarkus</groupId>
    <artifactId>camel-quarkus-test</artifactId>
    <scope>test</scope>
</dependency>
```

**Example: `@QuarkusTest` that verifies body enrichment**

```java
package com.tarcinapp.orchestrator.processors.entities;

import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.junit.mockito.InjectMock;
import jakarta.inject.Inject;
import jakarta.ws.rs.core.Response;
import org.apache.camel.CamelContext;
import org.apache.camel.Exchange;
import org.apache.camel.ProducerTemplate;
import org.apache.camel.impl.DefaultCamelContext;
import org.apache.camel.support.DefaultExchange;
import org.eclipse.microprofile.rest.client.inject.RestClient;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import com.tarcinapp.orchestrator.gateway.EntityPersistenceClient;

import static org.junit.jupiter.api.Assertions.*;

@QuarkusTest
class CreateEntityPreProcessorTest {

    @Inject
    CreateEntityPreProcessor processor;

    @InjectMock
    @RestClient
    EntityPersistenceClient mockGatewayClient;

    @Inject
    CamelContext camelContext;

    @Test
    void shouldEnrichBookWithAuthorCountry() throws Exception {
        // Arrange: mock the author lookup to return a Russian author
        Response mockAuthorResponse = Response.ok(
            "{\"_id\":\"author-uuid-123\",\"_name\":\"Leo Tolstoy\",\"country\":\"Russia\"}"
        ).build();
        Mockito.when(mockGatewayClient.findEntityById(
            Mockito.eq("author-uuid-123"),
            Mockito.anyString()
        )).thenReturn(mockAuthorResponse);

        // Build an Exchange that simulates what the Gateway would send
        Exchange exchange = new DefaultExchange(camelContext);
        exchange.getIn().setHeader("Authorization", "Bearer test-token");
        exchange.getIn().setBody(
            "{\"_kind\":\"book\",\"_name\":\"Anna Karenina\"," +
            "\"author\":\"tapp://localhost/entity/author-uuid-123\"}"
        );

        // Act
        processor.process(exchange);

        // Assert
        String enrichedBody = exchange.getIn().getBody(String.class);
        assertTrue(enrichedBody.contains("\"authorCountry\":\"Russia\""),
            "Expected authorCountry=Russia in enriched body, got: " + enrichedBody);
    }

    @Test
    void shouldSkipEnrichmentWhenAuthorNotFound() throws Exception {
        // Arrange: author returns 404
        Response notFound = Response.status(404).build();
        Mockito.when(mockGatewayClient.findEntityById(
            Mockito.eq("nonexistent-uuid"),
            Mockito.anyString()
        )).thenReturn(notFound);

        Exchange exchange = new DefaultExchange(camelContext);
        exchange.getIn().setHeader("Authorization", "Bearer test-token");
        exchange.getIn().setBody(
            "{\"_kind\":\"book\",\"_name\":\"Test Book\"," +
            "\"author\":\"tapp://localhost/entity/nonexistent-uuid\"}"
        );

        processor.process(exchange);

        String resultBody = exchange.getIn().getBody(String.class);
        assertFalse(resultBody.contains("authorCountry"),
            "Expected no authorCountry when author is 404, got: " + resultBody);
    }

    @Test
    void shouldSkipEnrichmentForPlainStringAuthor() throws Exception {
        Exchange exchange = new DefaultExchange(camelContext);
        exchange.getIn().setHeader("Authorization", "Bearer test-token");
        exchange.getIn().setBody(
            "{\"_kind\":\"book\",\"_name\":\"Test Book\",\"author\":\"Leo Tolstoy\"}"
        );

        processor.process(exchange);

        // Verify the client was never called (no URI to resolve)
        Mockito.verify(mockGatewayClient, Mockito.never())
            .findEntityById(Mockito.any(), Mockito.any());

        String resultBody = exchange.getIn().getBody(String.class);
        assertFalse(resultBody.contains("authorCountry"),
            "Expected no authorCountry for plain string author");
    }

    @Test
    void shouldNotEnrichNonBookEntities() throws Exception {
        Exchange exchange = new DefaultExchange(camelContext);
        exchange.getIn().setHeader("Authorization", "Bearer test-token");
        exchange.getIn().setBody(
            "{\"_kind\":\"author\",\"_name\":\"Tolstoy\"}"
        );

        processor.process(exchange);

        Mockito.verify(mockGatewayClient, Mockito.never())
            .findEntityById(Mockito.any(), Mockito.any());
    }
}
```

---

## New Section: Error Handling Patterns

The PreProcessor supports three error handling strategies. Choose based on whether the enrichment is optional or mandatory.

### Pattern 1 — Silent Skip (log warning + continue)

**Use when:** The enrichment is optional. The record should be created even if the enrichment fails.

```java
try {
    Response authorResponse = gatewayClient.findEntityById(authorId, bearerToken);
    if (authorResponse.getStatus() == 200) {
        JsonNode authorData = MAPPER.readTree(authorResponse.readEntity(String.class));
        JsonNode countryNode = authorData.get("country");
        if (countryNode != null && !countryNode.isNull()) {
            payload.put("authorCountry", countryNode.asText());
        }
    } else {
        LOG.warning("Author lookup returned " + authorResponse.getStatus()
            + " for id=" + authorId + ", skipping enrichment");
    }
} catch (Exception e) {
    // Transient failure (timeout, network error) — log and continue
    LOG.warning("Author lookup failed: " + e.getMessage() + ", proceeding without enrichment");
}
// Always write back body (enriched or original)
exchange.getIn().setBody(MAPPER.writeValueAsString(payload));
```

### Pattern 2 — Hard Fail (return 422, short-circuit)

**Use when:** The enrichment is mandatory. If the author cannot be resolved, the book must not be created.

```java
try {
    Response authorResponse = gatewayClient.findEntityById(authorId, bearerToken);
    if (authorResponse.getStatus() == 404) {
        // Author not found — reject the create
        exchange.getIn().setHeader(Exchange.HTTP_RESPONSE_CODE, 422);
        exchange.getIn().setHeader("Content-Type", "application/json");
        exchange.getIn().setBody(
            "{\"error\":{\"statusCode\":422," +
            "\"message\":\"Author entity not found: " + authorId + "\"}}"
        );
        exchange.setRouteStop(true);  // skips EPS call and PostProcessor
        return;
    }
    // ... proceed with enrichment
} catch (Exception e) {
    // Treat exception (timeout, etc.) as a hard failure
    exchange.getIn().setHeader(Exchange.HTTP_RESPONSE_CODE, 503);
    exchange.getIn().setHeader("Content-Type", "application/json");
    exchange.getIn().setBody(
        "{\"error\":{\"statusCode\":503," +
        "\"message\":\"Author service unavailable, please retry\"}}"
    );
    exchange.setRouteStop(true);
    return;
}
```

Note: `exchange.setRouteStop(true)` is the only supported short-circuit mechanism. Do not throw exceptions — Camel's exception handling produces a different response shape that does not match the Tarcinapp error format.

### Pattern 3 — Retry (Camel retry for transient failures)

**Use when:** The external call is critical and transient failures should be retried before giving up.

Configure a Camel error handler in the `RouteBuilder` that wraps the processor:

```java
@Override
public void configure() {
    // Retry transient errors (connect timeout, 503) up to 3 times with 500ms delay
    onException(Exception.class)
        .maximumRedeliveries(3)
        .redeliveryDelay(500)
        .retryAttemptedLogLevel(org.apache.camel.LoggingLevel.WARN)
        .handled(true)
        .setHeader(Exchange.HTTP_RESPONSE_CODE, constant(503))
        .setBody(constant(
            "{\"error\":{\"statusCode\":503,\"message\":\"Upstream service temporarily unavailable\"}}"
        ));

    from("platform-http:/entities?httpMethodRestrict=POST")
        .routeId("createEntity")
        .process(preProcessor)
        // ...
}
```

For retry to be meaningful, keep the processor idempotent — ensure repeated calls to the author lookup do not have side effects. `GET` calls satisfy this by default.

---

## Pattern Summary

| Logic type | PreProcessor | PostProcessor |
|:---|:---|:---|
| Enrich request body before EPS | ✅ | ❌ |
| Validate business rules before EPS | ✅ (short-circuit with error) | ❌ |
| Mandatory pre-flight validation (fetch + check + reject if fails) | ✅ (short-circuit 422) | ❌ |
| Compute hash or signature of record | ✅ (before EPS, not after) | ❌ |
| Transform response shape | ❌ | ✅ |
| Trigger side effects after success | ❌ | ✅ |
| Aggregate multiple EPS calls into one response | ❌ | ✅ (make aux calls, merge) |
| Rollback on EPS error | ❌ | ✅ (check status code, compensate) |

---

## What NOT to Put in the Orchestrator

| Logic | Right place |
|:---|:---|
| JWT validation | Gateway filter |
| "Is this user allowed?" | OPA policy |
| "Which fields can this user see?" | OPA field policy |
| Schema validation | Gateway per-kind schema |
| Rate limiting | Gateway rate limiter |
| Distributed locking | Gateway lock filter |
| Simple `_kind=X` scoping | Gateway kind alias |
| "Max N records per user" (static count limit) | EPS record limits config |
| "Enforce unique title per author" | EPS uniqueness config |

---

## Related Documents
- `13_COMPONENT_universal-orchestrator.md` — Orchestrator architecture and code structure
- `24_CONCEPT_orchestration-layer.md` — When to use orchestration vs. other layers
- `40_EXAMPLE_books-app.md` — Base books app this example extends
