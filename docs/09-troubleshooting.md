<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# 09 Troubleshooting

> Part of the Orbit guides. Up: [Overview](00-overview.md) · Related: [Run local](02-run-local-compose.md) · [kind cluster](03-kind-cluster.md) · [Argo CD](07-argocd-setup.md)

A practical FAQ for when Orbit misbehaves. Each entry gives the symptom, the likely cause, and the fix. Jump to the section that matches what you are seeing.

1. [Reading logs for each service](#reading-logs-for-each-service)
2. [Cannot reach https://localhost, connection refused on 443](#cant-reach-httpslocalhost--connection-refused-on-443)
3. [Browser warns your connection is not private](#browser-warns-your-connection-is-not-private)
4. [CDC events never arrive, connector-init fails](#cdc-events-never-arrive--connector-init-fails)
5. [WebSocket never delivers done](#websocket-never-delivers-done)
6. [Login fails, 500 on login](#login-fails--500-on-login)
7. [Logged out unexpectedly](#logged-out-unexpectedly)
8. [Job history empty after re-login](#job-history-empty-after-re-login)
9. [Images will not pull (`ImagePullBackOff`)](#images-wont-pull--imagepullbackoff)
10. [Strimzi Kafka pods stuck `Pending`](#strimzi-kafka-pods-stuck-pending)
11. [kind, port 80 or 443 already in use](#kind-port-80--443-already-in-use)
12. [Argo CD app OutOfSync or Degraded](#argo-cd-app-outofsync--degraded)

---

## Reading logs for each service

This is your first move for almost any problem. Pick the layer that matches the symptom.

Docker Compose.

```bash
docker compose logs -f nginx          # edge: TLS, 401s, routing, upstream errors
docker compose logs -f auth            # auth: login, sessions, /internal/verify
docker compose logs -f redis          # the auth service session store
docker compose logs -f node-gateway   # record 'queued' / produce job.requests / consume CDC / WebSocket
docker compose logs -f python-worker  # consume job / do work / INSERT into Postgres
docker compose logs -f connect        # Debezium / Kafka Connect
docker compose logs -f connector-init # one-shot connector registration
docker compose logs -f postgres
docker compose logs -f kafka
```

Kubernetes. Everything is in the `orbit` namespace.

```bash
kubectl -n orbit get pods                          # who's up, who's crashing
kubectl -n orbit logs deploy/nginx
kubectl -n orbit logs deploy/auth
kubectl -n orbit logs deploy/node-gateway
kubectl -n orbit logs deploy/python-worker
kubectl -n orbit describe pod <pod>                # events: scheduling, pulls, probes
```

Add `--previous` to a `kubectl logs` call to see a crashed container last output.

---

## Cannot reach https://localhost, connection refused on 443

Symptom. `https://localhost` will not load. You get connection refused or reset on `443`, or the nginx container keeps restarting and crash looping.

Likely cause. The TLS certs were never generated, so nginx cannot find `/etc/nginx/certs/tls.crt`. Compose bind mounts the `services/nginx/certs` folder, and if it is empty nginx fails to start its `:443` server. In Kubernetes the equivalent is the `nginx-tls` Secret being missing, so the pod cannot mount the cert volume.

Fix. On Compose, generate the cert then recreate nginx so it picks up the mount.

```bash
# Compose: generate the cert, then recreate nginx so it picks up the mount
make certs
docker compose up -d --force-recreate nginx
docker compose logs -f nginx        # should now start cleanly on :80 and :443
```

On Kubernetes, create the secret from your generated cert then restart nginx.

```bash
# Kubernetes: create the secret from your generated cert, then restart nginx
make certs        # if you haven't generated tls.crt / tls.key yet
make tls-secret   # kubectl create secret tls nginx-tls ... -n orbit
kubectl -n orbit rollout restart deploy/nginx
```

Also make sure nothing else is holding host port `443` with `lsof -i :443`.

---

## Browser warns your connection is not private

Symptom. The browser shows a security warning such as `NET::ERR_CERT_AUTHORITY_INVALID` before it will load `https://localhost`.

Likely cause. This is expected. The demo uses a self signed certificate from `make certs`, which no public CA vouches for, so the browser cannot verify it. It is not a bug. It is a good example of why real certs come from a CA.

Fix. Click through the warning with Advanced then Proceed to localhost. In production you would issue a real CA signed cert, for example cert-manager with Let's Encrypt, and the warning would disappear.

---

## CDC events never arrive, connector-init fails

Symptom. Jobs get written to Postgres (`status = done`), but the browser never updates and the gateway never logs a CDC event. Or in Compose, `connector-init` exits non zero and logs `Failed`.

Likely causes and fixes. Work down the list.

1. The connector is not RUNNING. Check its status.

   ```bash
   # Compose
   docker compose exec connect curl -s \
     localhost:8083/connectors/orbit-postgres-connector/status
   ```

   You want `"state":"RUNNING"` for both the connector and its task. A `FAILED` task includes a `trace`, so read it. A `404` means the connector was never registered. Re run `connector-init` with `docker compose up connector-init` and check `docker compose logs connector-init`.

2. Postgres is not in logical replication mode. Debezium with `pgoutput` needs `wal_level = logical`.

   ```bash
   docker compose exec postgres psql -U orbit -d orbit -c 'SHOW wal_level;'
   ```

   It must print `logical`. The Compose file sets this with `-c wal_level=logical`. If you customized it, restore that flag. Changing `wal_level` requires a Postgres restart.

3. The publication is missing. The connector reads through publication `orbit_publication` and does not auto create it, since `publication.autocreate.mode` is `disabled`.

   ```bash
   docker compose exec postgres psql -U orbit -d orbit \
     -c 'SELECT pubname FROM pg_publication;'
   ```

   You should see `orbit_publication`. It is created by [`db/init/01-schema.sql`](../db/init/01-schema.sql) on first boot only. If the volume predates that script, recreate the DB with `docker compose down -v` then `up`.

4. The replication slot is stuck or absent. The connector uses slot `orbit_slot`.

   ```bash
   docker compose exec postgres psql -U orbit -d orbit \
     -c 'SELECT slot_name, active FROM pg_replication_slots;'
   ```

   `orbit_slot` should be `active = t` while Connect runs. If a previous Connect crashed and left an inactive slot blocking things, drop it and restart Connect with `SELECT pg_drop_replication_slot('orbit_slot');`.

In Kubernetes the same checks apply through `kubectl exec` into the Postgres pod and the Connect pod. See [05 Postgres and Debezium CDC](05-postgres-debezium-cdc.md).

---

## WebSocket never delivers done

Symptom. You submitted a job, but the result never shows up in the UI.

Likely causes and fixes.

1. It has only been a few seconds and the worker is still working. The worker deliberately runs `time.sleep(3)` to simulate work. Wait about 3 seconds. Confirm it is processing with `docker compose logs -f python-worker`.

2. You are not logged in, so nginx rejects `/ws`. The `/ws` route is behind nginx `auth_request`. No valid `orbit_token` cookie, meaning no live Redis session, gives a 401 before the WebSocket ever opens. Check `docker compose logs -f nginx` for `401` on `/ws`. Fix it by logging in again. See [Login fails, 500 on login](#login-fails--500-on-login).

3. The gateway is not consuming the CDC topic. If CDC events exist but the browser sees nothing, the gateway side of the loop is down. Check `docker compose logs -f node-gateway` for it consuming `orbit.public.jobs`. If it is silent, first confirm CDC is actually flowing in the [previous section](#cdc-events-never-arrive--connector-init-fails). No CDC event means nothing for the gateway to forward.

4. CDC genuinely is not flowing. If the gateway never logs a CDC line, the problem is upstream. Go to [CDC events never arrive](#cdc-events-never-arrive--connector-init-fails).

The full path is the [end to end sequence diagram (11)](diagrams/11-end-to-end-sequence.puml).

---

## Login fails, 500 on login

Symptom. `admin` / `admin` will not log you in, the login request returns a 500, or you log in but immediately look logged out.

Likely causes and fixes.

1. Redis is down or unreachable, the usual cause of a 500. The auth service stores every session in Redis. If it cannot reach Redis, login fails hard. Confirm the store is up and the auth service points at it.

   ```bash
   # Compose
   docker compose ps redis                       # should be "healthy"
   docker compose exec redis redis-cli ping       # -> PONG
   docker compose logs -f auth                      # look for a Redis connection error

   # Kubernetes
   kubectl -n orbit get pods -l app=redis          # the redis pod should be Running/Ready
   kubectl -n orbit logs deploy/auth                 # Redis connection errors show here
   ```

   The auth service reads `REDIS_URL`. On Compose it is `redis://redis:6379`, and on Kubernetes it is the `redis` Service. If it is wrong or empty, fix it and restart the auth service. In Compose the `auth` `depends_on` Redis being healthy, so a failed Redis healthcheck also keeps the auth service from starting.

2. Wrong credentials. The demo user and password come from `.env` (`ORBIT_DEMO_USER` and `ORBIT_DEMO_PASSWORD`), defaulting to `admin` / `admin`. If you changed `.env`, use your values, or reset them and restart the auth service.

3. The cookie was not set or did not stick. Login succeeds but every request acts unauthenticated, so the `orbit_token` cookie is not being stored. This usually means you are not reaching the app through nginx. Always use <https://localhost>, the nginx edge, not a service directly, which does not even publish a port in Compose. The cookie is also marked `Secure`, so it only travels over HTTPS. Hitting plain `http://` would drop it, though the edge redirects you to `https://` anyway.

4. You bypassed nginx. The whole auth model is that nginx asks the auth service before letting anything through. Hitting a service directly skips that and breaks the session contract. Use the edge URL. Check `docker compose logs -f auth` for the login attempt and session creation, and `docker compose logs -f nginx` for the `auth_request` result.

See [06 Services and auth](06-services-and-auth.md) for how the Redis session and cookie flow works.

---

## Logged out unexpectedly

Symptom. You were logged in, but a later request bounces you back to the login page even though you did not click Logout.

Likely causes and fixes.

1. Your session TTL expired. Sessions have a sliding TTL (`ORBIT_SESSION_TTL`, default 3600s). It refreshes on every protected request, but if you go idle past the window the Redis key expires and you are logged out. Just log in again. To confirm, run `docker compose exec redis redis-cli keys 'session:*'` and your key is gone.

2. Redis restarted. In the demo, Redis holds sessions in memory with no persistence. If the `redis` container or pod restarts, every session is lost and everyone has to log in again. That is an intentional simplification. A production setup would enable AOF or RDB, or use a managed Redis. Check whether Redis bounced with `docker compose ps redis` or `kubectl -n orbit get pods -l app=redis` and look at `RESTARTS` and age.

---

## Job history empty after re-login

Symptom. You submitted jobs, logged out and back in, but your history from `GET /api/jobs` comes back empty.

Likely causes and fixes.

1. Owner mismatch, you are a different user. History is owner scoped. The gateway only returns rows whose `owner` matches the logged in user. If you log back in as a different user than the one who submitted, you see their empty history, not the original user jobs. Log in as the same user.

2. You submitted before logging in, so the owner is `anonymous`. The `owner` is taken from the `X-Auth-User` header nginx forwards after a successful `auth_request`. If a job somehow got submitted without a valid session, it is recorded as `anonymous` and will not appear under your user. Confirm what is actually in the table.

   ```bash
   docker compose exec postgres psql -U orbit -d orbit \
     -c "select owner, status, count(*) from jobs group by owner, status;"
   ```

   Jobs you started as `admin` should show `owner = admin`. The history lives in Postgres, so it survives logout and Redis restarts. Only the session is ephemeral.

---

## Images will not pull (`ImagePullBackOff`)

Symptom. `kubectl -n orbit get pods` shows `ImagePullBackOff` or `ErrImagePull`.

```bash
kubectl -n orbit describe pod <pod>   # read the Events at the bottom for the exact image + error
```

Likely causes and fixes.

1. You forgot to replace `your-org`. The manifests reference `ghcr.io/your-org/orbit-<service>`, a placeholder. Replace it with your GitHub owner. See [Prerequisites](01-prerequisites.md#replace-the-your-org-placeholder-before-the-kubernetes-guides). Find any leftovers with `grep -rn "your-org" k8s/ argocd/`.

2. The image is not in GHCR yet. The GitOps path pulls from GHCR, which only has images after CI builds and pushes them (guide 08). Either push through CI, or use the local path instead. `make load-images` builds `orbit-<svc>:dev` and loads them into kind. See [03 Build and load images](03-kind-cluster.md#step-3-optional--build--load-app-images-into-kind). If you go local, point the Deployments at the `:dev` tags and set `imagePullPolicy: IfNotPresent` so Kubernetes does not try to pull them.

3. The GHCR package is private and you have no pull secret. Either make the GHCR package public, or create an `imagePullSecret` with a GitHub PAT and reference it from the service accounts. See guide 08.

---

## Strimzi Kafka pods stuck `Pending`

Symptom. After deploying Kafka, its pods stay `Pending` and never start.

```bash
kubectl -n orbit get pods
kubectl -n orbit describe pod <kafka-pod>   # check Events
```

Likely causes and fixes.

1. The Strimzi operator is not installed. The infra kustomization declares the Kafka cluster but not the operator or CRDs. If `kubectl get crd | grep kafka` returns nothing, install the operator first (guide 04). Without it the `Kafka` resource is never reconciled into pods.

2. No storage, the PVC cannot bind. `describe pod` shows `pod has unbound immediate PersistentVolumeClaims` or a FailedScheduling event. Check the storage.

   ```bash
   kubectl -n orbit get pvc
   kubectl get storageclass   # kind ships a default 'standard' (local-path)
   ```

   On kind there should be a default StorageClass. If a PVC is `Pending`, the requested class or size does not match what is available. Align the Kafka storage config with the cluster default StorageClass.

3. Not enough resources. `Insufficient cpu/memory` in the events means Docker Desktop is too small. Raise its CPU and RAM in Settings then Resources, and recreate.

---

## kind, port 80 or 443 already in use

Symptom. `kind create cluster` fails with something like `failed to create cluster: ... port is already allocated` or `address already in use` on `80` or `443`.

Likely cause. Something else already holds host port `80` or `443`. Very often the Docker Compose demo from guide 02 is still running, since nginx maps `80` and `443`, or a previous kind cluster was not deleted. The kind config maps host `80` to `30080` and `443` to `30443`, so both ports must be free before the cluster can start.

Fix.

```bash
# Is the Compose stack still up? Stop it.
docker compose down

# Or find whatever is on 80 / 443 and stop it
lsof -i :80
lsof -i :443

# Stale kind cluster?
kind get clusters
kind delete cluster --name orbit
```

Then recreate with `make kind-up`. Avoid changing the `hostPort`s in the kind config. The `80` and `443` mappings are what make <http://localhost> redirect to and <https://localhost> reach nginx, matching every other guide.

---

## Argo CD app OutOfSync or Degraded

Symptom. In the Argo CD UI, or in `kubectl -n argocd get applications`, an app shows OutOfSync or Degraded or Missing.

```bash
kubectl -n argocd get applications
kubectl -n argocd describe application <app-name>   # Conditions + sync status
argocd app get <app-name>                           # if the argocd CLI is installed
```

Likely causes and fixes.

1. OutOfSync means the live cluster state differs from Git. That is normal right after a change. Sync it with `argocd app sync <app-name>`, or click Sync in the UI, or enable auto sync. If it will not converge, the manifests in Git may be invalid. Render them locally with `make kustomize-build` to catch errors.

2. Degraded means the resources synced but are not healthy. Drill in. It is usually a pod problem underneath, such as `ImagePullBackOff` ([see above](#images-wont-pull--imagepullbackoff)), Kafka `Pending` ([see above](#strimzi-kafka-pods-stuck-pending)), or a failing probe. Fix the underlying pod and the app goes Healthy.

3. Missing or ComparisonError means Argo cannot read the repo or path. Check the Application `repoURL`, `path`, and `targetRevision`, and that the `your-org` placeholder and repo URL are correct. See [07 Argo CD](07-argocd-setup.md).

---

Still stuck? Re read the logs for the failing layer at the [top of this page](#reading-logs-for-each-service). In an event driven system the symptom, such as no UI update, is usually several hops from the cause, such as a stuck replication slot. Follow the [event flow](00-overview.md) backward from the browser to find where the chain breaks.
