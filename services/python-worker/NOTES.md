<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# python-worker notes

A pure event consumer. The cleanest illustration of decoupling in the repo.

## What this service shows

1. Consume, process, write, and nothing else. No HTTP server, no auth. It only speaks Kafka in and Postgres out. If you can reach it, you are already inside the network.
2. It tells no one it is done. It writes the result and stops. Debezium notices the DB change and emits the completion event. The worker does not know or care who reacts, which is decoupling.
3. Consumer groups and scaling. All replicas share `group.id=python-worker`. Kafka splits the topic partitions among them. Add replicas and throughput scales, up to the partition count.
4. At least once plus idempotency. A redelivered message must not corrupt state. The write is an UPSERT (`ON CONFLICT ... DO UPDATE`), so processing the same job twice yields the same row.
5. Owner flows through the event. The job event carries `owner` and the worker preserves it so the read model stays user scoped.
6. Dead letter queue. A message that cannot be processed is published to `job.requests.dlq` instead of being dropped or blocking the topic. See below.

## The key idea

The producer (gateway) and consumer (worker) never talk directly. They share a topic, not a method call. Either can restart, scale, or be rewritten in another language without the other knowing.

## Standard patterns used here

These are the conventional production patterns, simplified only where noted.

1. At least once plus idempotent consumer with manual offset commit. Commit after the message is handled, not before.
2. Dead letter queue with `<topic>.dlq` naming for messages that cannot be handled.
3. Consumer pause and resume to stop processing without leaving the group.
4. Write the row then publish on the producer side (gateway) and a CQRS read model for history. A strict outbox would publish from the DB transaction. We keep them as two ordered steps for clarity.

## Walk the code in this order

1. `config.py`, env into a `Config` for Kafka and Postgres, DLQ topic, manual commit.
2. `db.py`, `connect`, `write_result` (idempotent upsert), `mark_failed`, `is_worker_available` (the demo flag).
3. `consumer.py`, the core of it. The consume, `process`, write loop, plus the DLQ path (`send_to_dlq`) and the pause and resume service down logic. `process` is the stand in for real work. It sleeps 3s, reverses the string, and raises on "fail".
4. `main.py`, a four line entry point that builds config and calls `run`.

## Dead letter queue (DLQ)

A job can fail two ways. The DLQ (`job.requests.dlq`) handles both so nothing is lost and a bad message never blocks the topic.

1. Transient. A dependency the worker needs was down. The message is fine, and replaying it from the DLQ once the dependency is back will succeed.
2. Poison. Permanently bad, unparseable, or always throws. Needs a fix, then replay. Monitor DLQ depth and alert on it.

On failure the worker also marks the job `failed` in Postgres, best effort, so CDC pushes the failure to the UI. Standard practice is to retry transient failures with backoff before DLQ-ing. We DLQ immediately to keep it simple.

Note the distinction. A down consumer, the whole worker offline, is NOT a DLQ case. Messages simply wait in the topic until it returns. The DLQ is only for when the consumer is up but a message fails.

## Demo live

1. Tail `docker compose logs -f python-worker` and see "received job … for admin".
2. Service down and catch up, in the UI. Click Simulate service down, submit a job and it stays `queued`, then Bring service back up and watch the worker drain the queue and complete it. Under the hood the worker pauses its partitions, the job waits in Kafka, and resuming consumes it.
3. DLQ. Submit a payload containing "fail" and the job shows `failed` and a message lands on the DLQ.
```
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
    --bootstrap-server localhost:9092 --topic job.requests.dlq --from-beginning
```
4. Autoscaling. Click Simulate load and the worker count climbs and falls. On Compose a small `autoscaler` stand-in does this. Real Kubernetes uses KEDA instead, there is no stand-in. See [docs/10-autoscaling.md](../../docs/10-autoscaling.md).

## Common questions

1. Where does it send the result? Nowhere. It writes the DB. CDC does the rest.
2. What if it crashes mid job? The offset is not committed past the message, so it is redelivered. The idempotent upsert makes reprocessing safe.
3. Down service versus DLQ? Down consumer means jobs wait in the topic. DLQ means the consumer is up but the message failed.
