# 30_OPS_local-development.md

## Overview

This guide explains how to run the Tarcinapp stack locally for development. It covers the minimum viable topology (EPS + Gateway), adding the orchestrator, and connecting the GUI.

---

## Minimum Viable Local Topology

For most development work, you need:
1. **MongoDB** — data storage
2. **Redis** — distributed locking and rate limiting
3. **OPA** — policy evaluation
4. **entity-persistence-service** — REST backend
5. **entity-persistence-gateway** — API gateway (calls OPA and EPS)

The orchestrator and GUI are optional add-ons.

---

## Starting Dependencies with Docker

### Step 1: Start infrastructure services

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

# OPA with policies
docker run -d --name tarcinapp-opa \
  -p 8181:8181 \
  -v $(pwd)/entity-persistence-gateway-policies/policies:/policies \
  openpolicyagent/opa:latest \
  run --server --addr 0.0.0.0:8181 /policies
```

### Step 2: Start entity-persistence-service

```bash
cd entity-persistence-service

# Option A: with a .env file
cp dev.env .env
# Edit .env: set MONGODB_HOST=localhost, MONGODB_PORT=27017, etc.
npm install
npm start    # listens on :3000

# Option B: in-memory MongoDB (dev/test only)
# Just start without MONGODB_HOST configured — EPS auto-starts an in-memory MongoDB
npm start
```

Key `.env` settings for local dev:
```bash
NODE_ENV=development
HOST=localhost
PORT=3000
MONGODB_HOST=localhost
MONGODB_PORT=27017
MONGODB_DATABASE=tappdb
# leave MONGODB_USER / MONGODB_PASSWORD empty for unauthenticated local MongoDB

ENTITY_KINDS=book,chapter,author
LIST_KINDS=bookshelf
AUTOAPPROVE_ENTITY=true
VISIBILITY_ENTITY=protected
RESPONSE_LIMIT_ENTITY=100
```

### Step 3: Start entity-persistence-gateway

```bash
cd entity-persistence-gateway
```

Create `src/main/resources/application-dev.yaml` (gitignored):
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
    # For local dev, use a test RS256 key pair or disable auth
    rs256PublicKey: |
      -----BEGIN PUBLIC KEY-----
      ... your test public key ...
      -----END PUBLIC KEY-----
    issuer: http://localhost:8080/realms/tarcinapp
    clockSkewSeconds: 3600  # large skew for dev tokens

spring:
  redis:
    host: localhost
    port: 6379
    database: 0
    password: ""

# Add a test kind alias for books
app:
  kindAliasPaths:
    - alias: books
      name: book
```

Start the gateway (VSCode or Maven):
```bash
# Maven
./mvnw spring-boot:run -Dspring-boot.run.profiles=dev

# Or configure VSCode to add -Dspring.profiles.active=dev
```

---

## VSCode Development Setup

The gateway repository includes a `.vscode/` directory. Configure `launch.json`:
```json
{
  "type": "java",
  "request": "launch",
  "name": "Gateway (dev)",
  "mainClass": "com.tarcinapp.entitypersistencegateway.EntityPersistenceGatewayApplication",
  "vmArgs": "-Dspring.profiles.active=dev"
}
```

For EPS:
```json
{
  "type": "node",
  "request": "launch",
  "name": "EPS",
  "program": "${workspaceFolder}/entity-persistence-service/dist/index.js",
  "envFile": "${workspaceFolder}/entity-persistence-service/dev.env"
}
```

---

## Generating a Dev JWT

For local testing without a running Keycloak, generate a test JWT signed with your dev RS256 key pair.

**Minimal JWT payload:**
```json
{
  "sub": "local-dev-user",
  "roles": ["tarcinapp.admin"],
  "groups": [],
  "email_verified": true,
  "iss": "http://localhost:8080/realms/tarcinapp",
  "exp": 9999999999
}
```

Tools for signing:
- [jwt.io](https://jwt.io) — paste your private key and sign manually
- [pyjwt CLI](https://pyjwt.readthedocs.io/): `pyjwt --key=private.pem encode sub=local-dev-user roles='["tarcinapp.admin"]'`

Use the token in requests:
```bash
curl -H "Authorization: Bearer <token>" http://localhost:8081/api/v1/books
```

---

## Adding the Orchestrator to Local Dev

If you need the orchestrator in the chain:

```bash
cd entity-persistence-universal-orchestrator

# Edit application.properties (or override via env):
# backend.base-url=http://localhost:3000
# gateway.base-url=http://localhost:8081

./mvnw quarkus:dev   # starts on :8079
```

Then update the gateway's backend config to point to the orchestrator:
```yaml
# application-dev.yaml
app:
  backend:
    host: localhost
    port: 8079
```

Now the chain is: `Gateway :8081 → Orchestrator :8079 → EPS :3000 → MongoDB`

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

Or drag-and-drop the bundled `oas.json` from the repo root to work in offline mode.

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
```

### Is OPA running?
```bash
curl http://localhost:8181/health
# Expected: {"status":"ok"}
```

### Test a protected endpoint with JWT:
```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:8081/api/v1/books

# Expected: 200 OK with JSON array (empty or with records)
# If 401: JWT is invalid or wrong issuer
# If 403: OPA denied the operation
```

### Get the personalized OpenAPI spec:
```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:8081/api/v1/openapi.json | jq .
```

---

## Environment Variable Summary for Local Dev

### entity-persistence-service (dev.env)
| Variable | Local dev value |
|:---|:---|
| `NODE_ENV` | `development` |
| `HOST` | `localhost` |
| `PORT` | `3000` |
| `MONGODB_HOST` | `localhost` |
| `MONGODB_PORT` | `27017` |
| `MONGODB_DATABASE` | `tappdb` |
| `ENTITY_KINDS` | `book,chapter,author` |
| `AUTOAPPROVE_ENTITY` | `true` |
| `VISIBILITY_ENTITY` | `protected` |
| `LOG_LEVEL` | `debug` |

### entity-persistence-gateway (application-dev.yaml)
| Property | Local dev value |
|:---|:---|
| `app.inbound.port` | `8081` |
| `app.backend.host` | `localhost` |
| `app.backend.port` | `3000` |
| `app.opa.host` | `localhost` |
| `app.opa.port` | `8181` |
| `app.auth.clockSkewSeconds` | `3600` (for dev tokens) |
| `spring.redis.host` | `localhost` |

### entity-persistence-universal-orchestrator (application.properties)
| Property | Local dev value |
|:---|:---|
| `quarkus.http.port` | `8079` |
| `backend.base-url` | `http://localhost:3000` |
| `gateway.base-url` | `http://localhost:8081` |
| `quarkus.otel.enabled` | `false` (no collector locally) |

---

## Ports Summary

| Service | Default local port |
|:---|:---|
| entity-persistence-service | `3000` |
| entity-persistence-gateway | `8081` |
| entity-persistence-universal-orchestrator | `8079` |
| entity-persistence-gateway-policies (OPA) | `8181` |
| MongoDB | `27017` |
| Redis | `6379` |
| Keycloak | `8080` |
| tarcinapp-base-gui (dev server) | `5173` |

---

## Related Documents
- `31_OPS_configuration-reference.md` — All configuration variables across all services
- `33_OPS_deployment-docker-compose.md` — Docker Compose file for full-stack local deployment
- `40_EXAMPLE_books-app.md` — Books app walkthrough with specific env var values
