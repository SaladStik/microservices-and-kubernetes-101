<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# Events and Jobs the event queue explained

Read this if you want to really understand the event queue jobs at the heart of Orbit. We build the vocabulary from scratch, tie every term to a real file in this repo, then trace one job from click to done.

If you have not yet, skim [`00-overview.md`](00-overview.md) first for the big picture, then come back here.

The companion picture is [diagram 06 event queue and job lifecycle](diagrams/06-event-queue-and-job-lifecycle.puml).

---

## What is an event, a message

An event, also called a message, is a small, immutable record of something that happened or something being requested. It is data, not a function call. In Orbit, events are JSON.

There are two events in the whole system, and the difference between them is the most important idea here.

1. A command event means please do this. Example, `job.requests`. It is a request for work that has not happened yet.
2. A change event means this happened. Example, `orbit.public.jobs`. It is a fact, a database row changed, emitted by Debezium via Change Data Capture.

Same plumbing (Kafka), opposite intent. Keep them straight and the system makes sense.

---

## What is a topic

A topic is a named, append only log that events are written to and read from. Producers append to the end. Consumers read through it. Orbit has exactly two topics that matter.

1. `job.requests` is a command event. The `node-gateway` writes it and the `python-worker` reads it.
2. `orbit.public.jobs` is a change event. Debezium (Connect) writes it and the `node-gateway` reads it.

The CDC topic name is not arbitrary. Debezium builds it as `<topic.prefix>.<schema>.<table>`, which is `orbit` plus `public` plus `jobs`. You can see the prefix set in [`k8s/infra/connect/debezium-connector.yaml`](../k8s/infra/connect/debezium-connector.yaml) (`topic.prefix: orbit`) and the same config in the compose variant [`services/debezium-connect/connector.json`](../services/debezium-connect/connector.json).

---

## Producer vs consumer

A producer appends events to a topic. A consumer reads them. A single service can be both, and the node-gateway is the perfect example. It is a producer on one topic and a consumer on another.

The gateway produces to `job.requests`. See [`services/node-gateway/src/kafka.js`](../services/node-gateway/src/kafka.js).

```js
export async function publishJob(job) {
  await producer.send({
    topic: config.kafka.jobRequestsTopic,        // "job.requests"
    messages: [{ key: job.jobId, value: JSON.stringify(job) }],
  });
}
```

But before it publishes, the gateway first records the job's initial `queued` state in Postgres. It writes the row, then publishes, in [`index.js`](../services/node-gateway/src/index.js).

```js
await recordQueued({ jobId, payload, owner }); // INSERT a 'queued' row first
await publishJob({ jobId, payload, owner });   // then drop the event on Kafka
res.status(202).json({ jobId, status: "queued" });
```

Notice it never calls the worker. It just drops an event on the topic and walks away. That decoupling is the whole point. See the gateway's own comment in [`index.js`](../services/node-gateway/src/index.js), the gateway never calls the worker directly.

The worker consumes from `job.requests`. See [`services/python-worker/app/main.py`](../services/python-worker/app/main.py).

```python
consumer.subscribe([cfg.job_requests_topic])      # "job.requests"
...
event = json.loads(msg.value())
job_id = event["jobId"]
payload = event.get("payload", "")
owner = event.get("owner", "anonymous")           # carried through from the gateway
result = process(payload)                          # ~3s of fake work
db.write_result(conn, job_id, payload, result, owner)  # UPDATE the row to 'completed'
```

Debezium produces to `orbit.public.jobs`, but you write no producer code for it. It is configured, not coded. The connector tails the Postgres WAL and emits a change event for every row change to `public.jobs`.

The gateway consumes `orbit.public.jobs`, back in `kafka.js`.

```js
export async function consumeCdc(onChange) {
  const consumer = kafka.consumer({ groupId: config.kafka.cdcGroupId });
  await consumer.subscribe({ topic: config.kafka.cdcTopic, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const envelope = JSON.parse(message.value.toString());
      if (envelope && envelope.after) onChange(envelope.after, envelope.op);
    },
  });
}
```

So the gateway is a producer and a consumer. The worker is a pure consumer. Debezium is a pure, configured producer. No service ever calls another to do work.

---

## Consumer groups and scaling the worker

When a consumer subscribes, it joins a consumer group, identified by a `group.id`. Kafka guarantees that within one group, each partition of a topic is read by exactly one consumer. That single rule is what makes horizontal scaling automatic.

The worker's group id is `python-worker`. See [`config.py`](../services/python-worker/app/config.py).

```python
"group.id": self.group_id,   # default "python-worker"
```

Now imagine `job.requests` has 3 partitions.

1. One worker pod gets all 3 partitions assigned to it. It handles every job.
2. Scale to 3 worker pods with the same group id. Kafka rebalances and assigns one partition to each pod. Now three jobs can run in parallel, and you wrote zero coordination code. You just ran more copies of the same process.
3. Scale to 4 pods and one pod sits idle, because you cannot have more active consumers in a group than there are partitions. Partitions are the unit of parallelism. To go wider, add partitions.

The gateway's CDC consumer uses a different group id, `node-gateway-cdc` ([`config.js`](../services/node-gateway/src/config.js)). A different group means an independent reading position on its own topic, which is exactly what you want, since the gateway and the worker read totally different topics for different reasons.

---

## Partitions, offsets, and at least once delivery

1. A partition is one shard of a topic's log. Ordering is guaranteed within a partition, not across partitions. Orbit keys each job event by `jobId` (`key: job.jobId` above), so all events for a given job land on the same partition and stay in order relative to each other.
2. An offset is a consumer's bookmark. It means I have read up to position N in this partition. The worker commits offsets automatically (`"enable.auto.commit": True` in `config.py`).
3. At least once delivery is the consequence. A consumer might process a message and then crash before committing its offset. On restart it re-reads from the last committed offset and processes that message again. Kafka promises you will see every message at least once, possibly more than once.

The alternatives are at most once, where you commit first then process and can lose messages on a crash, and exactly once, which is possible but heavier. At least once is the common, pragmatic default, and it is what Orbit uses.

### Why the worker's INSERT uses `ON CONFLICT`, idempotency

At least once means the worker must be safe to run on the same job twice. Orbit makes the write idempotent with an upsert in [`services/python-worker/app/db.py`](../services/python-worker/app/db.py).

```sql
INSERT INTO jobs (id, payload, owner, status, result, updated_at)
VALUES (%s, %s, %s, 'completed', %s, now())
ON CONFLICT (id) DO UPDATE
    SET status = 'completed',
        result = EXCLUDED.result,
        updated_at = now();
```

In the normal flow the gateway has already inserted the `queued` row (it writes the row, then publishes), so this statement is really an `UPDATE` of that existing row to `completed`. Note that it does not touch `owner`, which was set when the job was queued. The `ON CONFLICT` clause also covers the rare race where the worker runs before the gateway's insert lands, in which case it inserts fresh. Either way, running it once or five times for the same `jobId` lands the database in the exact same state. Idempotency is how you make at least once delivery safe. This is the most important defensive pattern in event driven systems. Do not skip it.

---

## Command event vs change event, the two shapes

These two events have completely different JSON shapes because they mean different things.

### 1. The job request event, a command, topic `job.requests`

Produced by the gateway, consumed by the worker. The value is exactly what the gateway serializes.

```json
{
  "jobId": "9b2c...-uuid",
  "payload": "hello",
  "owner": "admin"
}
```

The Kafka message key is the `jobId`, so events for one job stay on one partition. The `owner` rides along so the worker preserves it on the completed row. That is it. Small and intentional.

### 2. The Debezium change event, topic `orbit.public.jobs`

Produced by Debezium when the worker's `UPDATE` hits the WAL, consumed by the gateway. Debezium wraps every change in an envelope. Because the connector sets `value.converter.schemas.enable: "false"`, the value is just the payload with no schema block. The shape follows.

```json
{
  "before": {
    "id": "9b2c...-uuid",
    "payload": "hello",
    "owner": "admin",
    "status": "queued",
    "result": null,
    "created_at": "2026-06-19T12:00:00Z",
    "updated_at": "2026-06-19T12:00:00Z"
  },
  "after": {
    "id": "9b2c...-uuid",
    "payload": "hello",
    "owner": "admin",
    "status": "completed",
    "result": "olleh",
    "created_at": "2026-06-19T12:00:00Z",
    "updated_at": "2026-06-19T12:00:10Z"
  },
  "op": "u",
  "source": { "...": "db/lsn/txid metadata" },
  "ts_ms": 1750000000000
}
```

1. `after` is the row as it now exists. The gateway only cares about this.
2. `before` is the row as it was. Here it is the `queued` state. The gateway's insert also produced its own `op: "c"` event a moment earlier. `before` is populated for updates and deletes because the schema sets `REPLICA IDENTITY FULL` in [`db/init/01-schema.sql`](../db/init/01-schema.sql).
3. `op` is the operation. `c` is create (the gateway's `queued` insert), `u` is update (the worker's `completed` write), `d` is delete, and `r` is read or snapshot. The gateway forwards each over the WebSocket, so the UI sees `queued` then `completed`.

The gateway pulls `envelope.after` and forwards just the fields the UI needs as a `job-update` WebSocket message ([`ws.js`](../services/node-gateway/src/ws.js)).

```json
{ "type": "job-update", "jobId": "9b2c...", "status": "completed", "result": "olleh" }
```

---

## The full job lifecycle state by state

One job moves through these observable states. This is the state machine in [diagram 06](diagrams/06-event-queue-and-job-lifecycle.puml).

1. Submitted. The UI sends `POST /api/jobs`. nginx authenticated it and proxied it straight to the gateway. See [`node-gateway/src/index.js`](../services/node-gateway/src/index.js) `POST /jobs`.
2. Queued. The gateway ran an `INSERT` for a `queued` row owned by the user, produced `{jobId, payload, owner}` to `job.requests`, and returned `202 {jobId, status:"queued"}`. See [`node-gateway/src/db.js`](../services/node-gateway/src/db.js) `recordQueued` and [`kafka.js`](../services/node-gateway/src/kafka.js) `publishJob`.
3. Processing. The worker consumed the event and is doing the roughly 3 seconds of work. See [`python-worker/app/main.py`](../services/python-worker/app/main.py) `process`.
4. Completed. The worker ran an `UPDATE` on the row, setting `status='completed'`, the reversed `result`, and leaving `owner` unchanged, in Postgres. See [`python-worker/app/db.py`](../services/python-worker/app/db.py) `write_result`.
5. Captured. Debezium read the WAL change and produced the envelope to `orbit.public.jobs`. Configured by [`debezium-connector.yaml`](../k8s/infra/connect/debezium-connector.yaml).
6. Delivered. The gateway consumed the CDC event and pushed `job-update` over the WebSocket. See [`node-gateway/src/ws.js`](../services/node-gateway/src/ws.js) `notifyJobUpdate`.

Between states 2 and 3 the request is already finished from the browser's point of view. It has the `jobId` and is waiting on the WebSocket. Everything after that is asynchronous and event driven. And because state 2 already wrote a durable row, the job is queryable the instant it is accepted, even if the worker has not touched it yet.

---

## Owner, the read model, and CQRS

So far we followed the write side. A command turns into events that mutate a row. But there is a second, separate path, the read side, and keeping them apart is a pattern called CQRS, which is Command Query Responsibility Segregation.

1. Every job has an `owner`. When nginx authenticates `/api/jobs`, the auth service hands back the username, which nginx forwards to the gateway as a trusted `X-Auth-User` header. The gateway stamps that onto the `queued` row as `owner`. See [`db/init/01-schema.sql`](../db/init/01-schema.sql), the `owner` column. The worker carries it through and never overwrites it. So each row knows whose job it is.
2. The write path is everything above. A command goes to `job.requests`, then the worker, then an `UPDATE`, then CDC, then the WebSocket. It is asynchronous and event driven.
3. The read path is simple and synchronous. `GET /api/jobs` goes to the gateway, which runs `SELECT … WHERE owner = $1 ORDER BY created_at DESC` ([`node-gateway/src/db.js`](../services/node-gateway/src/db.js) `listForOwner`). The same Postgres table the write side mutates is the read model the query side serves. No Kafka involved. It is just a database read.

This is why the command versus change distinction still holds and gains a third flavor. A query, what jobs do I have, is neither a command nor a change event. It is a plain request and response read of the materialized state.

### Persistence across logout

Because every job is a durable, owner tagged row, your job history outlives your session. Concretely.

1. You start a job. The gateway writes a `queued` row owned by `admin` and returns immediately.
2. You log out. The worker finishes about 3 seconds later and runs an `UPDATE` on the row to `completed`. Nobody is watching the WebSocket anymore, and that is fine.
3. You log back in. The UI calls `listJobs()`, which is `GET /api/jobs`. The gateway runs a `SELECT` on your rows, and the finished job is right there.

The WebSocket only ever delivers live updates. It has no memory of the past. The read model is the memory. The UI merges the two, history on login and live pushes after. See [`JobConsole.jsx`](../services/ui/src/components/JobConsole.jsx) and [`client.js`](../services/ui/src/backend/client.js) `listJobs`.

---

## Trace one job through the logs

The fastest way to feel the queue is to watch it. Start the stack, see [`02-run-local-compose.md`](02-run-local-compose.md).

```bash
make certs && docker compose up --build
# open https://localhost, log in admin/admin, submit a job
```

Watch the gateway produce, then later deliver. It does both jobs.

```bash
docker compose logs -f node-gateway
```

Look for these, in order.

```
[gateway] producer connected to kafka:9092
[gateway] consuming CDC topic 'orbit.public.jobs'
[gateway] queued + published job 9b2c... for admin   # state 2: Queued
[gateway] CDC u for job 9b2c... -> completed          # state 6: the CDC event came back
```

The CDC op is `u` here because the worker updated the gateway's existing `queued` row rather than inserting a fresh one.

Watch the worker consume and write.

```bash
docker compose logs -f python-worker
```

Look for these.

```
[worker] consuming 'job.requests' from kafka:9092
[worker] connected to Postgres
[worker] received job 9b2c... for admin             # state 3: Processing (then ~3s pause)
[worker] job 9b2c... -> 'olleh' written to Postgres # state 4: Completed
```

Read the two logs side by side and you will see the roughly 3 second gap between the gateway publishing and the worker finishing, and then the CDC line in the gateway log appearing after the worker's write. That gap is the whole point. The services are talking through the queue and the database, not to each other.

Want to peek at the raw events on the bus? Use the Kafka console consumer inside the broker container.

```bash
# the command (request) events
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic job.requests --from-beginning

# the change (CDC) events - you'll see the full Debezium envelope
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 --topic orbit.public.jobs --from-beginning
```

---

## Where to go next

1. The edge, auth, and each service in depth. See [`06-services-and-auth.md`](06-services-and-auth.md).
2. How the JS half is organized and built, the pnpm monorepo. See [`monorepo-pnpm.md`](monorepo-pnpm.md).
3. Back to the big picture. See [`00-overview.md`](00-overview.md).
