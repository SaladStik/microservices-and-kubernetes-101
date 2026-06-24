# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
"""
The worker's core loop. Consume job.requests, do the work, write to Postgres.
Covers three ideas: the happy path, the dead letter queue, and pausing when the
service is "down". Notes: services/python-worker/NOTES.md
"""
import json
import signal
import socket
import sys
import time

from confluent_kafka import Consumer, Producer, KafkaError

from app import db
from app.config import Config

_running = True


def _stop(*_):
    global _running
    _running = False


def _commit(consumer, msg) -> None:
    # commit can fail during a rebalance. ignore it so the loop never crashes and
    # always reaches a clean shutdown. the message just gets redelivered
    try:
        consumer.commit(message=msg, asynchronous=False)
    except Exception:  # noqa: BLE001
        pass


def process(payload: str) -> str:
    # Fake work. A payload with "fail" raises so you can watch the DLQ.
    time.sleep(3)
    if "fail" in payload.lower():
        raise ValueError("simulated failure (payload contained 'fail')")
    return payload[::-1]


def send_to_dlq(producer: Producer, cfg: Config, raw_value, reason: str, error: str, job_id=None) -> None:
    # Park a message we cannot handle so nothing is lost and the topic is not blocked.
    envelope = {
        "reason": reason,
        "error": error,
        "failedAt": int(time.time()),
        "originalTopic": cfg.job_requests_topic,
        "jobId": job_id,
        "original": raw_value.decode("utf-8", "replace") if isinstance(raw_value, (bytes, bytearray)) else raw_value,
    }
    producer.produce(cfg.dlq_topic, value=json.dumps(envelope))
    producer.flush(5)
    print(f"[worker] -> DLQ ({reason}) on '{cfg.dlq_topic}'", file=sys.stderr, flush=True)


def run(cfg: Config) -> int:
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    consumer = Consumer(cfg.kafka_consumer_config())
    consumer.subscribe([cfg.job_requests_topic])
    producer = Producer(cfg.kafka_producer_config())  # only for the DLQ
    conn = db.connect(cfg)
    print(f"[worker] consuming '{cfg.job_requests_topic}' from {cfg.bootstrap}", flush=True)

    paused = False
    worker_id = socket.gethostname()  # the container id, unique per worker
    last_hb = 0.0

    while _running:
        # heartbeat every few seconds so the UI can count ready workers
        if time.monotonic() - last_hb > 3:
            try:
                db.heartbeat(conn, worker_id)
            except Exception:  # noqa: BLE001
                pass
            last_hb = time.monotonic()

        # Service down demo. Flag off means pause, so jobs wait in the topic.
        assignment = consumer.assignment()
        if assignment:
            available = db.is_worker_available(conn)
            if not available and not paused:
                consumer.pause(assignment)
                paused = True
                print("[worker] paused (service down)", flush=True)
            elif available and paused:
                consumer.resume(assignment)
                paused = False
                print("[worker] resumed, draining the queue", flush=True)

        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            if msg.error().code() == KafkaError._PARTITION_EOF:
                continue
            print(f"[worker] kafka error: {msg.error()}", file=sys.stderr, flush=True)
            continue

        raw = msg.value()

        # Cannot parse means a poison message. Straight to the DLQ.
        try:
            event = json.loads(raw)
            job_id = event["jobId"]
        except Exception as exc:  # noqa: BLE001
            send_to_dlq(producer, cfg, raw, reason="unparseable", error=str(exc))
            _commit(consumer, msg)
            continue

        payload = event.get("payload", "")
        owner = event.get("owner", "anonymous")
        print(f"[worker] received job {job_id} for {owner}", flush=True)

        # Work failed. Mark it failed for the UI and send it to the DLQ to replay later.
        try:
            db.mark_processing(conn, job_id)  # picked up, show it before the work
            result = process(payload)
            db.write_result(conn, job_id, payload, result, owner)
            print(f"[worker] job {job_id} done -> '{result}'", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[worker] job {job_id} failed: {exc}", file=sys.stderr, flush=True)
            try:
                db.mark_failed(conn, job_id, payload, owner, str(exc))
            except Exception as db_exc:  # noqa: BLE001
                print(f"[worker] could not mark {job_id} failed: {db_exc}", file=sys.stderr, flush=True)
            send_to_dlq(producer, cfg, raw, reason="processing-failed", error=str(exc), job_id=job_id)

        _commit(consumer, msg)  # handled, advance the offset

    print("[worker] shutting down", flush=True)
    consumer.close()
    producer.flush(5)
    conn.close()
    return 0
