<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# debezium-connect notes

Not an app service. It is the Change Data Capture plumbing. This is where a database change becomes an event.

## What this service shows

1. What CDC is. Instead of the worker telling everyone I am done, Debezium watches the Postgres write ahead log (WAL) and emits an event for every row change. Consumers react to facts that already happened in the DB.
2. Logical replication prerequisites. You need `wal_level=logical`, a publication (`orbit_publication`), a replication slot (`orbit_slot`), and `REPLICA IDENTITY FULL` so updates carry the full row.
3. pgoutput. The decoder plugin built into Postgres, no extra DB extension.
4. Kafka Connect plus Debezium. Connect is the runtime and Debezium is the connector plugin. We bake the plugin into a custom image, this Dockerfile, for k8s. In compose we use the all in one `debezium/connect` image.
5. Declarative connectors with Strimzi. In k8s the connector is a `KafkaConnector` resource for GitOps, not a curl to a REST API.

## The key idea

The worker and the UI are decoupled by the database, not a direct call. Any write to `jobs` becomes an event on `orbit.public.jobs`, even a manual `psql` `UPDATE` will push to the browser. Try it live.

## The change event

Debezium's envelope is `{ before, after, op, source, ts_ms }`. `op` is c/u/d/r and `after` is the new row. The gateway reads `after` and fans it out.

## Demo live

1. Run the update below and watch the UI update with no app code involved. It proves CDC is database driven.
```
docker compose exec postgres psql -U orbit -d orbit -c "update jobs set status='completed', result='manual' where id='<id>';"
```

## Common questions

1. Why CDC instead of the worker publishing a done event? The DB is the source of truth. CDC guarantees the event matches what was actually committed, with no dual write problem where the DB and the event bus disagree.
