# 33_OPS_deployment-docker-compose.md

## Overview

A reference `docker-compose.yml` for running the full Tarcinapp stack locally or in a simple single-host deployment. Services are in startup order with health-check dependencies.

---

## Full Stack `docker-compose.yml`

```yaml
version: "3.9"

networks:
  tarcinapp:
    driver: bridge

volumes:
  mongodb_data:
  redis_data:

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
      # Uncomment to enable auth:
      # MONGO_INITDB_ROOT_USERNAME: root
      # MONGO_INITDB_ROOT_PASSWORD: rootpass
    ports:
      - "27017:27017"
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s

  # ─────────────────────────────────────────────────────────────
  # Infrastructure: Redis
  # ─────────────────────────────────────────────────────────────
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

  # ─────────────────────────────────────────────────────────────
  # Security: OPA (entity-persistence-gateway-policies)
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
      # Auto approve
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
      # Uniqueness
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
  # Orchestration Layer (optional — remove if not needed)
  # ─────────────────────────────────────────────────────────────
  orchestrator:
    image: tarcinapp/entity-persistence-universal-orchestrator:latest
    # Or build locally:
    # build:
    #   context: ./entity-persistence-universal-orchestrator
    container_name: tarcinapp-orchestrator
    networks:
      - tarcinapp
    depends_on:
      eps:
        condition: service_healthy
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
      redis:
        condition: service_healthy
      opa:
        condition: service_healthy
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
      APP_AUTH_RS256PUBLICKEY: |
        -----BEGIN PUBLIC KEY-----
        MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
        -----END PUBLIC KEY-----
      SPRING_REDIS_HOST: redis
      SPRING_REDIS_PORT: "6379"
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
  # Client: tarcinapp-base-gui
  # ─────────────────────────────────────────────────────────────
  gui:
    image: tarcinapp/tarcinapp-base-gui:latest
    # Or build locally:
    # build:
    #   context: ./tarcinapp-base-gui
    container_name: tarcinapp-gui
    networks:
      - tarcinapp
    depends_on:
      gateway:
        condition: service_healthy
    environment:
      TAPP_API_ENDPOINT: http://gateway:8081
    ports:
      - "80:80"
```

---

## Minimal Stack (no orchestrator, no GUI)

Remove the `orchestrator` and `gui` services, and change the gateway's backend to point directly to EPS:
```yaml
APP_BACKEND_HOST: eps
APP_BACKEND_PORT: "3000"
```

---

## Usage

```bash
# Start full stack
docker-compose up -d

# Check all services are healthy
docker-compose ps

# View gateway logs
docker-compose logs -f gateway

# Stop all
docker-compose down

# Stop and remove volumes (full reset)
docker-compose down -v
```

---

## DNS Names

Within the Docker Compose network, services are addressable by their service names:

| Service name | Resolves to |
|:---|:---|
| `mongodb` | MongoDB |
| `redis` | Redis |
| `opa` | OPA policy engine |
| `eps` | entity-persistence-service |
| `orchestrator` | universal orchestrator |
| `gateway` | entity-persistence-gateway |
| `gui` | tarcinapp-base-gui |

---

## Startup Order

```
mongodb → eps → orchestrator → gateway
redis ─────────────────────────────────↗
opa ────────────────────────────────────↗
```

The `depends_on` + `condition: service_healthy` directives enforce this order. All services wait for their dependencies to pass health checks before starting.

---

## Connecting the GUI

If you access the GUI from a browser on the host machine, the gateway is at `http://localhost:8081`. Configure the GUI's SetupScreen with:
- **API endpoint:** `http://localhost:8081`
- **Bearer token:** your JWT

The GUI renders the API surface based on whatever the gateway serves via `GET /api/v1/openapi.json`.

---

## Related Documents
- `30_OPS_local-development.md` — Manual dev setup without Docker Compose
- `31_OPS_configuration-reference.md` — Full environment variable reference
- `32_OPS_deployment-kubernetes.md` — Production Kubernetes deployment
