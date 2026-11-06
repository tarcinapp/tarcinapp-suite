# 32_OPS_deployment-kubernetes.md

## Overview

This document describes the Kubernetes deployment layout for the Tarcinapp suite: workloads, ConfigMaps, Secrets, Service definitions, Ingress, health checks, autoscaling, and production data store guidance.

---

## Namespace

Deploy all Tarcinapp components into a dedicated namespace:
```bash
kubectl create namespace tarcinapp
```

---

## Workloads Overview

| Deployment | Image | Port | Replicas | Scaling Notes |
|:---|:---|:---|:---|:---|
| `entity-persistence-service` | `tarcinapp/entity-persistence-service:latest` | `3000` | 1+ | Stateless — all state in MongoDB; scales horizontally freely |
| `entity-persistence-gateway` | `tarcinapp/entity-persistence-gateway:latest` | `8081` | 1+ | Stateless Spring Boot app; scales horizontally freely |
| `entity-persistence-gateway-policies` | `openpolicyagent/opa:latest` or custom image | `8181` | sidecar or 1+ standalone | See OPA deployment models below |
| `entity-persistence-universal-orchestrator` | custom build | `8079` | 1+ | Stateless Quarkus app; scales freely — Camel routes are thread-safe by default with CDI singleton processors |
| `tarcinapp-base-gui` | nginx serving dist/ | `80` | 1+ | Static assets; scales freely |
| `mongodb` | `mongo:7` | `27017` | 1 (dev) / operator or Atlas (prod) | See MongoDB production notes |
| `redis-gateway` | `redis:7-alpine` | `6379` | 1 (dev) / Sentinel or Cluster (prod) | Gateway-exclusive Redis: distributed locks + rate-limiting counters. `noeviction` policy. See Redis notes. |
| `redis-epc` | `redis:7-alpine` | `6380` | 1 (dev) / Sentinel or Cluster (prod) | EPC-exclusive Redis: scope locks + findById cache. `allkeys-lfu` policy. See Redis notes. |

### Statelessness and Horizontal Scaling

**EPS (entity-persistence-service):** Fully stateless. All persistent state lives in MongoDB. You can freely increase `replicas` behind a Service without any shared-memory or sticky-session concerns.

**Gateway (entity-persistence-gateway):** Fully stateless per request. Session/rate-limit counters are stored in `redis-gateway` (shared across all replicas), so multiple gateway replicas all point to the same `redis-gateway-service`. Increase `replicas` freely.

**Orchestrator (entity-persistence-universal-orchestrator):** Fully stateless. Apache Camel routes run inside CDI singleton processor beans; by default each route invocation is independent and thread-safe. No shared mutable state between requests. Increase `replicas` freely.

### OPA Deployment Models

OPA can be deployed in two patterns. Choose based on your replica count and operational preference.

#### Model A: Sidecar (recommended for most deployments)

OPA runs as a second container in the same gateway pod. Each gateway replica gets its own OPA instance.

**Pros:**
- Zero network latency for policy evaluation (loopback call within the pod).
- No single point of failure — OPA goes down only when the gateway pod goes down.
- Policy version is always in sync with the gateway version in that pod.
- Simple `APP_OPA_HOST: "localhost"` configuration.

**Cons:**
- Each gateway replica runs its own OPA process (higher total memory usage at scale).
- Policy updates require rolling restart of gateway pods (or an OPA bundle server).

#### Model B: Standalone Deployment

OPA runs as a separate Deployment with its own Service.

**Pros:**
- Shared across all gateway replicas — fewer OPA processes to manage.
- Can be updated independently (e.g., policy hotswap without gateway restart if using OPA bundle polling).

**Cons:**
- Network hop between gateway pod and OPA pod (latency, additional failure domain).
- Requires separate Service entry (`APP_OPA_HOST: "opa-service"`).
- All gateway replicas share one OPA availability boundary.

For standalone, create a separate Deployment for OPA pointing at `APP_OPA_HOST: "opa-service"` and expose it with a ClusterIP Service on port `8181`.

---

## Secrets

Create Kubernetes Secrets for all sensitive values. Never embed these in ConfigMaps.

```bash
# JWT RS256 public key for the gateway
kubectl create secret generic gateway-auth-secret \
  --from-file=rs256PublicKey=./certs/public.pem \
  -n tarcinapp

# MongoDB credentials
kubectl create secret generic mongodb-secret \
  --from-literal=username=tappuser \
  --from-literal=password=SecurePass123! \
  -n tarcinapp

# redis-gateway password (used by the Gateway for locks and rate-limiting)
kubectl create secret generic redis-gateway-secret \
  --from-literal=password=RedisGatewayPass123! \
  -n tarcinapp

# redis-epc password (used by EPC for scope locks and findById cache)
# Also create the TLS certificate secret if TLS is enabled on redis-epc:
kubectl create secret generic redis-epc-secret \
  --from-literal=password=RedisEpcPass123! \
  -n tarcinapp
# Optional TLS — mount the CA cert so EPC can verify the redis-epc server certificate:
# kubectl create secret generic redis-epc-tls \
#   --from-file=ca.crt=./certs/redis-epc-ca.crt \
#   -n tarcinapp
```

### OIDC Discovery vs. Static Public Key

Keycloak exposes an OIDC discovery endpoint at:
```
https://<keycloak-host>/realms/<realm>/.well-known/openid-configuration
```
and a JWKS endpoint at:
```
https://<keycloak-host>/realms/<realm>/protocol/openid-connect/certs
```

**The Gateway does not currently support JWKS endpoint polling or dynamic key fetching.** It validates JWTs using the static RS256 public key configured via `APP_AUTH_RS256PUBLICKEY`. The public key must be extracted from Keycloak and stored in the secret above.

To export the public key from Keycloak:
```bash
# Keycloak Admin CLI or REST API
curl https://<keycloak-host>/realms/<realm>/protocol/openid-connect/certs \
  | jq -r '.keys[0]' | python3 -c "import sys,json,base64; ..."
# Alternatively, export from Keycloak Admin UI: Realm Settings → Keys → RS256 → Public Key
```

### JWT Signing Key Rotation Strategy

When rotating the RS256 signing key in Keycloak, there is a window during which both old and new tokens are in circulation. To avoid rejecting valid old tokens:

1. Generate the new key pair in Keycloak (set as active for new tokens).
2. Add a **second** `app.auth.providers` entry in the gateway configuration pointing to the **old** public key, with a short overlap TTL equal to your maximum token lifetime.
3. Deploy the updated gateway configuration.
4. After the overlap period (all old tokens expired), remove the second provider entry and redeploy.

Example gateway config during rotation:
```yaml
APP_AUTH_PROVIDERS_0_ISSUER: "https://auth.example.com/realms/myapp"
APP_AUTH_PROVIDERS_0_RS256PUBLICKEY: "<new-public-key>"
APP_AUTH_PROVIDERS_1_ISSUER: "https://auth.example.com/realms/myapp"
APP_AUTH_PROVIDERS_1_RS256PUBLICKEY: "<old-public-key>"
```

---

## ConfigMap: entity-persistence-service

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: eps-config
  namespace: tarcinapp
data:
  NODE_ENV: "production"
  HOST: "0.0.0.0"
  PORT: "3000"
  MONGODB_HOST: "mongodb-service"
  MONGODB_PORT: "27017"
  MONGODB_DATABASE: "tappdb"
  ENTITY_KINDS: "book,chapter,author"
  LIST_KINDS: "bookshelf,library"
  LIST_ENTITY_REL_KINDS: "contains"
  ENTITY_REACTION_KINDS: "review,like,rating"
  AUTOAPPROVE_ENTITY: "false"
  AUTOAPPROVE_LIST: "false"
  AUTOAPPROVE_LIST_ENTITY_RELATIONS: "true"
  VISIBILITY_ENTITY: "private"
  VISIBILITY_LIST: "private"
  RESPONSE_LIMIT_ENTITY: "100"
  RESPONSE_LIMIT_LIST: "100"
  ENTITY_UNIQUENESS: "where[_kind]=${_kind}&where[_slug]=${_slug}"
  LOG_LEVEL: "info"
```

---

## ConfigMap: entity-persistence-gateway

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: gateway-config
  namespace: tarcinapp
data:
  APP_NAME: "my-app"
  APP_SHORTCODE: "myapp"
  APP_INBOUND_PORT: "8081"
  APP_INBOUND_BASEURI: "/api/v1/"
  APP_BACKEND_HOST: "eps-service"
  APP_BACKEND_PORT: "3000"
  # OPA is deployed as a sidecar in the same pod, so it is reachable on localhost.
  # If using the standalone OPA deployment model instead, change this to "opa-service".
  APP_OPA_HOST: "localhost"
  APP_OPA_PORT: "8181"
  APP_AUTH_ISSUER: "https://auth.example.com/realms/myapp"
  APP_AUTH_CLOCKSKEWSECONDS: "60"
  # Gateway uses its own dedicated Redis instance (redis-gateway).
  # This instance holds distributed locks and rate-limiting counters only.
  # Eviction policy: noeviction — lock keys must never be silently dropped.
  # Persistence: disabled (no RDB/AOF) — lock/counter state does not survive restarts.
  SPRING_REDIS_HOST: "redis-gateway-service"
  SPRING_REDIS_PORT: "6379"
  # Logging levels (package-level control for Tarcinapp internals and infrastructure)
  APP_LOGGING_TARCINAPP: "INFO"    # Root log level for com.tarcinapp.* classes
  APP_LOGGING_HTTP: "WARN"         # Log level for HTTP client/server traffic
  APP_LOGGING_GATEWAY: "INFO"      # Log level for gateway routing and filter logic
  # Kind aliases (maps friendly URL path segments to internal kind names)
  APP_KINDALIASPATHS_0_ALIAS: "books"
  APP_KINDALIASPATHS_0_NAME: "book"
  APP_KINDALIASPATHS_1_ALIAS: "shelves"
  APP_KINDALIASPATHS_1_NAME: "shelf"
  # Saved query shortcuts
  APP_QUERIES_MY: "'sets[owners][userIds]='+#userId"
  APP_QUERIES_ACTIVES: "'sets[actives]'"
  # Route toggles
  APP_ROUTES_TAGS_DISABLED: "generic"
```

---

## ConfigMap: entity-persistence-universal-orchestrator

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: orchestrator-config
  namespace: tarcinapp
data:
  QUARKUS_HTTP_PORT: "8079"
  # Gateway base URL — orchestrator calls the gateway for all data operations
  GATEWAY_BASE_URL: "http://gateway-service:8081/api/v1/"
  # Keycloak token endpoint for service-account token acquisition
  KEYCLOAK_AUTH_SERVER_URL: "https://auth.example.com"
  KEYCLOAK_REALM: "myapp"
  KEYCLOAK_CLIENT_ID: "orchestrator-client"
  # Logging
  QUARKUS_LOG_LEVEL: "INFO"
  QUARKUS_LOG_CATEGORY_COM_TARCINAPP_LEVEL: "INFO"
```

> **Note:** The orchestrator's Keycloak client secret must be stored in a separate Kubernetes Secret and injected as `KEYCLOAK_CLIENT_SECRET` via `secretKeyRef` (not in this ConfigMap).

---

## ConfigMap: OPA Policies

Rego policy files can be supplied to OPA in two ways. Prefer Option A for production.

**Option A: Custom Docker image with baked-in policies (recommended)**

The `entity-persistence-gateway-policies` repository ships a Dockerfile that builds an OPA image with all policy files compiled in. No volume mount is needed.

```bash
cd entity-persistence-gateway-policies
docker build -t my-registry/opa-policies:latest .
docker push my-registry/opa-policies:latest
```

In the gateway Deployment spec, replace `openpolicyagent/opa:latest` with `my-registry/opa-policies:latest` and omit the `/policies` volume and volumeMount. The image's entrypoint already loads the bundled policies.

**Option B: ConfigMap volume mount**

For smaller deployments or local testing, mount Rego files from a ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: opa-policies-cm
  namespace: tarcinapp
data:
  authz.rego: |
    package tarcinapp.authz
    # ... policy content ...
```

Mount into the OPA sidecar at `/policies` (see Deployment spec below).

**Option C: OPA Bundle init container (GitOps pattern)**

Use an init container to pull the latest policy bundle from a bundle server (e.g., an S3-compatible store or OCI registry) before OPA starts. This keeps policies decoupled from the image and enables GitOps-driven policy updates without rebuilding the container.

```yaml
initContainers:
  - name: opa-bundle-pull
    image: curlimages/curl:latest
    command:
      - sh
      - -c
      - |
        curl -fSL https://bundle-server.example.com/policies/latest.tar.gz \
          -o /bundle/bundle.tar.gz
    volumeMounts:
      - name: opa-bundle
        mountPath: /bundle
# Then in the OPA sidecar container:
# args: ["run", "--server", "--addr=0.0.0.0:8181", "--bundle", "/bundle/bundle.tar.gz"]
# volumeMounts: [{name: opa-bundle, mountPath: /bundle}]
volumes:
  - name: opa-bundle
    emptyDir: {}
```

---

## Secret References in Gateway Deployment

This full Deployment spec includes the gateway container, OPA sidecar (ConfigMap mount variant), secret injection, and health probes.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: entity-persistence-gateway
  namespace: tarcinapp
spec:
  replicas: 2
  selector:
    matchLabels:
      app: gateway
  template:
    metadata:
      labels:
        app: gateway
    spec:
      containers:
        - name: gateway
          image: tarcinapp/entity-persistence-gateway:latest
          ports:
            - containerPort: 8081
          envFrom:
            - configMapRef:
                name: gateway-config
          env:
            - name: APP_AUTH_RS256PUBLICKEY
              valueFrom:
                secretKeyRef:
                  name: gateway-auth-secret
                  key: rs256PublicKey
            - name: SPRING_REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: redis-gateway-secret
                  key: password
          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: 8081
            initialDelaySeconds: 15
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /actuator/health/liveness
              port: 8081
            initialDelaySeconds: 30
            periodSeconds: 15
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "1000m"

        # OPA sidecar — co-located with the gateway container in the same pod.
        # APP_OPA_HOST is set to "localhost" because both containers share the pod network namespace.
        # Using ConfigMap volume mount (Option B). Replace image and remove volumeMount for Option A.
        - name: opa
          image: openpolicyagent/opa:latest
          args:
            - "run"
            - "--server"
            - "--addr=0.0.0.0:8181"
            - "--log-level=info"
            - "/policies"
          ports:
            - containerPort: 8181
          volumeMounts:
            - name: opa-policies
              mountPath: /policies
              readOnly: true
          readinessProbe:
            httpGet:
              path: /health
              port: 8181
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              memory: "64Mi"
              cpu: "50m"
            limits:
              memory: "256Mi"
              cpu: "200m"
      volumes:
        - name: opa-policies
          configMap:
            name: opa-policies-cm
```

---

## Deployment: entity-persistence-service

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: entity-persistence-service
  namespace: tarcinapp
spec:
  replicas: 2
  selector:
    matchLabels:
      app: eps
  template:
    metadata:
      labels:
        app: eps
    spec:
      containers:
        - name: eps
          image: tarcinapp/entity-persistence-service:latest
          ports:
            - containerPort: 3000
          envFrom:
            - configMapRef:
                name: eps-config
          env:
            - name: MONGODB_USER
              valueFrom:
                secretKeyRef:
                  name: mongodb-secret
                  key: username
            - name: MONGODB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mongodb-secret
                  key: password
          readinessProbe:
            httpGet:
              path: /ping
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /ping
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 15
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
```

---

## Deployment: entity-persistence-universal-orchestrator

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: entity-persistence-universal-orchestrator
  namespace: tarcinapp
spec:
  replicas: 2
  selector:
    matchLabels:
      app: orchestrator
  template:
    metadata:
      labels:
        app: orchestrator
    spec:
      containers:
        - name: orchestrator
          image: tarcinapp/entity-persistence-universal-orchestrator:latest
          ports:
            - containerPort: 8079
          envFrom:
            - configMapRef:
                name: orchestrator-config
          env:
            - name: KEYCLOAK_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: orchestrator-keycloak-secret
                  key: clientSecret
          readinessProbe:
            httpGet:
              path: /q/health/ready
              port: 8079
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /q/health/live
              port: 8079
            initialDelaySeconds: 20
            periodSeconds: 15
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
```

---

## Service Definitions

All application services use `ClusterIP` (not `LoadBalancer`). External traffic enters exclusively through the Ingress controller. `ClusterIP` keeps services internal to the cluster, avoids provisioning cloud load balancers per service, and lets the Ingress handle TLS termination, routing, and security in one place.

```yaml
# EPS Service — ClusterIP, internal only; Ingress routes /api/* to gateway which calls this
apiVersion: v1
kind: Service
metadata:
  name: eps-service
  namespace: tarcinapp
spec:
  selector:
    app: eps
  ports:
    - port: 3000
      targetPort: 3000
  type: ClusterIP
---
# Gateway Service — ClusterIP, internal only; exposed externally via Ingress on /api
apiVersion: v1
kind: Service
metadata:
  name: gateway-service
  namespace: tarcinapp
spec:
  selector:
    app: gateway
  ports:
    - port: 8081
      targetPort: 8081
  type: ClusterIP
---
# Orchestrator Service — ClusterIP, internal only
apiVersion: v1
kind: Service
metadata:
  name: orchestrator-service
  namespace: tarcinapp
spec:
  selector:
    app: orchestrator
  ports:
    - port: 8079
      targetPort: 8079
  type: ClusterIP
---
# redis-gateway Service — ClusterIP, internal only
# Used by: entity-persistence-gateway (distributed locks, rate-limiting)
# Eviction policy: noeviction | Persistence: disabled
apiVersion: v1
kind: Service
metadata:
  name: redis-gateway-service
  namespace: tarcinapp
spec:
  selector:
    app: redis-gateway
  ports:
    - port: 6379
      targetPort: 6379
  type: ClusterIP
---
# redis-epc Service — ClusterIP, internal only
# Used by: entity-persistence-cache (scope locks, findById response cache)
# Eviction policy: allkeys-lfu | Persistence: disabled
apiVersion: v1
kind: Service
metadata:
  name: redis-epc-service
  namespace: tarcinapp
spec:
  selector:
    app: redis-epc
  ports:
    - port: 6379
      targetPort: 6379
  type: ClusterIP
---
# MongoDB Service — ClusterIP, internal only (omit if using Atlas/managed MongoDB)
apiVersion: v1
kind: Service
metadata:
  name: mongodb-service
  namespace: tarcinapp
spec:
  selector:
    app: mongodb
  ports:
    - port: 27017
      targetPort: 27017
  type: ClusterIP
```

---

## Ingress (Nginx)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tarcinapp-ingress
  namespace: tarcinapp
  annotations:
    # Connection and read/send timeouts for Spring Boot gateway (seconds)
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"
    # Cache static GUI assets at the proxy layer
    # nginx.ingress.kubernetes.io/proxy-cache: "on"    # Uncomment if proxy cache zone is configured
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: tls-secret
  rules:
    - host: api.example.com
      http:
        paths:
          # Keycloak auth endpoint — route to Keycloak service for token issuance and OIDC discovery
          - path: /auth
            pathType: Prefix
            backend:
              service:
                name: keycloak-service
                port:
                  number: 8080
          # API traffic — routed to the Spring Boot gateway
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: gateway-service
                port:
                  number: 8081
          # GUI static assets — routed to the nginx-served frontend
          - path: /
            pathType: Prefix
            backend:
              service:
                name: gui-service
                port:
                  number: 80
```

> **Note on `/auth` routing:** Routing `/auth` through the same Ingress is optional. If Keycloak is deployed separately (external managed instance or different namespace), remove this path rule and point `APP_AUTH_ISSUER` directly at the external Keycloak URL.

---

## Health Check Paths Reference

| Service | Path | Port | What it checks |
|:---|:---|:---|:---|
| entity-persistence-service | `/ping` | `3000` | LoopBack heartbeat + MongoDB connectivity; returns `{"greeting":"Hello from LoopBack"}` when healthy |
| entity-persistence-gateway | `/actuator/health/readiness` | `8081` | Spring Boot readiness including Redis connectivity; reports `UP` when the app can handle traffic |
| entity-persistence-gateway | `/actuator/health/liveness` | `8081` | JVM health and internal Spring context; reports `UP` as long as the process is alive and not deadlocked |
| entity-persistence-universal-orchestrator | `/q/health/ready` | `8079` | Quarkus readiness; checks Camel context is started and downstream connections are reachable |
| entity-persistence-universal-orchestrator | `/q/health/live` | `8079` | Quarkus liveness; checks the Quarkus runtime is responsive |
| OPA | `/health` | `8181` | OPA process health; returns `{}` when policy engine is ready to evaluate |

---

## PodDisruptionBudget

PDBs prevent all replicas of a deployment from being evicted simultaneously during cluster maintenance (node drains, rolling upgrades). Configure a PDB for each horizontally scaled component.

```yaml
# Gateway PDB — ensure at least 1 replica stays available during disruptions
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: gateway-pdb
  namespace: tarcinapp
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: gateway
---
# EPS PDB
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: eps-pdb
  namespace: tarcinapp
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: eps
---
# Orchestrator PDB
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: orchestrator-pdb
  namespace: tarcinapp
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: orchestrator
```

> Adjust `minAvailable` based on your replica count. For 2 replicas, `minAvailable: 1` allows one pod to be evicted at a time. For higher replica counts, consider `maxUnavailable: 25%` instead.

---

## HorizontalPodAutoscaler (HPA)

HPA automatically scales stateless workloads based on CPU (or custom metrics). Apply to the Gateway and EPS.

```yaml
# Gateway HPA — scale between 2 and 8 replicas based on CPU
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: gateway-hpa
  namespace: tarcinapp
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: entity-persistence-gateway
  minReplicas: 2
  maxReplicas: 8
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
---
# EPS HPA — scale between 2 and 6 replicas based on CPU
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: eps-hpa
  namespace: tarcinapp
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: entity-persistence-service
  minReplicas: 2
  maxReplicas: 6
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

> **Do NOT apply HPA to Redis or MongoDB.** These are stateful systems that require coordinated scaling:
> - **MongoDB** must be scaled via replica set configuration (add secondaries) or via an operator. See MongoDB production notes below.
> - **Redis** must be scaled via Redis Sentinel (HA) or Redis Cluster (sharding). Arbitrary pod scaling without proper cluster configuration leads to data loss or split-brain.

---

## MongoDB and Redis Deployment Notes

### MongoDB

A single MongoDB pod without a persistent volume and backup is **not suitable for production**. Options in order of preference:

1. **Managed MongoDB Atlas** — Fully managed, multi-region replication, automated backups, no operational overhead. Connect via the Atlas connection string in `MONGODB_HOST`/credentials.

2. **MongoDB Community Operator** (`mongodb-kubernetes-operator`) — Runs a MongoDB ReplicaSet on your cluster with automated failover. Operator manages pod lifecycle, rolling upgrades, and TLS.
   ```bash
   helm repo add mongodb https://mongodb.github.io/helm-charts
   helm install community-operator mongodb/community-operator -n tarcinapp
   ```

3. **Percona Operator for MongoDB** (`percona-server-mongodb-operator`) — Production-grade operator with backup/restore via Percona Backup for MongoDB (PBM), supports sharding, and has enterprise support options.

4. **Single pod with PersistentVolumeClaim** — Acceptable for development or low-risk staging. Requires a `PersistentVolumeClaim` backed by a reliable storage class, and a backup cron job.
   ```yaml
   volumeMounts:
     - name: mongo-data
       mountPath: /data/db
   volumes:
     - name: mongo-data
       persistentVolumeClaim:
         claimName: mongodb-pvc
   ```

### Redis

The Tarcinapp suite uses **two separate Redis instances** with different purposes and eviction policies. They must never be merged into a single instance, as their requirements conflict:

| Instance | Service name | Consumer | Purpose | Eviction policy | Persistence |
|:---|:---|:---|:---|:---|:---|
| `redis-gateway` | `redis-gateway-service:6379` | entity-persistence-gateway | Distributed locks, rate-limiting counters | `noeviction` | Disabled |
| `redis-epc` | `redis-epc-service:6379` | entity-persistence-cache | Scope locks, findById response cache | `allkeys-lfu` | Disabled |

**Why separate instances?**
Lock keys must never be silently evicted — if a lock disappears while held, the protected region loses serialisation guarantees. Cache entries are safe to evict under memory pressure. These requirements are mutually exclusive: `noeviction` prevents cache cleanup, while LRU/LFU risks silently dropping live lock keys. Two instances with separate `maxmemory` and `maxmemory-policy` settings is the only clean solution.

**Why no persistence on either instance?**
Neither Redis instance holds data that must survive a restart:
- `redis-gateway` holds lock keys (auto-expire via `lease-time`) and rate-limit counters (rolling windows). Stale counters after restart cause at most one window of incorrect rate-limit accounting — acceptable.
- `redis-epc` holds lock keys (same reasoning) and cache entries (TTL-bounded, rebuilt on first read after restart). A cold cache after restart is operationally fine.
RDB and AOF are therefore disabled on both instances. This also eliminates persistence I/O overhead.

**HA topology options (apply to each instance independently):**

1. **Redis Sentinel** — 1 primary + 2 replicas + 3 Sentinel processes. Automatic failover; use the `bitnami/redis` Helm chart with `architecture: replication` and `sentinel.enabled: true`. Recommended for most deployments.

2. **Redis Cluster** — Sharded mode for horizontal write scaling. More complex to operate; use when a single Redis primary is a throughput bottleneck (unlikely for lock workloads at normal scale).

3. **Managed Redis** — AWS ElastiCache, GCP Memorystore, or Azure Cache for Redis. Reduces operational overhead. Configure `SPRING_REDIS_HOST` / `QUARKUS_REDIS_HOSTS` to the managed endpoint.

**TLS:** Both instances should use TLS in production. For `redis-epc`, configure `QUARKUS_REDIS_HOSTS=rediss://:password@redis-epc-service:6380`. For `redis-gateway`, configure the Redisson client in the Gateway to use `rediss://` as well. Mount a CA certificate Secret if using a self-signed or private CA.

```bash
# Example: deploy redis-gateway with Bitnami Helm chart (noeviction, no persistence)
helm repo add bitnami https://charts.bitnami.com/bitnami
helm install redis-gateway bitnami/redis \
  --set architecture=replication \
  --set sentinel.enabled=true \
  --set auth.password=RedisGatewayPass123! \
  --set master.extraFlags[0]="--maxmemory-policy noeviction" \
  --set master.extraFlags[1]="--save ''" \
  --set replica.extraFlags[0]="--maxmemory-policy noeviction" \
  --set replica.extraFlags[1]="--save ''" \
  -n tarcinapp

# Example: deploy redis-epc with Bitnami Helm chart (allkeys-lfu, no persistence)
# Set --maxmemory based on estimated cache footprint: #records × avg_record_bytes × 2
helm install redis-epc bitnami/redis \
  --set architecture=replication \
  --set sentinel.enabled=true \
  --set auth.password=RedisEpcPass123! \
  --set master.extraFlags[0]="--maxmemory 512mb" \
  --set master.extraFlags[1]="--maxmemory-policy allkeys-lfu" \
  --set master.extraFlags[2]="--save ''" \
  --set replica.extraFlags[0]="--maxmemory 512mb" \
  --set replica.extraFlags[1]="--maxmemory-policy allkeys-lfu" \
  --set replica.extraFlags[2]="--save ''" \
  -n tarcinapp
```

---

## Resource Sizing Recommendations

| Component | Memory Request | Memory Limit | CPU Request | CPU Limit |
|:---|:---|:---|:---|:---|
| EPS | 256Mi | 512Mi | 100m | 500m |
| Gateway | 512Mi | 1Gi | 250m | 1000m |
| OPA (sidecar) | 64Mi | 256Mi | 50m | 200m |
| Orchestrator | 256Mi | 512Mi | 100m | 500m |
| redis-gateway | 64Mi | 128Mi | 50m | 100m |
| redis-epc | 128Mi | 512Mi | 50m | 200m |
| EPC | 256Mi | 512Mi | 100m | 500m |
| MongoDB | 1Gi | 4Gi | 500m | 2000m |

> `redis-gateway` footprint is small — only lock keys and rate-limit counters, both short-lived.
> `redis-epc` limit should be set to match the `--maxmemory` value configured on the Redis instance itself.
> Tune all values based on observed usage with `kubectl top pods`.

---

## Related Documents
- `31_OPS_configuration-reference.md` — All configuration variables
- `33_OPS_deployment-docker-compose.md` — Docker Compose equivalent
- `30_OPS_local-development.md` — Local development setup
