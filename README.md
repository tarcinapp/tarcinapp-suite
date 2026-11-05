# Tarcinapp Suite

**Tarcinapp Suite** is a containerized microservices framework engineered to accelerate SaaS product development. It solves the hard architectural problems of the **post-login phase**: multi-tenant data isolation, fine-grained authorization, relational data modeling, and lifecycle management — all delivered as configuration, not code.

Instead of writing a backend from scratch, you configure Tarcinapp to project any business domain (books, products, orders, users' playlists…) onto a battle-tested generic REST infrastructure. A new resource type is a handful of environment variables. Custom business logic goes in a single, well-defined place: the **Orchestration Layer**.

> **For AI agents:** Start at [`.context/00_SYSTEM_MANIFEST.md`](.context/00_SYSTEM_MANIFEST.md). It contains the authoritative identity, architecture, data contract, and security philosophy of the entire suite. All other `.context/` documents link from it.

---

## What you get out of the box

- **Full CRUD REST API** for any domain — `GET /books`, `POST /books`, `PATCH /books/{id}`, `DELETE /books/{id}` — without writing backend code.
- **JWT authentication** + **OPA-based fine-grained authorization** down to the field level.
- **Role-based field masking**: different users see different fields on the same endpoint.
- **Polymorphic data model**: entities, lists, relations, and reactions — one database, many business domains.
- **Soft deletion & temporal validity**: `_validFromDateTime` / `_validUntilDateTime` on every record.
- **Hierarchical data**: parent/child trees via `_parents` / `_children`.
- **Distributed locking** (Redis) + **MongoDB transactions** for safe concurrent writes.
- **JSON Schema validation** per domain object, per HTTP verb.
- **Query abstraction**: saved queries, field sets, simplified query parameters.
- **Rate limiting**, **request size limiting**, **local response caching**.
- **Dynamic OpenAPI generation** — personalized per caller based on their role and OPA policies.
- **OAS-driven admin UI** — `tarcinapp-base-gui` builds its entire interface from the spec at runtime.
- **Observability**: Prometheus metrics, distributed tracing (OpenTelemetry), structured logging.

---

## Components

| Repository | Layer | Technology | Role |
|:---|:---|:---|:---|
| [`entity-persistence-service`](https://github.com/tarcinapp/entity-persistence-service) | Data | Node.js / LoopBack 4 / MongoDB | Generic REST backend. Exposes 67 endpoints for all record types with no business logic. |
| [`entity-persistence-gateway`](https://github.com/tarcinapp/entity-persistence-gateway) | Gateway & Security | Java 21 / Spring Cloud Gateway / Redis | API gateway, PEP. Authentication, authorization, field masking, domain projection, locking, caching, OAS generation. |
| [`entity-persistence-gateway-policies`](https://github.com/tarcinapp/entity-persistence-gateway-policies) | Gateway & Security | OPA / Rego | Authorization policies. Defines who can do what to which record and which fields are forbidden per role. |
| [`entity-persistence-universal-orchestrator`](https://github.com/tarcinapp/entity-persistence-universal-orchestrator) | Orchestration | Java 17 / Quarkus / Apache Camel | Business logic template. Pre/post-processor hooks for every backend endpoint. Clone and extend per product. |
| [`tarcinapp-base-gui`](https://github.com/tarcinapp/tarcinapp-base-gui) | Client | React 18 / Vite / Tailwind CSS | Domain-agnostic admin UI. Builds navigation, forms, and data grids from the gateway's live OpenAPI spec. |
| [`tarcinapp-suite`](https://github.com/tarcinapp/tarcinapp-suite) *(this repo)* | Documentation | — | Suite-level documentation, architecture reference, and AI-agent context files. |

**Infrastructure services** (not repos — deployed instances of existing products):
- **MongoDB** — primary data store
- **Redis** — distributed locking, rate limiting, local caching
- **Keycloak** — identity provider, JWT issuance
- **OPA** — policy engine (runs alongside the gateway)
- **Nginx** — ingress proxy, TLS termination
- **RabbitMQ** — async work queue bus
- **Redpanda / Kafka** — event backbone
- **Meilisearch** — search engine
- **S3 / MinIO** — object storage

**Planned repos** (part of the full architecture vision, not yet created):
- `tarcinapp-ingress-proxy` — custom Nginx configuration repo for edge routing
- `tarcinapp-ui-server` — SSR engine for dynamic SaaS frontends
- `entity-search-gateway` — read-only search gateway proxying Meilisearch
- `entity-persistence-bff-orchestrator` — page-aggregator BFF for SSR UIs
- `entity-search-indexer` — Camel Quarkus service that writes CDC events into Meilisearch
- `entity-s3-orchestrator` — Camel Quarkus service for S3-compatible object storage
- `entity-cdc-event-producer` — Debezium-based CDC connector config/wrapper
- `entity-event-transformer` — Camel Quarkus domain event transformer
- `entity-event-consumer` — Camel Quarkus reactive event consumer

---

## Architecture overview

### Current (implemented) topology

```
Browser / API Client
  └── entity-persistence-gateway  (Spring Cloud Gateway)
        ↔ OPA  (entity-persistence-gateway-policies)
        ↔ Redis  (locks, rate limiting, caching)
        └── entity-persistence-universal-orchestrator  (optional)
              └── entity-persistence-service  (Node.js LoopBack 4)
                    └── MongoDB
```

### Full target topology (includes planned components)

```
Browser / API Client
  └── Nginx (tarcinapp-ingress-proxy)  [planned repo]
        ├── /auth  →  Keycloak  [infrastructure]
        ├── /api   →  entity-persistence-gateway  (Spring Cloud Gateway)
        │               ↔ OPA  (entity-persistence-gateway-policies)
        │               ↔ Redis  [infrastructure]
        │               └── entity-persistence-universal-orchestrator  (optional)
        │                     └── entity-persistence-service  (Node.js LoopBack 4)
        │                           └── MongoDB  [infrastructure]
        └── /search →  entity-search-gateway  [planned repo]  →  Meilisearch  [infrastructure]
```

The gateway is the system's **Policy Enforcement Point**: every request is authenticated, authorized, schema-validated, and field-masked before any data is touched. The backing service (`entity-persistence-service`) is intentionally dumb — it stores and retrieves JSON, nothing more. All domain intelligence lives in configuration and OPA policies.

See [`.context/00_SYSTEM_MANIFEST.md`](.context/00_SYSTEM_MANIFEST.md) for the full six-layer architecture diagram and component descriptions.

---

## Quick concept: the data model

All business data is stored as one of five **generic record types**, differentiated by the `_kind` field:

| Record type | Typical use | Example `_kind` values |
|:---|:---|:---|
| `entities` | Primary domain objects | `book`, `product`, `order` |
| `lists` | Groupings / collections | `bookshelf`, `category`, `playlist` |
| `relations` | Many-to-many links between a list and an entity | `book-in-shelf`, `product-in-category` |
| `entityReactions` | User interactions on entities | `book-review`, `product-rating` |
| `listReactions` | User interactions on lists | `playlist-like`, `shelf-comment` |

Every record is automatically decorated with **managed fields** — underscore-prefixed system attributes that drive security, ownership, lifecycle, and audit (`_id`, `_kind`, `_visibility`, `_ownerUsers`, `_validFromDateTime`, `_createdBy`, …). See [`.context/00_SYSTEM_MANIFEST.md § 4`](.context/00_SYSTEM_MANIFEST.md) for the full managed fields reference.

---

## Documentation plan (`.context/`)

The `.context/` folder is the machine-readable knowledge base for this suite. Its target audience is AI agents and developers who need to understand the system fast. Documents are numbered to express reading order and relative scope.

### Context documents

| File | Description |
|:---|:---|
| [`00_SYSTEM_MANIFEST.md`](.context/00_SYSTEM_MANIFEST.md) | System identity, six-layer architecture, full data contract (managed fields), security philosophy, API surface overview |
| [`10_COMPONENT_entity-persistence-service.md`](.context/10_COMPONENT_entity-persistence-service.md) | 67 endpoints by controller, EPS config reference (kinds, uniqueness, auto-approve, visibility, record limits, idempotency), query language |
| [`11_COMPONENT_entity-persistence-gateway.md`](.context/11_COMPONENT_entity-persistence-gateway.md) | Gateway tech stack, 140-route topology (base generic + kind alias), every filter with its config key, domain projection mechanics, dynamic OAS generation |
| [`12_COMPONENT_gateway-policies.md`](.context/12_COMPONENT_gateway-policies.md) | OPA policy structure, role hierarchy, two-pass authorization (operation + field), ownership/visibility/activeness axioms, field exception guide, JWT structure |
| [`13_COMPONENT_universal-orchestrator.md`](.context/13_COMPONENT_universal-orchestrator.md) | Quarkus + Camel architecture, pre/post-processor pattern, `EntityPersistenceClient`, how to clone and extend, OpenTelemetry wiring |
| [`14_COMPONENT_tarcinapp-base-gui.md`](.context/14_COMPONENT_tarcinapp-base-gui.md) | OAS-driven UI generation, how spec shapes nav/forms/columns, `x-base-record-type` extension, generic vs domain-projected mode, project structure |
| [`20_CONCEPT_data-model.md`](.context/20_CONCEPT_data-model.md) | Five record types deep dive, `_kind` discriminator, `tapp://` URI scheme, hierarchy mechanics, relation vs reaction, lifecycle state machine |
| [`21_CONCEPT_security-and-authorization.md`](.context/21_CONCEPT_security-and-authorization.md) | End-to-end security flow (JWT → Gateway → OPA → field masking), role decision table, visibility enforcement, distributed locking |
| [`22_CONCEPT_domain-projection.md`](.context/22_CONCEPT_domain-projection.md) | How the gateway turns `/entities` into `/books`: kind alias config, `_kind` injection, query rewriting, per-kind schema validation, OAS pruning, route toggling |
| [`23_CONCEPT_query-language.md`](.context/23_CONCEPT_query-language.md) | Full query reference: `filter[where]`, operators, `sets`, `filter[include]`, `filter[lookup]`, `through` filters, gateway simplified aliases |
| [`24_CONCEPT_orchestration-layer.md`](.context/24_CONCEPT_orchestration-layer.md) | When to use orchestration vs. gateway vs. OPA, pre/post-processor pipeline, topology wiring, decision guide |
| [`30_OPS_local-development.md`](.context/30_OPS_local-development.md) | Step-by-step local setup (Docker infra, EPS, gateway, orchestrator, GUI), dev JWT generation, port reference |
| [`31_OPS_configuration-reference.md`](.context/31_OPS_configuration-reference.md) | Master env var table for all services: EPS, gateway, orchestrator, OPA, GUI |
| [`32_OPS_deployment-kubernetes.md`](.context/32_OPS_deployment-kubernetes.md) | K8s Deployments, ConfigMaps, Secrets, Services, Ingress, health checks, resource sizing |
| [`33_OPS_deployment-docker-compose.md`](.context/33_OPS_deployment-docker-compose.md) | Full-stack `docker-compose.yml` with all services, volumes, health checks, DNS names, startup ordering |
| [`40_EXAMPLE_books-app.md`](.context/40_EXAMPLE_books-app.md) | End-to-end books app: domain design → EPS config → gateway kind aliases + schemas → Keycloak roles → API calls → GUI rendering |
| [`41_EXAMPLE_adding-a-new-kind.md`](.context/41_EXAMPLE_adding-a-new-kind.md) | Checklist for adding a new `_kind` without code; publisher, wishlist, and bookmark examples; restart requirements table |
| [`42_EXAMPLE_custom-business-logic.md`](.context/42_EXAMPLE_custom-business-logic.md) | Orchestrator extension walkthrough: clone template → implement PreProcessor → wire gateway → test; PostProcessor side-effect example |

---

## Repository structure

```
tarcinapp-suite/
├── README.md              ← You are here. Suite overview + documentation plan.
├── examples/              ← (placeholder) Example configurations and walkthroughs
│   └── README.md
└── .context/
    └── 00_SYSTEM_MANIFEST.md   ← Master architecture & data contract (AI entry point)
    └── [planned documents — see table above]
```

---

## Related documentation

Each component repository has its own `.context/` folder with deep, service-specific documentation:

- **`entity-persistence-gateway/.context/`** — 20+ documents covering every feature, filter, route topology, OAS generation, and operational guides for the gateway.
- **`entity-persistence-service/.context/`** — Feature docs for sets, hierarchies, lookups, and logging.
- **`tarcinapp-base-gui/context/`** — Full GUI context including OAS-driven rendering, managed fields reference, and query parameter resolution.

The `tarcinapp-suite/.context/` documents in this repo are the **synthesis layer**: they connect the per-repo docs into a coherent whole and provide the suite-level perspective.
