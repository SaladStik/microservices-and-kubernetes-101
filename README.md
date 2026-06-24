<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# Orbit, event driven microservices on Kubernetes

A small, complete, runnable system that shows how to build an event driven microservice platform and deploy it with Kubernetes and GitOps.

You can read it in an afternoon. It uses the same patterns you would use in production. An edge proxy, an auth service, an event bus, change data capture, GitOps with Argo CD, and a CI pipeline that rebuilds only the service you changed.

## The mental model

A browser talks to nginx over HTTPS. That is the only thing exposed to the world. Plain HTTP on :80 redirects to :443. nginx asks the auth service whether a request is allowed before letting anything through, so the internal microservices never implement auth. Login is request and response. The auth service handles it, stores a session in Redis, and hands back an opaque cookie. Starting a job is not an auth question, so nginx routes that command straight to the node-gateway, which publishes an event to Kafka and instantly replies that the job is accepted. The python-worker consumes that event, does the work, and writes the result to Postgres. Debezium notices the row change and publishes another event. The node-gateway consumes it and pushes the result to your browser over a WebSocket. Every job is recorded in Postgres, so you can log out, come back later, and still see jobs that finished while you were gone. Nothing calls anything else directly to do work. Everything that matters happens through events.

The flow in order.

1. The browser talks to nginx over HTTPS on :443.
2. nginx asks the auth service to verify the session, or routes a command to the node-gateway.
3. The node-gateway publishes the command as an event to the Kafka topic `job.requests`.
4. The python-worker consumes the event, does the work, and writes the result to Postgres.
5. Debezium reads the Postgres write ahead log and publishes a change event to the Kafka topic `orbit.public.jobs`.
6. The node-gateway consumes that change event and pushes the result to the browser over a WebSocket.

See the bite sized diagrams in [`docs/diagrams/`](docs/diagrams). Each one explains a single hop in this flow.

## Components

1. `nginx` is the edge proxy and the only public surface. It handles TLS, the allowlist, and delegates auth.
2. `ui` is a React static SPA with a public home, login, and job console. It carries no auth code.
3. `auth` is the Node.js auth authority. It handles login, Redis sessions, and the `auth_request` verifier.
4. `node-gateway` is the Node.js event hub. It enqueues job commands, consumes CDC, and serves history and the WebSocket. It carries no auth code.
5. `python-worker` is the Python event consumer. It does the work and writes results to Postgres. It carries no auth code.
6. `redis` is the server side session store. Sessions are revocable with a sliding TTL.
7. `kafka` (Strimzi) is a three node KRaft quorum event bus.
8. `postgres` is the system of record with logical replication on for CDC.
9. `debezium-connect` is Kafka Connect with the Debezium Postgres connector for CDC.

The business microservices `ui`, `node-gateway`, and `python-worker` carry zero auth code. That is the whole point of putting auth at the edge with nginx and the auth service.

## Repository layout

Each service owns its source, Dockerfile, and Kubernetes manifests in a `k8s/` subfolder. Each also has a `NOTES.md` with the key points for that service, kept out of the code so the source reads like real, lean code. Shared platform infra lives separately.

```
services/            Each service: source + Dockerfile + its own k8s/ manifests
  nginx/             Edge reverse proxy (TLS, allowlist, auth_request) + certs/
  ui/                React SPA (Vite) - public home, login, job console
  auth/               The auth authority (Redis sessions, auth_request verifier)
  node-gateway/      Enqueues commands, consumes CDC, serves history + WebSocket
  python-worker/     Event consumer + DB writer
  debezium-connect/  Strimzi Kafka Connect image with the Debezium plugin baked in
db/init/             Postgres schema + logical-replication setup
docker-compose.yml   Run the WHOLE system locally with no Kubernetes
pnpm-workspace.yaml  Monorepo: pnpm manages the JS services (see docs/monorepo-pnpm.md)
k8s/
  kind/              Local multi-node cluster definition
  infra/             Namespace, NetworkPolicy, Postgres, Redis, Strimzi Kafka, Debezium
argocd/              Argo CD Projects, Applications, Image Updater config
.github/workflows/   CI: build ONLY the changed service, push to GHCR
docs/                Step-by-step guides
  diagrams/          Bite-sized PlantUML diagrams (one hop each)
```

## Two ways to run it

Run it local with no Kubernetes. This is fastest, so start here to understand the app.

```bash
cp .env.example .env
make certs          # generate a self-signed TLS cert for the edge
docker compose up --build
# open https://localhost   (accept the self-signed cert warning; login: admin / admin)
# http://localhost also works - it 301-redirects to https, demonstrating why :80 and :443 differ
```

Run it on Kubernetes with GitOps. This is where it gets interesting. Follow the guides in order.

Once it is running, try the persistence demo. Start a job, log out, wait, then log back in. The finished job is still listed because the history comes from Postgres. That proves the result survived independently of your session.

## Guides (read in order)

New here? Start with [`docs/READING-PATH.md`](docs/READING-PATH.md). It lays out the core spine to read first, the event driven round trip on Docker Compose, versus the advanced modules to layer on after, which are Kubernetes, Strimzi, GitOps, and CI.

1. [`docs/00-overview.md`](docs/00-overview.md) the big picture and the event flow
2. [`docs/events-and-jobs.md`](docs/events-and-jobs.md) event queue and job lifecycle, explained
3. [`docs/monorepo-pnpm.md`](docs/monorepo-pnpm.md) the monorepo and pnpm workspace
4. [`docs/01-prerequisites.md`](docs/01-prerequisites.md) install Docker, kind, kubectl, helm, pnpm
5. [`docs/02-run-local-compose.md`](docs/02-run-local-compose.md) run it all on Docker Compose
6. [`docs/03-kind-cluster.md`](docs/03-kind-cluster.md) create the local Kubernetes cluster
7. [`docs/04-kafka-strimzi.md`](docs/04-kafka-strimzi.md) the three node KRaft Kafka quorum
8. [`docs/05-postgres-debezium-cdc.md`](docs/05-postgres-debezium-cdc.md) Postgres and Debezium CDC
9. [`docs/06-services-and-auth.md`](docs/06-services-and-auth.md) nginx allowlist and auth service auth and TLS
10. [`docs/07-argocd-setup.md`](docs/07-argocd-setup.md) install Argo CD, user accounts and RBAC
11. [`docs/08-cicd-and-image-updater.md`](docs/08-cicd-and-image-updater.md) CI and GitHub PAT and Image Updater
12. [`docs/09-troubleshooting.md`](docs/09-troubleshooting.md) when things go wrong
13. [`docs/10-autoscaling.md`](docs/10-autoscaling.md) autoscale the worker on Kafka backlog with KEDA

## Naming contract (used everywhere)

Keep these consistent if you fork the repo. Every manifest and service depends on them.

1. Kubernetes namespace is `orbit`.
2. Image registry is `ghcr.io/<OWNER>/orbit-<service>`.
3. Kafka cluster is `orbit-kafka` (Strimzi).
4. Kafka bootstrap is `orbit-kafka-kafka-bootstrap.orbit.svc:9092`.
5. Request topic is `job.requests`.
6. CDC topic prefix is `orbit`, giving the CDC topic `orbit.public.jobs`.
7. Postgres host and db is `postgres.orbit.svc:5432` and db `orbit`.
8. Redis sessions live at `redis://redis.orbit.svc:6379`.
9. Jobs table is `public.jobs(id, payload, owner, status, result, …)`.
10. Session cookie is `orbit_token`, an opaque session id that maps to Redis.
11. Edge ports are `:80`, which redirects, and `:443` for HTTPS.
12. Demo login is `admin` / `admin`. Change it for anything real.

Replace `your-org`, the literal placeholder, with your GitHub org or user. It appears in `services/*/k8s/kustomization.yaml` and `argocd/**`, and the CI workflow normalizes it automatically.

This repo is an example project. The demo credentials, in cluster secrets, and self signed setup are deliberately simple. The [security notes](docs/06-services-and-auth.md#what-makes-this-secure-and-what-doesnt) call out exactly what you would harden for production.
