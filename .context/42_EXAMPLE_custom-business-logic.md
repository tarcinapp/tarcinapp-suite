# 42_EXAMPLE_custom-business-logic.md

## Overview

This guide demonstrates how to add custom business logic to a Tarcinapp deployment using the `entity-persistence-universal-orchestrator`. The example extends the books application from `40_EXAMPLE_books-app.md` with a real-world use case:

**Rule:** When a book is created, automatically look up the author entity and copy the author's `country` field onto the new book record.

---

## Prerequisites

- Books app running (see `40_EXAMPLE_books-app.md`)
- `entity-persistence-universal-orchestrator` cloned and buildable

---

## Step 1: Decide Where the Logic Belongs

First, check `24_CONCEPT_orchestration-layer.md` to confirm the orchestrator is the right place.

**Our rule: "auto-copy author's country onto new book"**
- Requires a read of the author entity before the create
- Cannot be expressed in JSON Schema validation (Gateway layer)
- Cannot be expressed in OPA (policy layer only determines allow/deny and forbidden fields)
- Cannot be expressed in EPS config (record limits, uniqueness — not data enrichment)
- → **Orchestrator PreProcessor** is the right place

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

```java
package io.tarcinapp.orchestrator.processors.entities;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import org.apache.camel.Exchange;
import org.apache.camel.Processor;

import io.tarcinapp.orchestrator.gateway.EntityPersistenceClient;

import java.util.logging.Logger;

@ApplicationScoped
public class CreateEntityPreProcessor implements Processor {

    private static final Logger LOG = Logger.getLogger(CreateEntityPreProcessor.class.getName());
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Inject
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

        // Only enrich book entities
        JsonNode kindNode = payload.get("_kind");
        if (kindNode == null || !"book".equals(kindNode.asText())) {
            return;
        }

        // Only enrich if author field is present and looks like a tapp:// reference
        JsonNode authorNode = payload.get("author");
        if (authorNode == null || !authorNode.asText().startsWith("tapp://")) {
            return;
        }

        // Extract the author entity ID from the tapp:// URI
        // Format: tapp://localhost/entity/{uuid}
        String authorUri = authorNode.asText();
        String authorId = authorUri.replaceFirst("tapp://localhost/entity/", "");

        // Fetch the author through the gateway (with authorization)
        String bearerToken = exchange.getIn().getHeader("Authorization", String.class);

        try {
            String authorResponse = gatewayClient.findEntityById(authorId, bearerToken);
            JsonNode authorData = MAPPER.readTree(authorResponse);

            JsonNode countryNode = authorData.get("country");
            if (countryNode != null && !countryNode.isNull()) {
                payload.put("authorCountry", countryNode.asText());
                LOG.info("CreateEntityPreProcessor: enriched book with authorCountry=" + countryNode.asText());
            }
        } catch (Exception e) {
            // Non-fatal: if author lookup fails, proceed without enrichment
            LOG.warning("CreateEntityPreProcessor: could not fetch author " + authorId + ": " + e.getMessage());
        }

        exchange.getIn().setBody(MAPPER.writeValueAsString(payload));
    }
}
```

---

## Step 4: Implement EntityPersistenceClient (if not already present)

The client interface `EntityPersistenceClient.java` should already be in the repository. Verify it has `findEntityById`:

```java
package io.tarcinapp.orchestrator.gateway;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import org.eclipse.microprofile.rest.client.inject.RegisterRestClient;

@Path("/")
@RegisterRestClient(configKey = "entity-persistence-gateway")
public interface EntityPersistenceClient {

    @GET
    @Path("/api/v1/entities/{id}")
    @Produces(MediaType.APPLICATION_JSON)
    String findEntityById(
        @PathParam("id") String id,
        @HeaderParam("Authorization") String authorization
    );

    // ... other methods
}
```

The base URL is configured in `application.properties`:
```properties
quarkus.rest-client."entity-persistence-gateway".url=${GATEWAY_BASE_URL:http://localhost:8081}
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

Restart the gateway.

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
# Save the author ID: author-uuid-123
```

### Create a book referencing the author via tapp:// URI
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
3. Gateway proxies to orchestrator `POST /entities`
4. Orchestrator's `CreateEntityPreProcessor` runs:
   - Detects `_kind=book` (injected by gateway) and `author` is a `tapp://` URI
   - Calls `GET /api/v1/entities/author-uuid-123` through the gateway
   - Reads `country: "Russia"` from the author record
   - Injects `"authorCountry": "Russia"` into the request body
5. Orchestrator proxies enriched body to EPS `POST /entities`
6. EPS stores the book with `authorCountry: "Russia"`

**Verify:**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8081/api/v1/books/new-book-uuid...

# Response should include:
# "authorCountry": "Russia"
```

---

## Step 8: PostProcessor Example (Side Effect)

To also trigger a notification after a book is created, add logic to `CreateEntityPostProcessor.java`:

```java
@ApplicationScoped
public class CreateEntityPostProcessor implements Processor {

    @Override
    public void process(Exchange exchange) throws Exception {
        // Check if creation was successful
        Integer statusCode = exchange.getIn().getHeader(Exchange.HTTP_RESPONSE_CODE, Integer.class);
        if (statusCode == null || statusCode != 201) {
            return; // creation failed, nothing to do
        }

        String responseBody = exchange.getIn().getBody(String.class);
        JsonNode createdBook = MAPPER.readTree(responseBody);

        String bookId = createdBook.path("_id").asText();
        String bookName = createdBook.path("_name").asText();

        // TODO: publish an event, call a notification service, update a counter...
        LOG.info("Book created: id=" + bookId + " name=" + bookName);
    }
}
```

---

## Pattern Summary

| Logic type | PreProcessor | PostProcessor |
|:---|:---|:---|
| Enrich request body before EPS | ✅ | ❌ |
| Validate business rules before EPS | ✅ (short-circuit with error) | ❌ |
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

---

## Related Documents
- `13_COMPONENT_universal-orchestrator.md` — Orchestrator architecture and code structure
- `24_CONCEPT_orchestration-layer.md` — When to use orchestration vs. other layers
- `40_EXAMPLE_books-app.md` — Base books app this example extends
