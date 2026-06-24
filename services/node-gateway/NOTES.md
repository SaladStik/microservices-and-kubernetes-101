<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# node-gateway notes

The event hub, the only thing that touches the queue, plus the read model and the live channel. This is the CQRS and event driven core.

## What this service shows

1. Command versus query, which is CQRS.
2. `POST /jobs` is a command. It writes the row as `accepted`, publishes to Kafka (`job.requests`), then marks it `queued`, and returns 202. If the publish fails the row stays `accepted`, in the database but not on the queue. That is the dual write problem. A real system uses an outbox to retry it.
3. `GET /jobs` is a query. It is a plain read of durable state, this user's job history, from Postgres. It returns instantly and waits on nothing.
4. Write the row, then publish ordering. The row exists before the event is produced, so a consumer can never react to a job that is not recorded yet.
5. Ownership without auth. The gateway reads `X-Auth-User`, set by nginx after auth_request. It never validates a token. Identity arrives pre verified.
6. Push versus catch up. Live completions are pushed over the WebSocket, driven by CDC. History you missed while logged out is pulled via `GET`. You cannot push to a client with no open connection, so you need both.
7. CDC consumer fans out. It consumes `orbit.public.jobs`, reads the row change, and pushes a `job-update` to the subscribed browsers.

## The key idea

The gateway never calls the worker. It drops an event and forgets. Completion arrives from a different event, CDC. Producers and consumers are decoupled.

## Walk the code in this order

1. `config.js`, env for Kafka brokers and topics, Postgres.
2. `kafka.js`, producer (`publishJob`) plus CDC consumer (`consumeCdc`).
3. `db.js`, `recordQueued` for the write model plus `listForOwner` for the read model.
4. `ws.js`, the subscribe by jobId WebSocket hub.
5. `index.js`, wires command (POST), query (GET), and CDC to WS together.

## Demo live

1. Submit a job and watch the 202 return instantly. The completed line arrives about 3s later over the WebSocket, the worker delay, not as the POST response.
2. Scale `python-worker` replicas and submit several jobs to see parallel consumption.

## Common questions

1. Why record a row AND publish? The row is the queryable state, the history. The event is the work trigger. Different jobs, both needed.
2. Why not return the result from POST? The work is async and there is nothing to wait for. That is the whole point of an event driven system.
