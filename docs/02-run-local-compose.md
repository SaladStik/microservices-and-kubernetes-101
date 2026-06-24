<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# 02 Run it locally on Docker Compose

> Part of the Orbit guides. Back: [Prerequisites](01-prerequisites.md) · Up: [Overview](00-overview.md) · Next: [Create the kind cluster](03-kind-cluster.md)

This is the fastest way to a running Orbit. No Kubernetes and no GitOps. Docker Compose brings the whole system up on your laptop so you can watch a job travel through every hop of the event flow.

The Compose stack mirrors the Kubernetes topology with one change. It runs a single Kafka broker instead of a three node quorum. A quorum needs no extra code, just more brokers, which you see in [guide 04](04-kafka-strimzi.md).

You only need Docker for this guide. If `docker compose version` works, you are good. See [Prerequisites](01-prerequisites.md) if not.

---

## Step 1 Create your `.env`

The Compose file reads settings from a `.env` file. This covers the demo password, the database credentials, and the topic names. Copy the example as is.

```bash
cp .env.example .env
```

The defaults work for the demo. The login is `admin` / `admin`, Postgres is `orbit/orbit`, the topics are `job.requests` and `orbit.public.jobs`, and the Redis session settings are `ORBIT_SESSION_TTL` and `ORBIT_COOKIE_SECURE`. These are demo values only. Never use them for anything real.

---

## Step 2 Generate the self signed TLS cert

The edge serves HTTPS, so it needs a certificate. For the demo you generate a self signed one. A real system would get a cert from a CA.

```bash
make certs
```

This runs [`services/nginx/certs/generate-certs.sh`](../services/nginx/certs/generate-certs.sh) and writes `tls.crt` and `tls.key` into `services/nginx/certs/`. Both are gitignored. Compose bind mounts that folder into nginx at `/etc/nginx/certs`, where the proxy config expects the key and cert. The cert is never baked into the image. This is the `:80` and `:443` edge behavior. See [diagram 12 TLS edge](diagrams/12-tls-edge.puml).

`make up` runs `make certs` for you. If you use that shortcut in the next step you can skip this one. If you bring the stack up with plain `docker compose up --build`, run `make certs` first or nginx will not start.

---

## Step 3 Bring the whole stack up

```bash
docker compose up --build
```

The Makefile does the same thing. It runs `make certs`, then brings the stack up detached in the background.

```bash
make up
```

The first run builds the app images, so give it a few minutes. Compose starts the services in dependency order, not all at once.

1. `postgres` starts and runs `db/init/01-schema.sql`. This creates the `jobs` table, sets `wal_level=logical`, and creates publication `orbit_publication`. A healthcheck (`pg_isready`) must pass before dependents start.
2. `kafka` starts as a single node KRaft broker. Its healthcheck pings the broker API. Nothing that needs Kafka starts until it is healthy.
3. `connect` (Kafka Connect plus Debezium) waits for both Kafka and Postgres to be healthy, then comes up and exposes its REST API on `:8083`. Its own healthcheck calls `curl` against `/connectors`.
4. `connector-init` is a one shot container. Once `connect` is healthy, it sends a `PUT` of [`services/debezium-connect/connector.json`](../services/debezium-connect/connector.json) to `http://connect:8083/connectors/orbit-postgres-connector/config`. This registers the Debezium Postgres connector. It prints `Connector registered.` and exits. This is the step that turns on CDC.
5. `redis` starts as the auth service session store. It has a `redis-cli ping` healthcheck, and `auth` depends on it. The auth service cannot log anyone in without Redis to hold sessions (`REDIS_URL=redis://redis:6379`).
6. `node-gateway` and `python-worker` wait for Kafka before starting. The worker also waits for Postgres. The gateway connects to Postgres too. It records a `queued` row and serves job history. See the persistence demo below.
7. `auth`, `ui`, and `nginx` start. `nginx` is the only service that publishes ports, `80` and `443`. Everything else lives on the internal `orbit` network and is unreachable from your host. That is the internal network point, enforced here by not mapping ports.

You know it is ready when the logs settle. You see `connector-init` exit with `Connector registered.` and the gateway and worker waiting for events.

---

## Step 4 Use the app

Open <https://localhost> in your browser. The cert is self signed, so your browser warns that the connection is not private. That is expected here. Click through with Advanced then Proceed. If you open <http://localhost> instead, nginx answers on `:80` with a 301 redirect to `https://localhost`. Plaintext exists only to escort you to the encrypted port. That redirect is the `:80` and `:443` edge behavior. See [diagram 12](diagrams/12-tls-edge.puml).

1. The public home page (`/`) is the React UI landing page. No login required and nothing sensitive here.
2. Click Login (route `/login`) and sign in with `admin` / `admin`. The auth service checks the credentials, creates a server side session in Redis, and hands the browser only an opaque session id in the `orbit_token` cookie. The cookie is `Secure` because the edge is HTTPS now. There is no JWT. The cookie carries no claims. The real identity is the Redis lookup.
3. You land on the app (route `/app`). Submit a job. Type something like `hello orbit` and send it.
4. Watch the result arrive. After about 3 seconds the UI shows the reversed payload (`hello orbit` becomes `tibro olleh`) pushed back over the WebSocket. The 3 second pause is the worker simulated work delay (`time.sleep(3)`), not a bug. It makes the asynchronous event driven flow visible.

Here is what just happened end to end.

1. Browser to nginx to the auth service (`auth`) to `node-gateway` to Kafka `job.requests`.
2. `python-worker` reads the job, then runs `INSERT` into Postgres.
3. Debezium reads the WAL and turns it into a CDC event on Kafka `orbit.public.jobs`.
4. `node-gateway` consumes that event and pushes it over the WebSocket to the browser.

When the gateway accepts the command it also writes a `queued` row to Postgres tagged with your username as the `owner`, then publishes. That is the read model the persistence demo below relies on.

This is exactly the [Event Queue and Job Lifecycle diagram (06)](diagrams/06-event-queue-and-job-lifecycle.puml). Keep it open while you read the verification section below.

---

## Step 5 Persistence demo, log out, come back, still there

The job history survives your session because it lives in Postgres, not in the browser or in Redis. Prove it.

1. While logged in as `admin`, submit a job such as `persist me`.
2. Immediately log out, before the 3 second worker delay finishes. The server side session in Redis is destroyed and your console is empty.
3. Wait about 3 seconds. The worker is still doing its slow work and will `INSERT` the finished result whether you are logged in or not.
4. Log back in as `admin`. The console reloads your job history and the job you started earlier is now there, completed, with its reversed result.

This works because the gateway records every job in the `jobs` table tagged with the `owner` (`admin`) and serves `GET /api/jobs` as an owner scoped read model. The worker finishes the job and writes the result independent of your session. When you come back the gateway reads your history out of the database. Your session is ephemeral in Redis. Your jobs are durable in Postgres.

---

## Step 6 Verify each hop

Now prove to yourself that the job really took the long event driven road. Run these in separate terminals while you submit jobs.

### a) The gateway records the job and consumes CDC

```bash
docker compose logs -f node-gateway
```

When you submit, you see it record and produce the request, a line like `queued + published job <id> for admin`. Note the owner, `admin`, taken from the `X-Auth-User` header nginx forwards. About 3 seconds later you see it consume the CDC event from `orbit.public.jobs` and push the WebSocket update. That single service does both ends of the flow.

### b) The worker receives and processes

```bash
docker compose logs -f python-worker
```

You see it receive the job from `job.requests`, a line like `received job <id> for admin`. The same owner rides along on the event. It does its slow work and runs `INSERT` of the result into Postgres.

### c) The Debezium connector is RUNNING

The connector is on the internal network, so query its status from inside the Connect container.

```bash
docker compose exec connect curl -s \
  localhost:8083/connectors/orbit-postgres-connector/status
```

Look for `"connector":{"state":"RUNNING"}` and a task whose `"state"` is also `"RUNNING"`. If it is `FAILED` or the connector returns 404, see [Troubleshooting, CDC events never arrive](09-troubleshooting.md#cdc-events-never-arrive--connector-init-fails).

### d) Peek at the system of record

See the rows in the `jobs` table. Note the `owner` column and the lifecycle each row goes through, `queued` then `completed`.

```bash
docker compose exec postgres psql -U orbit -d orbit \
  -c 'select id, owner, status, result from jobs order by created_at;'
```

You see each job tagged with the `owner` (`admin`). A row the gateway just accepted shows `status = queued` with no `result`. Once the worker finishes it becomes `completed` with the reversed text in `result`. That `owner` column powers the owner scoped history view from the [persistence demo](#step-5-persistence-demo-log-out-come-back-still-there). Every change here also became a CDC event, which is what the gateway turned into a done message.

### e) A session really exists in Redis

When you log in, the auth service stores your session under a `session:<uuid>` key. List them from inside the Redis container.

```bash
docker compose exec redis redis-cli keys 'session:*'
```

You see one key per active login. Log out, or wait for `ORBIT_SESSION_TTL` to expire, and the key disappears. That is the revocable server side session. The `orbit_token` cookie in your browser is just the opaque UUID that points at one of these keys. It carries no claims of its own.

---

## Step 7 Tear it down

Stop the stack and remove the Postgres volume for a clean slate next time.

```bash
make down
# equivalent to: docker compose down -v
```

Drop the `-v` (`docker compose down`) if you want to keep the database between runs.

---

## Where to next

You have now seen the entire application work without any Kubernetes. From here you have a few options.

1. Want the main event, running this on Kubernetes with GitOps? Start with [03 Create the kind cluster](03-kind-cluster.md).
2. Curious why the auth and events are wired the way they are? Read [06 Services and auth](06-services-and-auth.md).
3. Hit a snag? [09 Troubleshooting](09-troubleshooting.md) has a Compose section covering connector-init failures and the WebSocket done message never arriving.
