<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# 00 Overview the big picture

Orbit is a small, complete, runnable system. Read it in an afternoon and you should walk away understanding two things well.

1. Event driven microservices done properly. Services cooperate by passing events through a queue (Kafka) instead of calling each other directly. Auth lives at the edge so the business services stay simple.
2. GitOps on Kubernetes. Git is the source of truth, Argo CD makes the cluster match git, and CI only rebuilds the one service you changed.

This page is the front door. When you want to understand the queue, read the deep dive in [`events-and-jobs.md`](events-and-jobs.md).

---

## The problem this shows

In a naive system the browser calls service A, which calls service B, which calls service C, each one waiting on the next. Everything is synchronous and tightly coupled. If the worker is slow, you wait. If you want a second worker, you have to wire the caller up to it. Every service ends up writing its own auth.

Orbit does the opposite.

1. Work is requested by publishing an event, not by calling a function. The thing that asks for work does not know or care who does it.
2. Completion is discovered, not returned. The worker updates a row in the database. Change Data Capture (CDC) turns that write into another event, and the UI learns the job is done over a WebSocket.
3. Auth lives at the edge only. nginx and the auth service decide who is allowed in. The two business services (`node-gateway`, `python-worker`) carry no auth code.
4. The work is remembered. Every job is a durable row owned by a user. You can start a job, log out, and log back in later to see it finished. The WebSocket delivers live updates and the database remembers the history.

---

## A walk through the whole flow

Follow along with the small diagrams. Each one covers a single hop. See the [diagram index](diagrams/README.md).

Step 0. You open the site over HTTPS. Everything starts at nginx, the only thing exposed to the world, and it terminates TLS. It listens on `:80` only to bounce you (`301`) to `:443`, where it serves HTTPS with a self signed demo cert. So you open `https://localhost` and `http://localhost` redirects. Inside the trusted network, services keep talking plain HTTP. TLS lives at the edge and nowhere else. See [diagram 12 TLS edge](diagrams/12-tls-edge.puml).

Step 1. You log in. For a protected route, nginx first runs an `auth_request` subrequest to the auth service. The auth service is the auth authority. On login it checks your credentials, creates a server side session in Redis (`session:<uuid>`, with a TTL), and hands the browser an opaque session id in an HttpOnly, `Secure` cookie (`orbit_token`). The cookie carries no claims. It is just a key into Redis. Later requests are verified by looking the session up, which also slides its TTL forward so active users stay logged in. Logout deletes the key and revokes the session at once. See [diagram 03 auth flow](diagrams/03-auth-flow.puml) and the deep dive in [`06-services-and-auth.md`](06-services-and-auth.md).

Step 2. You submit a job. A command goes straight to the gateway. The UI sends a `POST` to `/api/jobs`. nginx authenticates it at the edge, then proxies it directly to the node-gateway, the queue producer, bypassing the auth service. The gateway does not do the work. It records an initial `queued` row (owned by you) in Postgres, publishes an event `{jobId, payload, owner}` to the Kafka topic `job.requests`, and immediately returns `202 {jobId, status:"queued"}`. It writes the row first, then publishes. The request is done in milliseconds even though the work has not started. The point is that auth is a question for the auth service, and a job is a command. Enqueue it, send it straight to the gateway, and answer later over the WebSocket. See [diagram 04 job request flow](diagrams/04-job-request-flow.puml).

Step 3. The worker does the work. The python-worker is subscribed to `job.requests`. It picks up the event on its own schedule, simulates about 3 seconds of work by reversing the payload string, and runs an `UPDATE` on the existing row in the Postgres `jobs` table to set `status = 'completed'` while keeping its `owner`. Then it is done. It tells nobody.

Step 4. The database change becomes an event. Debezium, running inside Kafka Connect, is tailing the Postgres write ahead log. It notices the new row and publishes a change event to the topic `orbit.public.jobs`. This is the point of CDC. A plain database write becomes a real event with no extra code in the worker. See [diagram 05 CDC completion flow](diagrams/05-cdc-completion-flow.puml).

Step 5. The result rides back to your browser. The node-gateway is also a consumer of the CDC topic. When it sees the change event for your `jobId`, it pushes a `job-update` message down the WebSocket to the exact browser tab that subscribed. The UI re-renders to show done.

Step 6. The work is remembered. Every job, both the `queued` insert and the `completed` update, is a durable row in Postgres tagged with its `owner`. On login the UI loads your history with `GET /api/jobs`, also routed straight to the gateway, which runs a `SELECT` on your rows. That is the read model. So you can start a job, log out, come back later, log back in, and the finished job is still there. The WebSocket delivers live updates and the database remembers the past.

The full happy path from login through completion is [diagram 11 end to end sequence](diagrams/11-end-to-end-sequence.puml).

The key idea in one sentence. Nothing calls anything else to do work. Every step that matters is an event someone else reacts to.

---

## Components at a glance

1. `nginx` is the edge proxy and the only public surface. It terminates TLS, allowlists routes, and delegates auth. nginx, no business auth code.
2. `ui` is the React and Vite static frontend. It serves the public Home `/`, `/login`, and the guarded console `/app`.
3. `auth` is a Node.js service and the auth authority only. It handles login, logout, and me, plus the `auth_request` verifier, and it manages Redis sessions. It does auth.
4. `redis` is the server side session store (`session:<uuid>`, sliding TTL). Sessions are revocable and shared across auth service replicas.
5. `node-gateway` is a Node.js service and the event hub. It takes job commands, produces job events, consumes CDC events, runs the WebSocket server, and serves job history (the read model). It carries no auth code.
6. `python-worker` is a Python event consumer. It does the work and updates results in Postgres. It carries no auth code.
7. `kafka` (Strimzi) is the event bus. It runs a three node KRaft quorum in Kubernetes and a single node in compose.
8. `postgres` is the system of record and the read model, holding owner tagged jobs. Logical replication is on so Debezium can read the WAL.
9. `debezium-connect` is Kafka Connect plus the Debezium Postgres connector for CDC.

The two business microservices (`node-gateway`, `python-worker`) carry no auth code. That is the whole point of putting auth at the edge.

---

## Two ways to run it

First way, local with no Kubernetes. Start here. One command brings up the whole stack on Docker Compose. Only nginx publishes ports (`:80` redirecting to `:443`). Everything else is on a private network, which keeps internal services unexposed in the simplest possible way.

```bash
cp .env.example .env
make certs           # generate the self-signed TLS cert for the edge
docker compose up --build
# open https://localhost   (login: admin / admin)
# http://localhost just redirects to https. The cert is self-signed, so your
# browser will warn once, which is expected for the demo.
```

Full walkthrough in [`docs/02-run-local-compose.md`](02-run-local-compose.md).

Second way, on Kubernetes with GitOps. This is the main event. You get a local kind cluster, a three node Kafka quorum, Postgres and Debezium, the four services, and Argo CD doing GitOps. Follow the guides in order.

1. [`docs/03-kind-cluster.md`](03-kind-cluster.md) creates the cluster.
2. [`docs/04-kafka-strimzi.md`](04-kafka-strimzi.md) sets up the three node KRaft quorum.
3. [`docs/05-postgres-debezium-cdc.md`](05-postgres-debezium-cdc.md) sets up Postgres and CDC.
4. [`docs/06-services-and-auth.md`](06-services-and-auth.md) covers the nginx allowlist and auth service auth.
5. [`docs/07-argocd-setup.md`](07-argocd-setup.md) covers Argo CD, accounts, and RBAC.
6. [`docs/08-cicd-and-image-updater.md`](08-cicd-and-image-updater.md) covers CI and Image Updater.

See [diagram 08 Kubernetes topology](diagrams/08-kubernetes-topology.puml) and [diagram 09 GitOps with Argo CD](diagrams/09-gitops-argocd.puml).

---

## Where to go next

1. To understand the queue itself, read [`events-and-jobs.md`](events-and-jobs.md). It covers producers and consumers, topics, partitions, offsets, at least once delivery, the exact JSON shapes, and how to trace one job through the logs. Read this if you want to really get event queues.
2. To understand the edge, auth, and each service, read [`06-services-and-auth.md`](06-services-and-auth.md).
3. To understand the repo and tooling (the pnpm monorepo), read [`monorepo-pnpm.md`](monorepo-pnpm.md).
