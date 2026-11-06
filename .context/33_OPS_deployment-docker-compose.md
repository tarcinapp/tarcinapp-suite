# 33_OPS_deployment-docker-compose.md

## Overview

A reference `docker-compose.yml` for running the full Tarcinapp stack locally or in a simple single-host deployment. Services are declared in dependency order and use `condition: service_healthy` to enforce startup sequencing.

---

## Directory Layout

The compose file assumes sibling repository checkouts. Clone all repos under one parent directory:

```
~/tarcinapp/
├── docker-compose.yml          ← lives here
├── .env                        ← secrets (see .env section below)
├── entity-persistence-gateway-policies/   ← cloned sibling
│   └── policies/
├── entity-persistence-service/            ← cloned sibling (optional build)
├── entity-persistence-gateway/           ← cloned sibling (optional build)
├── entity-persistence-universal-orchestrator/  ← cloned sibling (optional build)
└── tarcinapp-base-gui/                    ← cloned sibling (optional build)
```

> **Important:** The OPA volume mount `./entity-persistence-gateway-policies/policies:/policies:ro`
> requires the `entity-persistence-gateway-policies` repository to be cloned as a sibling of
> the directory where `docker-compose.yml` lives. If it is in a different location, update
> the mount path accordingly.

---

## `.env` File — Externalizing Secrets

Sensitive values such as the RS256 public key, Redis password, and MongoDB credentials should
**not** be inlined in `docker-compose.yml`. Instead, place them in a `.env` file next to the
compose file (or in a dedicated secrets file) and reference them via `env_file:` or
shell-variable interpolation.

**Example `.env`:**
```dotenv
# JWT RS256 public key — paste the full PEM block, using literal \n for newlines,
# OR use a multi-line value if your shell / Docker version supports it.
APP_AUTH_RS256PUBLICKEY=-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...\n-----END PUBLIC KEY-----

# Redis password (leave blank if not configured)
REDIS_PASSWORD=

# MongoDB credentials (uncomment if auth is enabled)
# MONGO_INITDB_ROOT_USERNAME=root
# MONGO_INITDB_ROOT_PASSWORD=strongpassword
# MONGODB_USER=appuser
# MONGODB_PASSWORD=apppassword
```

Add `.env` to `.gitignore` so it is never committed:
```bash
echo ".env" >> .gitignore
```

Reference the file in the gateway service with:
```yaml
env_file:
  - .env
```

When `env_file` is present, Docker Compose loads every variable from `.env` into that
service's environment **in addition to** any `environment:` keys. Variables defined in
`environment:` take precedence over those in `env_file`.

---

## Full Stack `docker-compose.yml`

> **Note on `version:`** The top-level `version` key (e.g. `version: "3.9"`) is **deprecated**
> as of Docker Compose v2 / Docker Desktop 4.x and Docker Engine 20.10+. Modern Docker Compose
> ignores it and reads the Compose Specification directly. You may omit it entirely in new files.
> It is shown here only for compatibility with older tooling.

```yaml
# version: "3.9"   # Deprecated — safe to omit with Docker Compose v2 / Engine 20.10+

networks:
  tarcinapp:
    driver: bridge

volumes:
  mongodb_data:
  redis_gateway_data:
  redis_epc_data:

services:

  # ─────────────────────────────────────────────────────────────
  # Infrastructure: MongoDB
  # ─────────────────────────────────────────────────────────────
  mongodb:
    image: mongo:7
    container_name: tarcinapp-mongodb
    networks:
      - tarcinapp
    volumes:
      - mongodb_data:/data/db
    environment:
      MONGO_INITDB_DATABASE: tappdb
      # Uncomment to enable auth (then also set MONGODB_USER/PASSWORD on eps):
      # MONGO_INITDB_ROOT_USERNAME: ${MONGO_INITDB_ROOT_USERNAME}
      # MONGO_INITDB_ROOT_PASSWORD: ${MONGO_INITDB_ROOT_PASSWORD}
    ports:
      - "27017:27017"
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s

  # ─────────────────────────────────────────────────────────────
  # Infrastructure: redis-gateway
  # Used by: entity-persistence-gateway
  # Purpose: distributed locks + rate-limiting counters
  # Eviction policy: noeviction (lock keys must never be dropped)
  # Persistence: disabled (lock/counter state is ephemeral)
  # ─────────────────────────────────────────────────────────────
  redis-gateway:
    image: redis:7-alpine
    container_name: tarcinapp-redis-gateway
    networks:
      - tarcinapp
    volumes:
      - redis_gateway_data:/data
    ports:
      - "6379:6379"
    command: >
      redis-server
      --maxmemory-policy noeviction
      --save ""
      --appendonly no
      ${REDIS_GATEWAY_PASSWORD:+--requirepass ${REDIS_GATEWAY_PASSWORD}}
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  # ─────────────────────────────────────────────────────────────
  # Infrastructure: redis-epc
  # Used by: entity-persistence-cache (EPC)
  # Purpose: scope locks + findById response cache
  # Eviction policy: allkeys-lfu (cache entries are safe to evict)
  # Persistence: disabled (cache is rebuilt on first read after restart)
  # ─────────────────────────────────────────────────────────────
  redis-epc:
    image: redis:7-alpine
    container_name: tarcinapp-redis-epc
    networks:
      - tarcinapp
    volumes:
      - redis_epc_data:/data
    ports:
      - "6380:6379"
    command: >
      redis-server
      --maxmemory 256mb
      --maxmemory-policy allkeys-lfu
      --save ""
      --appendonly no
      ${REDIS_EPC_PASSWORD:+--requirepass ${REDIS_EPC_PASSWORD}}
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  # ─────────────────────────────────────────────────────────────
  # Security: OPA (entity-persistence-gateway-policies)
  # NOTE: the policies directory is mounted from a sibling repo
  #       clone — see Directory Layout section above.
  # ─────────────────────────────────────────────────────────────
  opa:
    image: openpolicyagent/opa:latest
    container_name: tarcinapp-opa
    networks:
      - tarcinapp
    volumes:
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

  # ─────────────────────────────────────────────────────────────
  # Data Layer: entity-persistence-service
  # ─────────────────────────────────────────────────────────────
  eps:
    image: tarcinapp/entity-persistence-service:latest
    # Or build locally:
    # build:
    #   context: ./entity-persistence-service
    container_name: tarcinapp-eps
    networks:
      - tarcinapp
    depends_on:
      mongodb:
        condition: service_healthy
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: "3000"
      MONGODB_HOST: mongodb
      MONGODB_PORT: "27017"
      MONGODB_DATABASE: tappdb
      # Allowed kinds
      ENTITY_KINDS: book,chapter,author
      LIST_KINDS: bookshelf,library
      LIST_ENTITY_REL_KINDS: contains
      ENTITY_REACTION_KINDS: review,like,rating,comment
      LIST_REACTION_KINDS: like,comment
      # Auto approve — set to "true" in dev to skip approval workflows
      AUTOAPPROVE_ENTITY: "false"
      AUTOAPPROVE_LIST: "false"
      AUTOAPPROVE_LIST_ENTITY_RELATIONS: "true"
      AUTOAPPROVE_ENTITY_REACTION: "true"
      AUTOAPPROVE_LIST_REACTION: "true"
      # Visibility defaults
      VISIBILITY_ENTITY: private
      VISIBILITY_LIST: private
      # Response limits
      RESPONSE_LIMIT_ENTITY: "100"
      RESPONSE_LIMIT_LIST: "100"
      RESPONSE_LIMIT_LIST_ENTITY_REL: "100"
      RESPONSE_LIMIT_ENTITY_REACTION: "100"
      RESPONSE_LIMIT_LIST_REACTION: "100"
      # Uniqueness constraints
      ENTITY_UNIQUENESS: "where[_kind]=${_kind}&where[_slug]=${_slug}"
      RELATION_UNIQUENESS: "where[_listId]=${_listId}&where[_entityId]=${_entityId}&where[_kind]=${_kind}"
      LOG_LEVEL: info
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/ping"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

  # ─────────────────────────────────────────────────────────────
  # Orchestration Layer (opt-in via profile "full")
  # Remove or disable if not needed — gateway falls back to EPS directly.
  # ─────────────────────────────────────────────────────────────
  orchestrator:
    image: tarcinapp/entity-persistence-universal-orchestrator:latest
    # Or build locally:
    # build:
    #   context: ./entity-persistence-universal-orchestrator
    container_name: tarcinapp-orchestrator
    profiles: ["full"]   # start only with: docker-compose --profile full up -d
    networks:
      - tarcinapp
    depends_on:
      eps:
        condition: service_healthy
    # restart: on-failure:3   # Uncomment: if EPS wasn't ready the orchestrator
    #                         # will fail permanently — this auto-retries up to 3x.
    environment:
      QUARKUS_HTTP_PORT: "8079"
      BACKEND_BASE_URL: http://eps:3000
      GATEWAY_BASE_URL: http://gateway:8081
      BACKEND_HEALTH_CHECK_ENABLED: "true"
      QUARKUS_OTEL_ENABLED: "false"
      QUARKUS_LOG_LEVEL: INFO
    ports:
      - "8079:8079"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8079/q/health/ready"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s

  # ─────────────────────────────────────────────────────────────
  # Gateway & Security: entity-persistence-gateway
  # ─────────────────────────────────────────────────────────────
  gateway:
    image: tarcinapp/entity-persistence-gateway:latest
    # Or build locally:
    # build:
    #   context: ./entity-persistence-gateway
    container_name: tarcinapp-gateway
    networks:
      - tarcinapp
    depends_on:
      eps:
        condition: service_healthy
      redis-gateway:
        condition: service_healthy
      opa:
        condition: service_healthy
      # Add orchestrator dependency when the "full" profile is active:
      # orchestrator:
      #   condition: service_healthy
    # Load secrets (RS256 key, Redis password, etc.) from .env file
    # instead of inlining them here:
    env_file:
      - .env
    environment:
      APP_NAME: my-app
      APP_SHORTCODE: myapp
      APP_INBOUND_PORT: "8081"
      APP_INBOUND_ADDRESS: 0.0.0.0
      APP_INBOUND_BASEURI: /api/v1/
      # Route to orchestrator if deployed, otherwise directly to EPS:
      APP_BACKEND_HOST: orchestrator   # or: eps
      APP_BACKEND_PORT: "8079"         # or: 3000
      APP_OPA_HOST: opa
      APP_OPA_PORT: "8181"
      APP_AUTH_ISSUER: https://auth.example.com/realms/myapp
      APP_AUTH_CLOCKSKEWSECONDS: "60"
      # APP_AUTH_RS256PUBLICKEY is loaded from .env via env_file above.
      # DO NOT inline the real key here — use .env or a secrets manager.
      # Placeholder shown only for documentation purposes:
      # APP_AUTH_RS256PUBLICKEY: |
      #   -----BEGIN PUBLIC KEY-----
      #   MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
      #   -----END PUBLIC KEY-----
      SPRING_REDIS_HOST: redis-gateway
      SPRING_REDIS_PORT: "6379"
      # SPRING_REDIS_PASSWORD is loaded from .env via env_file above.
      # Set REDIS_GATEWAY_PASSWORD in .env to enable password auth on redis-gateway.
      # Kind aliases
      APP_KINDALIASPATHS_0_ALIAS: books
      APP_KINDALIASPATHS_0_NAME: book
      APP_KINDALIASPATHS_1_ALIAS: shelves
      APP_KINDALIASPATHS_1_NAME: shelf
      APP_KINDALIASPATHS_2_ALIAS: reviews
      APP_KINDALIASPATHS_2_NAME: review
      # Saved queries
      APP_QUERIES_MY: "'sets[owners][userIds]='+#userId"
      APP_QUERIES_ACTIVES: "'sets[actives]'"
      # Disable generic routes to expose domain-only surface
      APP_ROUTES_TAGS_DISABLED: generic
      # Logging
      APP_LOGGING_TARCINAPP: INFO
      APP_LOGGING_HTTP: INFO
    ports:
      - "8081:8081"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8081/actuator/health/readiness"]
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 30s

  # ─────────────────────────────────────────────────────────────
  # Client: tarcinapp-base-gui (opt-in via profile "full")
  # ─────────────────────────────────────────────────────────────
  gui:
    image: tarcinapp/tarcinapp-base-gui:latest
    # Or build locally:
    # build:
    #   context: ./tarcinapp-base-gui
    container_name: tarcinapp-gui
    profiles: ["full"]   # start only with: docker-compose --profile full up -d
    networks:
      - tarcinapp
    depends_on:
      gateway:
        condition: service_healthy
    environment:
      # NOTE: this env var is used by server-side rendering inside the container.
      # It MUST use the Docker-internal DNS name "gateway", not "localhost".
      # When a user opens the GUI in their browser, the browser connects to
      # http://localhost:8081 — NOT http://gateway:8081 (which only resolves inside Docker).
      TAPP_API_ENDPOINT: http://gateway:8081
    ports:
      - "80:80"
```

---

## Minimal Stack (no orchestrator, no GUI)

Remove the `orchestrator` and `gui` services, and point the gateway's backend directly at EPS:
```yaml
APP_BACKEND_HOST: eps
APP_BACKEND_PORT: "3000"
```
Also remove the commented-out `orchestrator` dependency block from the gateway's `depends_on`.

---

## Environment-Specific Overrides

Use `docker-compose.override.yml` to apply local-dev tweaks **without modifying the main
`docker-compose.yml`**. Docker Compose automatically merges `docker-compose.override.yml`
into the base file when both are present in the same directory.

**`docker-compose.override.yml`** (local dev example):
```yaml
# Local development overrides — do NOT commit secrets here.
# This file is auto-merged by: docker-compose up

services:

  eps:
    environment:
      # Skip approval queue in local dev
      AUTOAPPROVE_ENTITY: "true"
      AUTOAPPROVE_LIST: "true"

  gateway:
    environment:
      # Verbose HTTP request/response logging for local debugging
      APP_LOGGING_HTTP: TRACE
      # Disable rate limiting (remove the rate-limit filter) for local dev
      APP_RATELIMIT_ENABLED: "false"

  orchestrator:
    environment:
      # Increase clock skew tolerance for dev tokens issued by local Keycloak
      APP_AUTH_CLOCKSKEWSECONDS: "3600"
```

To use overrides explicitly (e.g. in CI where auto-merge is undesirable):
```bash
docker-compose -f docker-compose.yml -f docker-compose.override.yml up -d
```

Add `docker-compose.override.yml` to `.gitignore` if it contains personal settings,
or commit a sanitized version (no secrets) for the team.

---

## Profiles

Docker Compose **profiles** let you selectively start optional services without editing the
compose file. In the full compose above, `orchestrator` and `gui` both declare
`profiles: ["full"]`, which means they are **opt-in** — they will not start unless you pass
`--profile full`.

| Command | What starts |
|:---|:---|
| `docker-compose up -d` | `mongodb`, `redis-gateway`, `redis-epc`, `opa`, `eps`, `gateway` |
| `docker-compose --profile full up -d` | All services including `orchestrator`, `epc`, and `gui` |

You can define additional profiles (e.g. `dev`, `monitoring`) and attach them to any service.
A service with no `profiles` key always starts regardless of which `--profile` flags are used.

---

## Usage

```bash
# Start the core stack (mongodb, redis, opa, eps, gateway)
docker-compose up -d

# Start the full stack including orchestrator and GUI
docker-compose --profile full up -d

# Check all service health states
docker-compose ps

# Tail logs for a single service
docker-compose logs -f gateway

# Tail logs for multiple services simultaneously
docker-compose logs -f eps gateway

# Get an interactive shell inside a running container (useful for debugging)
docker-compose exec eps sh

# Rebuild a single service image and restart it (after local code changes)
docker-compose up -d --build eps

# Stop all services
docker-compose down

# Stop and remove volumes (full reset — destroys all data)
docker-compose down -v

# Restart a crashed service (e.g. orchestrator failed because EPS wasn't ready yet)
docker-compose restart orchestrator
```

---

## DNS Names

### Within the Docker network (container-to-container)

Services address each other using their Compose service names as DNS hostnames:

| Service name | Role | Internal health endpoint |
|:---|:---|:---|
| `mongodb` | MongoDB | — (mongosh ping) |
| `redis-gateway` | Redis for Gateway | — (redis-cli ping) |
| `redis-epc` | Redis for EPC | — (redis-cli ping) |
| `opa` | OPA policy engine | `http://opa:8181/health` |
| `eps` | entity-persistence-service | `http://eps:3000/ping` |
| `orchestrator` | universal orchestrator | `http://orchestrator:8079/q/health/ready` |
| `epc` | entity-persistence-cache | `http://epc:3001/q/health/ready` |
| `gateway` | entity-persistence-gateway | `http://gateway:8081/actuator/health/readiness` |
| `gui` | tarcinapp-base-gui | `http://gui:80` |

### From the host machine (outside Docker)

Services with published `ports` are accessible at `http://localhost:{port}`:

| Service | Host URL |
|:---|:---|
| MongoDB | `localhost:27017` |
| redis-gateway | `localhost:6379` |
| redis-epc | `localhost:6380` |
| OPA | `http://localhost:8181` |
| EPS | `http://localhost:3000` |
| Orchestrator | `http://localhost:8079` |
| EPC | `http://localhost:3001` |
| Gateway | `http://localhost:8081` |
| GUI | `http://localhost:80` |

### Important: browser vs Docker DNS

When a user opens the GUI in a browser on the host machine, the browser connects to the
gateway at **`http://localhost:8081`** — not `http://gateway:8081`. The hostname `gateway`
is only resolvable inside the Docker network. The GUI's server-side `TAPP_API_ENDPOINT` env
var is intentionally set to `http://gateway:8081` because that render path runs inside the
container, but any **client-side** API calls from the browser must target `http://localhost:8081`.

---

## Startup Order

```
mongodb ──────────────────→ eps ──→ orchestrator ──→ epc ──→ gateway ──→ gui
                               ↑                       ↑
redis-gateway ─────────────────┼───────────────────────┼──────────────→ gateway
                               │                       │
redis-epc ─────────────────────┼───────────────────────┘
                               │
opa ───────────────────────────┘──────────────────────────────────────→ gateway
```

The `depends_on` + `condition: service_healthy` directives enforce this order. Each service
waits for its dependencies to pass their health checks before starting.

### Orchestrator restart caveat

The orchestrator uses `condition: service_healthy` on `eps`, but if EPS is not yet healthy
when the orchestrator container starts (e.g. on a cold boot of a slow machine), the orchestrator
process itself may fail to connect and exit with an error. Docker does **not** automatically
restart it after the `depends_on` condition is met — it only enforces the condition at
**container start time**.

To handle this, add a restart policy:
```yaml
orchestrator:
  restart: on-failure:3   # retry up to 3 times before giving up
```

If the orchestrator is stuck after startup, restart it manually:
```bash
docker-compose restart orchestrator
```

---

## Keycloak Integration (Optional)

To run Keycloak locally as the identity provider, add it to the compose file:

```yaml
  # ─────────────────────────────────────────────────────────────
  # Identity Provider: Keycloak (optional)
  # ─────────────────────────────────────────────────────────────
  keycloak:
    image: quay.io/keycloak/keycloak:24.0
    container_name: tarcinapp-keycloak
    networks:
      - tarcinapp
    command: start-dev
    environment:
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: admin
    ports:
      - "8080:8080"
```

Once Keycloak is running:

1. **Create a realm** named `tarcinapp` at `http://localhost:8080`.
2. **Set the issuer** on the gateway. From inside Docker, Keycloak is reachable as `keycloak`,
   so set:
   ```yaml
   APP_AUTH_ISSUER: http://keycloak:8080/realms/tarcinapp
   ```
3. **Obtain the RS256 public key** from the realm's OIDC metadata endpoint:
   ```
   http://localhost:8080/realms/tarcinapp
   ```
   The response JSON contains a `"public_key"` field — a base64-encoded DER key. Wrap it in
   PEM headers to construct the full key value for `APP_AUTH_RS256PUBLICKEY`:
   ```
   -----BEGIN PUBLIC KEY-----
   <public_key value from the JSON>
   -----END PUBLIC KEY-----
   ```
   Store this in `.env` as `APP_AUTH_RS256PUBLICKEY` (see `.env` section above).

4. **Add `keycloak` to the gateway's `depends_on`** to ensure it starts first:
   ```yaml
   gateway:
     depends_on:
       keycloak:
         condition: service_started   # Keycloak has no standard healthcheck image
   ```

---

## Connecting the GUI

If you access the GUI from a browser on the host machine, the gateway is at `http://localhost:8081`.
Configure the GUI's SetupScreen with:
- **API endpoint:** `http://localhost:8081`
- **Bearer token:** your JWT (obtained from Keycloak or another IdP)

The GUI renders the API surface based on whatever the gateway serves via
`GET /api/v1/openapi.json`.

---

## Related Documents
- `30_OPS_local-development.md` — Manual dev setup without Docker Compose
- `31_OPS_configuration-reference.md` — Full environment variable reference
- `32_OPS_deployment-kubernetes.md` — Production Kubernetes deployment
