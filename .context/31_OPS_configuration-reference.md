# 31_OPS_configuration-reference.md

## Overview

This is the master configuration reference for all Tarcinapp services. Variables are grouped by service. For each variable, the table shows the key name, type, default, and a brief description.

---

## entity-persistence-service

### Server
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `NODE_ENV` | string | `production` | Node environment (`development`, `production`, `test`) |
| `HOST` | string | `0.0.0.0` | Bind address |
| `PORT` | integer | `3000` | HTTP listen port |
| `LOG_LEVEL` | string | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `LOG_FORMAT` | string | `json` | Log format (`json` or `text`) |
| `REQUEST_ID_HEADER` | string | `X-Request-ID` | Header name for request ID |

### Database
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `MONGODB_URL` | string | _(none)_ | Full MongoDB connection string. Takes precedence over individual params. |
| `MONGODB_HOST` | string | `localhost` | MongoDB host |
| `MONGODB_PORT` | integer | `27017` | MongoDB port |
| `MONGODB_DATABASE` | string | `tarcinapp` | Database name |
| `MONGODB_USER` | string | _(none)_ | MongoDB username |
| `MONGODB_PASSWORD` | string | _(none)_ | MongoDB password |

### Collections (custom names)
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `COLLECTION_ENTITY` | string | `entities` | MongoDB collection for entities |
| `COLLECTION_LIST` | string | `lists` | MongoDB collection for lists |
| `COLLECTION_ENTITY_REACTIONS` | string | `entity-reactions` | MongoDB collection for entity reactions |
| `COLLECTION_LIST_REACTIONS` | string | `list-reactions` | MongoDB collection for list reactions |
| `COLLECTION_LIST_ENTITY_REL` | string | `list-entity-relations` | MongoDB collection for list-entity relations |

### Allowed Kinds
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `ENTITY_KINDS` | string | _(any)_ | Comma-separated allowed `_kind` values for entities. Empty = no restriction. |
| `LIST_KINDS` | string | _(any)_ | Comma-separated allowed `_kind` values for lists. |
| `LIST_ENTITY_REL_KINDS` | string | _(any)_ | Allowed kinds for relations. |
| `ENTITY_REACTION_KINDS` | string | _(any)_ | Allowed kinds for entity reactions. |
| `LIST_REACTION_KINDS` | string | _(any)_ | Allowed kinds for list reactions. |

### Default Kinds
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `DEFAULT_ENTITY_KIND` | string | `entity` | Default `_kind` applied when not specified for entities |
| `DEFAULT_LIST_KIND` | string | `list` | Default `_kind` for lists |
| `DEFAULT_RELATION_KIND` | string | `list-entity-relation` | Default kind for relations |
| `DEFAULT_ENTITY_REACTION_KIND` | string | `entity-reaction` | Default kind for entity reactions |
| `DEFAULT_LIST_REACTION_KIND` | string | `list-reaction` | Default kind for list reactions |

### Auto Approve
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `AUTOAPPROVE_ENTITY` | boolean | `false` | Auto-set `_validFromDateTime=now` on entity create |
| `AUTOAPPROVE_LIST` | boolean | `false` | Auto-approve lists |
| `AUTOAPPROVE_ENTITY_REACTION` | boolean | `false` | Auto-approve entity reactions |
| `AUTOAPPROVE_LIST_REACTION` | boolean | `false` | Auto-approve list reactions |
| `AUTOAPPROVE_LIST_ENTITY_RELATIONS` | boolean | `false` | Auto-approve relations |

### Default Visibility
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `VISIBILITY_ENTITY` | string | `private` | Default `_visibility` for new entities (`public`, `protected`, `private`) |
| `VISIBILITY_LIST` | string | `private` | Default visibility for lists |
| `VISIBILITY_ENTITY_REACTION` | string | `private` | Default visibility for entity reactions |
| `VISIBILITY_LIST_REACTION` | string | `private` | Default visibility for list reactions |

### Response Limits
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `RESPONSE_LIMIT_ENTITY` | integer | `100` | Maximum records per response for entities |
| `RESPONSE_LIMIT_LIST` | integer | `100` | Maximum records per response for lists |
| `RESPONSE_LIMIT_LIST_ENTITY_REL` | integer | `100` | Maximum records per response for relations |
| `RESPONSE_LIMIT_ENTITY_REACTION` | integer | `100` | Maximum records per response for entity reactions |
| `RESPONSE_LIMIT_LIST_REACTION` | integer | `100` | Maximum records per response for list reactions |

### Uniqueness Constraints
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `ENTITY_UNIQUENESS` | JSON string | _(none)_ | Uniqueness rule(s) for entities. Format: `"where[_kind]=${_kind}&where[_slug]=${_slug}"` |
| `LIST_UNIQUENESS` | JSON string | _(none)_ | Uniqueness rule(s) for lists |
| `RELATION_UNIQUENESS` | JSON string | _(none)_ | Uniqueness for relations (typically by `_listId` + `_entityId` + `_kind`) |
| `ENTITY_REACTION_UNIQUENESS` | JSON string | _(none)_ | Uniqueness for entity reactions |
| `LIST_REACTION_UNIQUENESS` | JSON string | _(none)_ | Uniqueness for list reactions |

### Record Limits
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `ENTITY_RECORD_LIMITS` | JSON array | _(none)_ | Array of limit rules. Example: `[{"scope":"","limit":500}]` |
| `LIST_RECORD_LIMITS` | JSON array | _(none)_ | Record limits for lists |
| `RELATION_RECORD_LIMITS` | JSON array | _(none)_ | Record limits for relations |
| `ENTITY_REACTION_RECORD_LIMITS` | JSON array | _(none)_ | Record limits for entity reactions |
| `LIST_REACTION_RECORD_LIMITS` | JSON array | _(none)_ | Record limits for list reactions |

Record limit rule structure:
```json
{
  "scope": "where[_kind]=book",   // filter expression (empty = global)
  "limit": 100,                   // max allowed
  "duration": "30d"               // optional: rolling window (s, m, h, d, w)
}
```

### Idempotency
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `IDEMPOTENCY_ENTITY` | string | _(none)_ | Fields contributing to entity idempotency key (comma-separated) |
| `IDEMPOTENCY_LIST` | string | _(none)_ | Fields for list idempotency |
| `IDEMPOTENCY_ENTITY_REACTION` | string | _(none)_ | Fields for entity reaction idempotency |
| `IDEMPOTENCY_LIST_REACTION` | string | _(none)_ | Fields for list reaction idempotency |
| `IDEMPOTENCY_LIST_ENTITY_REL` | string | _(none)_ | Fields for relation idempotency |

### Lookup Constraints
| Env var | Type | Default | Description |
|:---|:---|:---|:---|
| `ENTITY_LOOKUP_CONSTRAINT` | string | _(none)_ | Filter constraint applied to all entity lookup resolutions |
| `LIST_LOOKUP_CONSTRAINT` | string | _(none)_ | Filter constraint for list lookup resolutions |
| `ENTITY_REACTION_LOOKUP_CONSTRAINT` | string | _(none)_ | Filter constraint for entity reaction lookups |
| `LIST_REACTION_LOOKUP_CONSTRAINT` | string | _(none)_ | Filter constraint for list reaction lookups |

---

## entity-persistence-gateway

Spring Boot conventions: property `app.some.thing` → env var `APP_SOME_THING`. Array items: `APP_KINDALIASPATHS_0_ALIAS=books`.

### Application Identity
| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.name` | `APP_NAME` | `entity-persistence-gateway` | Application name (used in Spring context) |
| `app.shortcode` | `APP_SHORTCODE` | `tarcinapp` | Prefix for role names and request IDs |
| `app.requestId` | `APP_REQUESTID` | `X-Request-Id` | Inbound/outbound request ID header name |

### Inbound Server
| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.inbound.port` | `APP_INBOUND_PORT` | `8081` | HTTP listen port |
| `app.inbound.address` | `APP_INBOUND_ADDRESS` | `0.0.0.0` | Bind address |
| `app.inbound.baseUri` | `APP_INBOUND_BASEURI` | `/api/v1/` | Base URI prefix for all routes |

### Backend (EPS or Orchestrator)
| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.backend.protocol` | `APP_BACKEND_PROTOCOL` | `http` | Protocol for backend calls |
| `app.backend.host` | `APP_BACKEND_HOST` | `entity-persistence-service` | Backend hostname |
| `app.backend.port` | `APP_BACKEND_PORT` | `3000` | Backend port |
| `app.backend.baseURI` | `APP_BACKEND_BASEURI` | `/` | Backend base path |

### OPA
| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.opa.protocol` | `APP_OPA_PROTOCOL` | `http` | OPA protocol |
| `app.opa.host` | `APP_OPA_HOST` | `entity-persistence-gateway-policies` | OPA hostname |
| `app.opa.port` | `APP_OPA_PORT` | `8181` | OPA port |

### Authentication (JWT)
| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.auth.rs256PublicKey` | `APP_AUTH_RS256PUBLICKEY` | _(required)_ | RS256 PEM public key for JWT verification |
| `app.auth.issuer` | `APP_AUTH_ISSUER` | _(required)_ | Expected JWT issuer (`iss` claim) |
| `app.auth.clockSkewSeconds` | `APP_AUTH_CLOCKSKEWSECONDS` | `60` | Allowed JWT expiry clock skew |

### Redis
| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `spring.redis.host` | `SPRING_REDIS_HOST` | `localhost` | Redis hostname |
| `spring.redis.port` | `SPRING_REDIS_PORT` | `6379` | Redis port |
| `spring.redis.database` | `SPRING_REDIS_DATABASE` | `0` | Redis database index |
| `spring.redis.password` | `SPRING_REDIS_PASSWORD` | _(none)_ | Redis password |

### CORS
| Property | Env var example | Description |
|:---|:---|:---|
| `spring.cloud.gateway.globalcors.cors-configurations.[/**].allowedOrigins` | `SPRING_CLOUD_GATEWAY_GLOBALCORS_CORS-CONFIGURATIONS_0_ALLOWEDORIGINS` | Allowed origins |
| `spring.cloud.gateway.globalcors.cors-configurations.[/**].allowedMethods` | _(same pattern)_ | Allowed HTTP methods |
| `spring.cloud.gateway.globalcors.cors-configurations.[/**].allowedHeaders` | _(same pattern)_ | Allowed request headers |

### Route Toggles
| Property | Env var | Description |
|:---|:---|:---|
| `app.routes.disabled` | `APP_ROUTES_DISABLED` | Comma-separated route IDs to disable (`updateAllEntities,findEntities`) |
| `app.routes.tags.disabled` | `APP_ROUTES_TAGS_DISABLED` | Comma-separated route tags to disable (`generic`, `write`, etc.) |

### Kind Alias Paths (indexed array)
| Property | Env var | Description |
|:---|:---|:---|
| `app.kindAliasPaths[N].alias` | `APP_KINDALIASPATHS_N_ALIAS` | URL segment (e.g., `books`) |
| `app.kindAliasPaths[N].name` | `APP_KINDALIASPATHS_N_NAME` | `_kind` value (e.g., `book`) |
| `app.kindAliasPaths[N].schema` | `APP_KINDALIASPATHS_N_SCHEMA` | JSON Schema string for validation |
| `app.kindAliasPaths[N].hierarchyAlias` | `APP_KINDALIASPATHS_N_HIERARCHYALIAS` | Hierarchy URL alias (e.g., `chapters`) |
| `app.kindAliasPaths[N].hierarchyName` | `APP_KINDALIASPATHS_N_HIERARCHYNAME` | Hierarchy `_kind` (e.g., `chapter`) |
| `app.kindAliasPaths[N].maxRequestSize` | `APP_KINDALIASPATHS_N_MAXREQUESTSIZE` | Max payload size (e.g., `5KB`) |
| `app.kindAliasPaths[N].rateLimiter.replenishRate` | `APP_KINDALIASPATHS_N_RATELIMITER_REPLENISHRATE` | Tokens/sec for rate limiter |
| `app.kindAliasPaths[N].rateLimiter.burstCapacity` | `APP_KINDALIASPATHS_N_RATELIMITER_BURSTCAPACITY` | Max burst size |
| `app.kindAliasPaths[N].timeout` | `APP_KINDALIASPATHS_N_TIMEOUT` | Request timeout in ms |

### Fieldsets (named field selections)
| Property | Env var | Description |
|:---|:---|:---|
| `app.fieldsets.<name>.show` | `APP_FIELDSETS_<NAME>_SHOW` | Comma-separated fields to include |
| `app.fieldsets.<name>.hide` | `APP_FIELDSETS_<NAME>_HIDE` | Comma-separated fields to exclude |

Built-in defaults: `managed` (show managed fields only), `unmanaged` (hide managed fields).

### Saved Queries
| Property | Env var | Description |
|:---|:---|:---|
| `app.queries.<name>` | `APP_QUERIES_<NAME>` | SPEL expression for named query (`?q=<name>`) |

### Default Fieldsets per Record Type
| Property | Description |
|:---|:---|
| `app.defaultFieldset.entities` | Fieldset name applied automatically to entity endpoints |
| `app.defaultFieldset.lists` | Fieldset applied to list endpoints |
| `app.defaultFieldset.reactions` | Fieldset applied to reaction endpoints |

### Observability
| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `app.inbound.metricsEnabled` | `APP_INBOUND_METRICSENABLED` | `false` | Expose Prometheus `/actuator/prometheus` endpoint |
| `app.jmx` | `APP_JMX` | `false` | Enable JMX |
| `app.logging.tarcinapp` | `APP_LOGGING_TARCINAPP` | `INFO` | Log level for `com.tarcinapp.*` package |
| `app.logging.http` | `APP_LOGGING_HTTP` | `INFO` | HTTP request/response trace log level (set `TRACE` to see full bodies) |
| `app.logging.gateway` | `APP_LOGGING_GATEWAY` | `INFO` | Spring Cloud Gateway route/filter log level |
| `app.logging.redisson` | `APP_LOGGING_REDISSON` | `INFO` | Redisson Redis client log level |

---

## entity-persistence-universal-orchestrator

MicroProfile Config convention: `property.key` → `PROPERTY_KEY` (dots/hyphens → underscores, uppercased).

| Property | Env var | Default | Description |
|:---|:---|:---|:---|
| `quarkus.http.port` | `QUARKUS_HTTP_PORT` | `8079` | Orchestrator HTTP listen port |
| `backend.base-url` | `BACKEND_BASE_URL` | `http://localhost:3000` | EPS URL |
| `gateway.base-url` | `GATEWAY_BASE_URL` | `http://localhost:8081` | Gateway URL (for EntityPersistenceClient) |
| `backend.health-check.enabled` | `BACKEND_HEALTH_CHECK_ENABLED` | `true` | Probe EPS at startup |
| `backend.health-check.path` | `BACKEND_HEALTH_CHECK_PATH` | `/ping` | EPS health path |
| `backend.health-check.timeout-seconds` | `BACKEND_HEALTH_CHECK_TIMEOUT_SECONDS` | `10` | Startup probe timeout |
| `quarkus.otel.enabled` | `QUARKUS_OTEL_ENABLED` | `true` | Enable OpenTelemetry tracing |
| `quarkus.otel.exporter.otlp.endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | OTLP collector endpoint |
| `quarkus.log.level` | `QUARKUS_LOG_LEVEL` | `INFO` | Root log level |
| `quarkus.log.category."io.tarcinapp".level` | _(none, set in config)_ | `DEBUG` | Application code log level |

---

## OPA (entity-persistence-gateway-policies)

OPA is configured via command-line flags when running the Docker image:

| Flag | Description |
|:---|:---|
| `--server` | Run as HTTP server |
| `--addr 0.0.0.0:8181` | Bind address and port |
| `--log-level info` | Log level (`debug`, `info`, `error`) |
| `--set decision_logs.console=true` | Enable decision logging to stdout |

The policies directory is mounted at container start:
```bash
-v /path/to/policies:/policies
```

---

## tarcinapp-base-gui

| Env var | Default | Description |
|:---|:---|:---|
| `TAPP_API_ENDPOINT` | _(none, set at runtime)_ | Gateway URL override at build time |
| `TAPP_API_TOKEN` | _(none, set at runtime)_ | Bearer token override at build time |

Runtime configuration is stored in `localStorage` under key `tarcinapp_config` and set through the SetupScreen.

---

## Related Documents
- `30_OPS_local-development.md` — Local dev setup with specific example values
- `32_OPS_deployment-kubernetes.md` — K8s ConfigMap structure for all these variables
- `33_OPS_deployment-docker-compose.md` — Docker Compose with all services
