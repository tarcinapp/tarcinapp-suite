# 32_OPS_deployment-kubernetes.md

## Overview

This document describes the Kubernetes deployment layout for the Tarcinapp suite: workloads, ConfigMaps, Secrets, Service definitions, and health check paths.

---

## Namespace

Deploy all Tarcinapp components into a dedicated namespace:
```bash
kubectl create namespace tarcinapp
```

---

## Workloads Overview

| Deployment | Image | Port | Replicas |
|:---|:---|:---|:---|
| `entity-persistence-service` | `tarcinapp/entity-persistence-service:latest` | `3000` | 1+ |
| `entity-persistence-gateway` | `tarcinapp/entity-persistence-gateway:latest` | `8081` | 1+ (stateless, scales freely) |
| `entity-persistence-gateway-policies` | `openpolicyagent/opa:latest` | `8181` | 1 per gateway pod (sidecar) or 1+ standalone |
| `entity-persistence-universal-orchestrator` | custom build | `8079` | 1+ |
| `tarcinapp-base-gui` | nginx serving dist/ | `80` | 1+ |
| `mongodb` | `mongo:7` | `27017` | 1 (or managed Atlas) |
| `redis` | `redis:7-alpine` | `6379` | 1 (or managed) |

---

## Secrets

Create Kubernetes Secrets for sensitive values:

```bash
# JWT public key for the gateway
kubectl create secret generic gateway-auth-secret \
  --from-file=rs256PublicKey=./certs/public.pem \
  -n tarcinapp

# MongoDB credentials
kubectl create secret generic mongodb-secret \
  --from-literal=username=tappuser \
  --from-literal=password=SecurePass123! \
  -n tarcinapp

# Redis password
kubectl create secret generic redis-secret \
  --from-literal=password=RedisPass123! \
  -n tarcinapp
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
  APP_OPA_HOST: "localhost"     # sidecar pattern
  APP_OPA_PORT: "8181"
  APP_AUTH_ISSUER: "https://auth.example.com/realms/myapp"
  APP_AUTH_CLOCKSKEWSECONDS: "60"
  SPRING_REDIS_HOST: "redis-service"
  SPRING_REDIS_PORT: "6379"
  # Kind aliases
  APP_KINDALIASPATHS_0_ALIAS: "books"
  APP_KINDALIASPATHS_0_NAME: "book"
  APP_KINDALIASPATHS_1_ALIAS: "shelves"
  APP_KINDALIASPATHS_1_NAME: "shelf"
  # Saved queries
  APP_QUERIES_MY: "'sets[owners][userIds]='+#userId"
  APP_QUERIES_ACTIVES: "'sets[actives]'"
  # Route toggles
  APP_ROUTES_TAGS_DISABLED: "generic"
```

---

## Secret References in Gateway Deployment

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
                  name: redis-secret
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

        # OPA as sidecar
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

## ConfigMap: OPA Policies

Since the policies are Rego files, you can bundle them into a ConfigMap (for smaller deployments) or use a custom OPA bundle server / Docker image:

**Option A: Use the official Docker image (recommended)**
The `entity-persistence-gateway-policies` repo ships a Dockerfile that builds an OPA image with policies baked in:
```bash
cd entity-persistence-gateway-policies
docker build -t my-registry/opa-policies:latest .
docker push my-registry/opa-policies:latest
```

Use as sidecar: replace `openpolicyagent/opa:latest` with `my-registry/opa-policies:latest` and remove the `/policies` volume mount.

**Option B: ConfigMap mount**
For small policy sets, mount policy files from a ConfigMap (see above Deployment spec).

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

## Service Definitions

```yaml
# EPS Service (internal only)
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
# Gateway Service (exposed via Ingress)
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
# Redis Service
apiVersion: v1
kind: Service
metadata:
  name: redis-service
  namespace: tarcinapp
spec:
  selector:
    app: redis
  ports:
    - port: 6379
      targetPort: 6379
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
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"
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
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: gateway-service
                port:
                  number: 8081
          - path: /
            pathType: Prefix
            backend:
              service:
                name: gui-service
                port:
                  number: 80
```

---

## Health Check Paths Reference

| Service | Health path | Port |
|:---|:---|:---|
| entity-persistence-service | `/ping` | `3000` |
| entity-persistence-gateway | `/actuator/health/readiness` | `8081` |
| entity-persistence-gateway | `/actuator/health/liveness` | `8081` |
| entity-persistence-universal-orchestrator | `/q/health/ready` | `8079` |
| OPA | `/health` | `8181` |

---

## Resource Sizing Recommendations

| Component | Memory Request | Memory Limit | CPU Request | CPU Limit |
|:---|:---|:---|:---|:---|
| EPS | 256Mi | 512Mi | 100m | 500m |
| Gateway | 512Mi | 1Gi | 250m | 1000m |
| OPA (sidecar) | 64Mi | 256Mi | 50m | 200m |
| Orchestrator | 256Mi | 512Mi | 100m | 500m |
| Redis | 128Mi | 512Mi | 50m | 200m |
| MongoDB | 1Gi | 4Gi | 500m | 2000m |

---

## Related Documents
- `31_OPS_configuration-reference.md` — All configuration variables
- `33_OPS_deployment-docker-compose.md` — Docker Compose equivalent
- `30_OPS_local-development.md` — Local development setup
