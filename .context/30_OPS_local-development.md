# 30_OPS_local-development.md

## Overview

This guide explains how to run the Tarcinapp stack locally for development. It covers the full runtime chain (EPG → EPBO → EPC → EPS) and how to connect the GUI.

> **Runtime chain:** `EPG :8081 → EPBO :3002 → EPC :3001 → EPS :3000 → MongoDB`
> `entity-persistence-universal-orchestrator` (EPUO) is **not** part of this chain — it remains in the workspace as a template source only and is not started.

---

## Minimum Viable Local Topology

For most development work, you need:
1. **MongoDB** — data storage
2. **Redis** — distributed locking and rate limiting
3. **OPA** — policy evaluation
4. **entity-persistence-service** — REST backend
5. **entity-persistence-gateway** — API gateway (calls OPA and EPS)

For the full chain with payload normalization and integrity locks, also start:
- **entity-persistence-cache** (EPC) — Redis scope locks, findById cache
- **entity-persistence-base-orchestrator** (EPBO) — payload normalization

The GUI is an optional add-on.

---

## Starting Infrastructure with Docker Compose

### Infra-only `docker-compose.infra.yml`

The most common dev-loop pattern is to run the infrastructure services (MongoDB, Redis, OPA) in Docker while running EPS and the gateway as local processes on the host. Save the following as `docker-compose.infra.yml` in your workspace root:

```yaml
version: "3.9"

networks:
  tarcinapp:
    driver: bridge

volumes:
  mongodb_data:
  redis_data:

services:

  mongodb:
    image: mongo:7
    container_name: tarcinapp-mongodb
    networks:
      - tarcinapp
    volumes:
      - mongodb_data:/data/db
    environment:
      MONGO_INITDB_DATABASE: tappdb
    ports:
      - "27017:27017"
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s

  redis:
    image: redis:7-alpine
    container_name: tarcinapp-redis
    networks:
      - tarcinapp
    volumes:
      - redis_data:/data
    ports:
      - "6379:6379"
    command: redis-server --save 60 1
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  opa:
    image: openpolicyagent/opa:latest
    container_name: tarcinapp-opa
    networks:
      - tarcinapp
    volumes:
      # IMPORTANT: mount the policies/ subdirectory, not the repo root.
      # The OPA load path must point to the directory that contains the
      # .rego files and data.json, not the parent repository directory.
      - ./entity-persistence-gateway-policies/policies:/policies:ro
    command:
      - run
      - --server
      - --addr=0.0.0.0:8181
      - --log-level=info
      - /policies
    ports:
      - "8181:8181"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8181/health"]
      interval: 5s
      timeout: 3s
      retries: 5
```

Start and stop:
```bash
# Start infra only
docker-compose -f docker-compose.infra.yml up -d

# Stop (keep volumes)
docker-compose -f docker-compose.infra.yml down

# Full reset (wipe data)
docker-compose -f docker-compose.infra.yml down -v
```

### OPA volume mount — critical detail

OPA must be pointed at `entity-persistence-gateway-policies/policies/`, **not** the repo root. The `policies/` directory is the one that contains the `auth/` package tree and the `data.json` file that OPA loads as initial data. If you mount the repo root instead, OPA will start successfully but will have no rules loaded, and every authorization request will return a default `false` deny.

### Verifying OPA loaded the policies correctly

After starting OPA, confirm the policy tree is present:

```bash
curl http://localhost:8181/v1/data
```

Expected response contains a `data.policies` object with nested package keys, for example:

```json
{
  "result": {
    "policies": {
      "auth": {
        "routes": {
          "entities": { ... },
          "lists": { ... }
        }
      }
    }
  }
}
```

If `result` is `{}` or `policies` key is missing, the volume mount path is wrong — the container cannot see the `.rego` files.

### Alternative: individual `docker run` commands

```bash
# MongoDB
docker run -d --name tarcinapp-mongo \
  -p 27017:27017 \
  -e MONGO_INITDB_DATABASE=tappdb \
  mongo:7

# Redis
docker run -d --name tarcinapp-redis \
  -p 6379:6379 \
  redis:7-alpine

# OPA — note: mount the policies/ subdirectory
docker run -d --name tarcinapp-opa \
  -p 8181:8181 \
  -v $(pwd)/entity-persistence-gateway-policies/policies:/policies \
  openpolicyagent/opa:latest \
  run --server --addr 0.0.0.0:8181 /policies
```

---

## Step 2: Start entity-persistence-service

```bash
cd entity-persistence-service

# Option A: with a .env file
cp dev.env .env
# Edit .env as needed (see variable list below)
npm install
npm start    # listens on :3000

# Option B: in-memory MongoDB (dev/test only, no Docker needed)
# Start without MONGODB_HOST configured — EPS auto-starts an in-memory MongoDB
npm start
```

### Key `.env` settings for local dev

```bash
NODE_ENV=development
HOST=localhost
PORT=3000

# Database — correct env var names confirmed in configuration reference
MONGODB_HOST=localhost
MONGODB_PORT=27017
MONGODB_DATABASE=tappdb
# Leave MONGODB_USER / MONGODB_PASSWORD empty for unauthenticated local MongoDB.
# Or use MONGODB_URL for a full connection string (takes precedence):
# MONGODB_URL=mongodb://localhost:27017/tappdb

# Allowed kinds — without these, any _kind value is accepted.
# That is fine for exploration but produces noisy test output because
# any typo silently creates records with unexpected kind names.
ENTITY_KINDS=book,chapter,author
LIST_KINDS=bookshelf
LIST_ENTITY_REL_KINDS=contains
ENTITY_REACTION_KINDS=review,like

# Auto approve — set true so _validFromDateTime is set automatically on create.
# Without this, newly created records have _validFromDateTime=null and are
# invisible to members under the default active-records filter.
AUTOAPPROVE_ENTITY=true
AUTOAPPROVE_LIST=true
AUTOAPPROVE_LIST_ENTITY_RELATIONS=true
AUTOAPPROVE_ENTITY_REACTION=true
AUTOAPPROVE_LIST_REACTION=true

# Visibility default — protected means the record is visible to authenticated
# users; private means visible only to owners. Use protected locally so test
# queries don't require ownership filters on every GET.
VISIBILITY_ENTITY=protected
VISIBILITY_LIST=protected

RESPONSE_LIMIT_ENTITY=100
LOG_LEVEL=debug
```

### Verify EPS is running

```bash
curl http://localhost:3000/ping
# Expected: 200 OK {"greeting":"Hello from LoopBack"}
```

---

## Step 3: Start entity-persistence-gateway

```bash
cd entity-persistence-gateway
```

### Create `src/main/resources/application-dev.yaml`

This file is the standard pattern for local dev configuration. It is gitignored so it never leaks secrets. Spring Boot loads it when the `dev` profile is active.

Full path: `entity-persistence-gateway/src/main/resources/application-dev.yaml`

```yaml
app:
  name: tarcinapp-dev
  shortcode: tarcinapp
  inbound:
    address: 0.0.0.0
    port: 8081
    baseUri: /api/v1/
  backend:
    protocol: http
    host: localhost
    port: 3000
    baseURI: /
  opa:
    protocol: http
    host: localhost
    port: 8181
  auth:
    # Paste the contents of your dev public.pem here (generated below)
    rs256PublicKey: |
      -----BEGIN PUBLIC KEY-----
      ... your test public key ...
      -----END PUBLIC KEY-----
    # Must match the iss claim in your dev JWT exactly (string comparison)
    issuer: http://localhost:8080/realms/tarcinapp
    # Large skew allows long-lived dev tokens without clock issues
    clockSkewSeconds: 3600

  # Define your kind aliases so /api/v1/books maps to _kind=book
  kindAliasPaths:
    - alias: books
      name: book
    - alias: shelves
      name: bookshelf

  # Enable TRACE logging to see full request/response bodies in the gateway log.
  # Extremely useful for debugging filter chains and OPA decisions.
  logging:
    http: TRACE
    tarcinapp: DEBUG
    gateway: DEBUG

spring:
  redis:
    host: localhost
    port: 6379
    database: 0
    password: ""
  # CORS — needed if you are hitting the gateway from a browser (e.g. base-gui dev server)
  cloud:
    gateway:
      globalcors:
        cors-configurations:
          '[/**]':
            allowedOrigins:
              - "http://localhost:5173"   # Vite dev server
              - "http://localhost:3001"   # any other local frontend
            allowedMethods:
              - GET
              - POST
              - PUT
              - PATCH
              - DELETE
              - OPTIONS
            allowedHeaders:
              - "*"
            allowCredentials: false
```

### Start the gateway

```bash
# Maven wrapper — activate the dev profile
./mvnw spring-boot:run -Dspring-boot.run.profiles=dev
```

The `dev` profile causes Spring Boot to merge `application.yaml` with `application-dev.yaml`. Settings in `application-dev.yaml` take precedence.

### Confirm gateway startup

```bash
# Actuator health endpoint — confirms all sub-components are UP
curl http://localhost:8081/actuator/health
# Expected: {"status":"UP"}

# Gateway ping (proxied through to EPS)
curl http://localhost:8081/api/v1/ping
# Expected: 200 OK
```

---

## VSCode Development Setup

### `launch.json` — Gateway + EPS launch configurations

Save as `.vscode/launch.json` inside your workspace:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "java",
      "request": "launch",
      "name": "Gateway (dev profile)",
      "projectName": "entity-persistence-gateway",
      "mainClass": "com.tarcinapp.entitypersistencegateway.EntityPersistenceGatewayApplication",
      "vmArgs": "-Dspring.profiles.active=dev",
      "preLaunchTask": "infra:up"
    },
    {
      "type": "node",
      "request": "launch",
      "name": "EPS (dev)",
      "program": "${workspaceFolder}/entity-persistence-service/dist/index.js",
      "envFile": "${workspaceFolder}/entity-persistence-service/.env",
      "preLaunchTask": "eps:build"
    }
  ],
  "compounds": [
    {
      "name": "Full Stack (EPS + Gateway)",
      "configurations": ["EPS (dev)", "Gateway (dev profile)"],
      "stopAll": true
    }
  ]
}
```

### `tasks.json` — helper tasks

Save as `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "infra:up",
      "type": "shell",
      "command": "docker-compose -f docker-compose.infra.yml up -d",
      "presentation": { "reveal": "silent" },
      "problemMatcher": []
    },
    {
      "label": "eps:build",
      "type": "shell",
      "command": "cd entity-persistence-service && npm run build",
      "presentation": { "reveal": "always", "panel": "shared" },
      "problemMatcher": ["$tsc"]
    },
    {
      "label": "gateway:run-dev",
      "type": "shell",
      "command": "cd entity-persistence-gateway && ./mvnw spring-boot:run -Dspring-boot.run.profiles=dev",
      "presentation": { "reveal": "always", "panel": "dedicated" },
      "problemMatcher": []
    }
  ]
}
```

---

## Generating a Dev JWT

For local testing without a running Keycloak, generate a test JWT signed with your own dev RS256 key pair.

### Step 1: Generate a test RS256 key pair

```bash
# Generate a 2048-bit RSA private key
openssl genrsa -out private.pem 2048

# Extract the public key (paste this into application-dev.yaml → app.auth.rs256PublicKey)
openssl rsa -in private.pem -pubout -out public.pem

cat public.pem
```

Keep `private.pem` local and never commit it. The public key goes into `application-dev.yaml`.

### Step 2: Sign a token

**Option A — Python (`PyJWT`):**

```python
import jwt, time

payload = {
    "sub": "dev-user",
    "roles": ["tarcinapp.admin"],
    "groups": [],
    "email_verified": True,
    # iss must match app.auth.issuer in application-dev.yaml exactly
    "iss": "http://localhost:8080/realms/tarcinapp",
    "exp": int(time.time()) + 86400 * 365   # 1 year
}

token = jwt.encode(payload, open("private.pem").read(), algorithm="RS256")
print(token)
```

Install with: `pip install PyJWT cryptography`

**Option B — jwt.io:**

Go to [jwt.io](https://jwt.io), select **RS256**, paste your `private.pem` in the private key box and the payload above in the payload box. Copy the encoded token from the left panel.

### Step 3: Use the token

```bash
# Export for convenience
export TOKEN="<paste token here>"

# Test an authenticated endpoint
curl -H "Authorization: Bearer $TOKEN" http://localhost:8081/api/v1/books
```

### JWT payload requirements

```json
{
  "sub": "dev-user",
  "roles": ["tarcinapp.admin"],
  "groups": [],
  "email_verified": true,
  "iss": "http://localhost:8080/realms/tarcinapp",
  "exp": 9999999999
}
```

- `roles` must be a top-level array — **not** nested under `realm_access`. The gateway/OPA reads `token.payload.roles` directly.
- `email_verified: true` is required for all write operations. Without it, OPA denies all POST/PUT/PATCH/DELETE regardless of role.
- `iss` must be an exact string match to `app.auth.issuer`. Even a trailing slash difference causes 401.

---

## Adding EPBO to Local Dev

To run the full chain (`EPG → EPBO → EPC → EPS`), start EPBO after EPC:

```bash
cd entity-persistence-base-orchestrator

# quarkus:dev enables live reload — changes to normalization processors take effect
# immediately without restarting the JVM.
mvn quarkus:dev   # starts on :3002
```

The Quarkus Dev UI is available at `http://localhost:3002/q/dev` — it shows all CDI beans, Camel routes, registered extensions, and health checks.

Then update the gateway's backend in `application-dev.yaml` to point to EPBO:
```yaml
app:
  backend:
    host: localhost
    port: 3002
```

Now the chain is: `Gateway :8081 → EPBO :3002 → EPC :3001 → EPS :3000 → MongoDB`

> **Note on EPUO:** `entity-persistence-universal-orchestrator` is a **template repository** — it is not started in local dev. Do not point the gateway at port `:8079` for normal development. Use `:3002` (EPBO) or `:3001` (EPC, without EPBO) or `:3000` (EPS directly, no normalization or locks).

---

## Connecting tarcinapp-base-gui

```bash
cd tarcinapp-base-gui
npm install
npm run dev   # Vite dev server at http://localhost:5173
```

On the SetupScreen:
- **API endpoint URL:** `http://localhost:8081`
- **Bearer token:** your dev JWT

### Live connection vs. drag-and-drop mode

The `oas.json` bundled in the repo root is a **static snapshot** generated at release time. When working with a live gateway (especially one with custom kind aliases or routes configured), always connect **live** (enter the endpoint URL and token) rather than drag-and-dropping the file. The live gateway serves a personalized `GET /api/v1/openapi.json` that reflects the specific `kindAliasPaths`, `fieldsets`, and disabled routes configured for your instance.

Drag-and-drop mode is useful for offline inspection or when demonstrating the schema without a running stack.

### CORS errors

If the browser console shows CORS errors when the GUI hits the gateway, add the `spring.cloud.gateway.globalcors` block shown in the `application-dev.yaml` sample above. The key is to include the Vite dev server origin (`http://localhost:5173`) in `allowedOrigins`.

---

## Common Local Dev Checks

### Is EPS running?
```bash
curl http://localhost:3000/ping
# Expected: 200 OK {"greeting":"Hello from LoopBack"}
```

### Is the Gateway running?
```bash
curl http://localhost:8081/api/v1/ping
# Expected: 200 OK (passes through to EPS ping)

# Actuator health — more detailed, shows Redis and downstream connectivity
curl http://localhost:8081/actuator/health
# Expected: {"status":"UP"}
```

### Is OPA running and policies loaded?
```bash
# Basic health
curl http://localhost:8181/health
# Expected: {"status":"ok"}

# Verify policy tree is present — result.policies should be non-empty
curl http://localhost:8181/v1/data | jq '.result | keys'
# Expected: ["policies"]
```

### Get the public OpenAPI spec (no token required)
```bash
# Returns the full OAS for the gateway's current kind configuration
curl http://localhost:8081/api/v1/openapi.json | jq .
```

### Get the personalized OpenAPI spec (with token)
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8081/api/v1/openapi.json | jq .
```

### Test a protected endpoint
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8081/api/v1/books

# Expected: 200 OK with JSON array (empty [] if no records yet)
# If 401: JWT is invalid, expired, or iss mismatch — see Common Gotchas
# If 403: OPA denied the operation
# If 503: EPS is not reachable from the gateway
```

### Test OPA policy directly (bypass the gateway)

This is useful for debugging authorization decisions without any Spring Boot filter chain in the way:

```bash
echo '{
  "input": {
    "token": {
      "payload": {
        "sub": "user",
        "roles": ["tarcinapp.member"],
        "email_verified": true
      }
    },
    "request": {
      "method": "POST",
      "routeId": "createEntity"
    },
    "app": {
      "shortcode": "tarcinapp"
    }
  }
}' | curl -s -X POST \
  http://localhost:8181/v1/data/policies/auth/routes/entities/createEntity/policy \
  -H "Content-Type: application/json" \
  -d @- | jq .
# Expected for member: {"result":{"allow":true}} (or with field restrictions)
```

Adjust `routeId` and the path segment to match the specific rule you are testing. The path mirrors the Rego package hierarchy under `policies/`.

---

## Environment Variable Summary for Local Dev

### entity-persistence-service (`.env`)

Env var names are confirmed from the configuration reference (`31_OPS_configuration-reference.md`).

| Variable | Local dev value | Notes |
|:---|:---|:---|
| `NODE_ENV` | `development` | |
| `HOST` | `localhost` | |
| `PORT` | `3000` | |
| `MONGODB_HOST` | `localhost` | or use `MONGODB_URL` |
| `MONGODB_PORT` | `27017` | |
| `MONGODB_DATABASE` | `tappdb` | |
| `ENTITY_KINDS` | `book,chapter,author` | empty = accept any kind |
| `LIST_KINDS` | `bookshelf` | |
| `RESPONSE_LIMIT_ENTITY` | `100` | |
| `LOG_LEVEL` | `debug` | |

> Normalization config (`ENTITY_AUTO_APPROVE`, `ENTITY_DEFAULT_VISIBILITY`, `ENTITY_DEFAULT_KIND`, etc.) belongs to EPBO, not EPS. See the EPBO section in [`31_OPS_configuration-reference.md`](./31_OPS_configuration-reference.md).

### entity-persistence-gateway (`application-dev.yaml`)

| Property | Local dev value | Notes |
|:---|:---|:---|
| `app.inbound.port` | `8081` | |
| `app.backend.host` | `localhost` | |
| `app.backend.port` | `3002` | points to EPBO; use `3001` for EPC-only, `3000` for EPS-only |
| `app.opa.host` | `localhost` | |
| `app.opa.port` | `8181` | |
| `app.auth.issuer` | `http://localhost:8080/realms/tarcinapp` | must match JWT `iss` exactly |
| `app.auth.clockSkewSeconds` | `3600` | large for dev tokens |
| `app.logging.http` | `TRACE` | shows full request/response bodies |
| `app.logging.tarcinapp` | `DEBUG` | |
| `spring.redis.host` | `localhost` | |

### entity-persistence-base-orchestrator (`application.properties` / env)

| Property | Local dev value | Notes |
|:---|:---|:---|
| `quarkus.http.port` | `3002` | |
| `backend.base-url` | `http://localhost:3001` | points to EPC |
| `gateway.base-url` | `http://localhost:8081` | |
| `ENTITY_DEFAULT_KIND` | `book` | (example) |
| `ENTITY_AUTO_APPROVE` | `true` | set false in production |
| `ENTITY_DEFAULT_VISIBILITY` | `protected` | `private` = owner-only |
| `quarkus.otel.enabled` | `false` | no collector locally |
| `quarkus.log.level` | `INFO` | |

---

## Ports Summary

| Service | Default local port |
|:---|:---|
| entity-persistence-service (EPS) | `3000` |
| entity-persistence-cache (EPC) | `3001` |
| entity-persistence-base-orchestrator (EPBO) | `3002` |
| entity-persistence-gateway (EPG) | `8081` |
| entity-persistence-gateway-policies (OPA) | `8181` |
| MongoDB | `27017` |
| Redis (EPG — locks, rate-limiting, `noeviction`) | `6379` |
| Redis (EPC — scope locks, findById cache, `allkeys-lfu`) | `6380` |
| Keycloak | `8080` |
| tarcinapp-base-gui (Vite dev server) | `5173` |

> **Note:** `entity-persistence-universal-orchestrator` (EPUO, port `8079`) is **not started** in local dev — it is the template source for EPBO and is not part of the runtime chain.

---

## Common Gotchas in Local Dev

### 1. JWT `iss` mismatch → 401

The `iss` claim in your dev token must match `app.auth.issuer` in `application-dev.yaml` **exactly** — it is a byte-for-byte string comparison. A trailing slash, `http` vs `https`, or a different realm name all produce 401 with a message like `JWT issuer does not match`. Check with:

```bash
# Decode your token (no verification)
echo "<token>" | cut -d. -f2 | base64 -d 2>/dev/null | jq .iss
```

Compare the output to the `issuer` value in your YAML.

### 2. OPA returns 500 → policies directory not mounted correctly

If every gateway request returns 500 and the OPA container logs show `policy not found`, the volume mount is pointing at the repo root instead of the `policies/` subdirectory. Fix: change the mount to end in `/policies:/policies` (the subdirectory, not the repo root). Then verify with `curl http://localhost:8181/v1/data`.

### 3. Gateway 503 on startup → EPS not ready yet

Spring Boot initializes routes eagerly. If EPS takes a few seconds to start, the gateway's first health probe may fail with 503. Fix: wait for EPS to pass its own health check before starting the gateway, or add a short sleep in your dev startup script:

```bash
# Wait for EPS then start gateway
until curl -sf http://localhost:3000/ping; do sleep 2; done
./mvnw spring-boot:run -Dspring-boot.run.profiles=dev
```

### 4. `_validFromDateTime` is `null` after create → `ENTITY_AUTO_APPROVE` not set on EPBO

When `ENTITY_AUTO_APPROVE=false` (the default), EPBO does not set `_validFromDateTime`. Records arrive at EPS without it and are stored as `null` — a "pending approval" state. Members querying with the default active-records filter (`sets[actives]`) will not see them. Set `ENTITY_AUTO_APPROVE=true` in your EPBO env to have `_validFromDateTime` set to `now` automatically on every create.

### 5. Record not showing up in GET → `ENTITY_DEFAULT_VISIBILITY` not set on EPBO

If `ENTITY_DEFAULT_VISIBILITY` is not set on EPBO, no visibility default is injected. Records arrive at EPS without `_visibility` and are stored without one. Depending on EPG visibility enforcement, they may be invisible. For local dev, set `ENTITY_DEFAULT_VISIBILITY=protected` in your EPBO env.

### 6. 429 on local dev → rate limiter hit

The gateway enforces a Redis-backed rate limiter per `kindAliasPath`. The default `burstCapacity` is low. If you are running automated tests or scripts, you will hit 429 quickly. Increase the burst in `application-dev.yaml`:

```yaml
app:
  kindAliasPaths:
    - alias: books
      name: book
      rateLimiter:
        replenishRate: 1000
        burstCapacity: 5000
```

Alternatively, temporarily disable the rate limiter by pointing the gateway at a Redis instance and setting a very high burst, or by removing the `rateLimiter` block from the kind alias entirely for dev.

---

## Related Documents
- `31_OPS_configuration-reference.md` — All configuration variables across all services
- `33_OPS_deployment-docker-compose.md` — Docker Compose file for full-stack local deployment
- `40_EXAMPLE_books-app.md` — Books app walkthrough with specific env var values
