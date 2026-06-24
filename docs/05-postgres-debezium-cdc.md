<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# 05 Postgres + Debezium (Change Data Capture)

> Part of the Orbit guides. Back: [Kafka on Strimzi](04-kafka-strimzi.md) · Up: [Overview](00-overview.md) · Next: [Services & auth](06-services-and-auth.md)

In Orbit, when the `python-worker` finishes a job it does not publish a "done" event. It just `INSERT`s a row into Postgres. Debezium watches the database write ahead log and turns that row change into a Kafka event on its own. That pattern, Change Data Capture or CDC, is what this guide sets up.

By the end you will understand logical replication, build the custom Debezium Connect image, deploy the connector, and watch a row insert become a Kafka event.

You need to have completed [04 Kafka on Strimzi](04-kafka-strimzi.md) so the `orbit-kafka` cluster is `Ready`. Debezium runs on Kafka Connect, which needs Kafka.

The CDC hop diagram is [`docs/diagrams/05-cdc-completion-flow.puml`](diagrams/05-cdc-completion-flow.puml).

## Why CDC instead of just publishing an event

If the worker both wrote the DB row and published a Kafka event, those two writes could disagree. The DB commit succeeds and the event publish fails, or the other way round. CDC removes that risk. There is one write, the DB commit, and the event is derived from the committed WAL. The database is the single source of truth, and the event is guaranteed to match a committed row. This is the outbox and CDC pattern in its simplest form.

## Logical replication, piece by piece, and why each is needed

Debezium for Postgres reads the WAL, the write ahead log. To make the WAL usable for CDC, Postgres needs four things. All four are already configured in this repo. Here is what each does and why.

### 1. wal_level = logical

The Postgres StatefulSet ([`k8s/infra/postgres/statefulset.yaml`](../k8s/infra/postgres/statefulset.yaml)) starts Postgres with:

```yaml
args:
  - "postgres"
  - "-c"
  - "wal_level=logical"
  - "-c"
  - "max_wal_senders=10"
  - "-c"
  - "max_replication_slots=10"
```

The default `wal_level` only logs enough to recover the database. `logical` makes the WAL also record enough to reconstruct row level changes, which table, which columns, old versus new values. Without it, Debezium has nothing to read. `max_wal_senders` and `max_replication_slots` just raise the ceilings so a replication slot can exist.

### 2. A publication, orbit_publication

The init SQL ([`db/init/01-schema.sql`](../db/init/01-schema.sql)) runs:

```sql
DROP PUBLICATION IF EXISTS orbit_publication;
CREATE PUBLICATION orbit_publication FOR TABLE jobs;
```

A publication is how Postgres says these are the tables whose changes are available for logical replication. With `plugin.name=pgoutput`, the Postgres built in logical decoding plugin, Debezium subscribes to a publication to learn which tables to stream. You scope it to just `jobs`, the only table you care about.

The connector sets `publication.autocreate.mode: disabled`, so Debezium will not create the publication for you. It must already exist. Creating it in the schema SQL is clearer and avoids granting the connector superuser at runtime.

### 3. REPLICA IDENTITY FULL

```sql
ALTER TABLE jobs REPLICA IDENTITY FULL;
```

By default an `UPDATE` or `DELETE` event only carries the primary key of the changed row. `REPLICA IDENTITY FULL` makes Postgres log the entire old row too, so CDC events include the full before image. This is useful for consumers that need to see what changed, not just the key.

### 4. A replication slot, orbit_slot

The connector ([`k8s/infra/connect/debezium-connector.yaml`](../k8s/infra/connect/debezium-connector.yaml)) sets `slot.name: orbit_slot`. A replication slot is a server side bookmark. It remembers how far Debezium has consumed the WAL, and stops Postgres from recycling WAL segments Debezium has not read yet. Debezium creates the slot the first time it connects. This also means the slot persists. See the pitfalls section, a leftover slot from a previous run can bite you.

Putting it together, the logical WAL carries the raw change data, the publication says which tables, the slot is a durable read position, and REPLICA IDENTITY FULL gives the full before row. Those four are the whole contract Postgres owes Debezium.

## Step 1 Build the custom Debezium Connect image

Strimzi runs Kafka Connect for you, but the base Connect image ships with no connectors. You bake the Debezium Postgres plugin into a custom image.

Here is [`services/debezium-connect/Dockerfile`](../services/debezium-connect/Dockerfile).

```dockerfile
FROM quay.io/strimzi/kafka:0.43.0-kafka-3.8.0
USER root:root
ARG DEBEZIUM_VERSION=2.7.4.Final
RUN mkdir -p /opt/kafka/plugins/debezium \
 && curl -fsSL ".../debezium-connector-postgres-${DEBEZIUM_VERSION}-plugin.tar.gz" \
    | tar -xz -C /opt/kafka/plugins/debezium
USER 1001
```

It is the Strimzi Kafka base, so it slots into the Strimzi managed Connect runtime, plus the Debezium Postgres plugin pinned to 2.7.4.Final. Pinning matters. An unpinned plugin would make builds non reproducible.

Build it. Replace `<owner>` with your GitHub owner in lowercase.

```bash
docker build -t ghcr.io/<owner>/orbit-debezium-connect:latest services/debezium-connect
```

Expected, abbreviated.

```
 => naming to ghcr.io/<owner>/orbit-debezium-connect:latest   done
```

Now get that image where the cluster can pull it. Two options.

### Option A Load it straight into kind, offline, simplest for local work

```bash
kind load docker-image ghcr.io/<owner>/orbit-debezium-connect:latest --name orbit
```

Expected.

```
Image: "ghcr.io/<owner>/orbit-debezium-connect:latest" with ID "sha256:..." not yet present on node "orbit-control-plane", loading...
```

This copies the image into the kind nodes directly. No registry, no authentication. Great for local work.

### Option B Push to GHCR, matches the real CI and GitOps flow

```bash
echo "$GITHUB_PAT" | docker login ghcr.io -u <owner> --password-stdin
docker push ghcr.io/<owner>/orbit-debezium-connect:latest
```

For a private package the cluster also needs a pull secret. That is the `ghcr-creds` secret covered in [08 CI/CD & Image Updater](08-cicd-and-image-updater.md).

### Make the manifest match your image

The KafkaConnect manifest ([`k8s/infra/connect/kafka-connect.yaml`](../k8s/infra/connect/kafka-connect.yaml)) hard codes a placeholder owner:

```yaml
spec:
  image: ghcr.io/your-org/orbit-debezium-connect:latest   # <-- replace your-org
```

The `image:` here must exactly match the tag you built or loaded. Replace `your-org` with your owner:

```bash
# from repo root - replace OWNER with your lowercase GitHub owner
grep -rl 'your-org' k8s argocd services | xargs sed -i '' 's/your-org/OWNER/g'   # macOS
# (Linux: drop the '' after -i)
```

This same `your-org` to `OWNER` replacement is needed across `argocd/*` and `services/*/k8s/*` for the GitOps guides too. Doing it once now covers everything. See the [naming contract](../README.md#naming-contract-used-everywhere).

## Step 2 Deploy Connect and the connector

These two resources are already in `k8s/infra`. So if Argo CD or `kubectl apply -k k8s/infra` from [guide 04](04-kafka-strimzi.md) ran after you fixed the image, they are applied. To re apply just them manually:

```bash
kubectl apply -f k8s/infra/connect/kafka-connect.yaml
kubectl apply -f k8s/infra/connect/debezium-connector.yaml
```

### What these two resources are

`KafkaConnect` (`orbit-connect`) is the Connect runtime, a worker process that hosts connector plugins. Key bits:

```yaml
metadata:
  annotations:
    strimzi.io/use-connector-resources: "true"   # define connectors as YAML, not REST
spec:
  bootstrapServers: orbit-kafka-kafka-bootstrap:9092
  image: ghcr.io/<owner>/orbit-debezium-connect:latest
```

`use-connector-resources: "true"` is the GitOps friendly bit. Instead of `POST`ing connector JSON to a REST API, you declare connectors as `KafkaConnector` resources and Strimzi reconciles them. The `image` is your custom plugin image.

`KafkaConnector` (`orbit-postgres-connector`) is the Debezium config:

```yaml
spec:
  class: io.debezium.connector.postgresql.PostgresConnector
  config:
    database.hostname: postgres
    database.dbname: orbit
    topic.prefix: orbit                  # → topics named orbit.<schema>.<table>
    plugin.name: pgoutput                # use Postgres's built-in logical decoding
    publication.name: orbit_publication  # the publication we created in SQL
    publication.autocreate.mode: disabled
    slot.name: orbit_slot                # the durable WAL bookmark
    table.include.list: public.jobs      # only stream the jobs table
```

These config fields map one to one onto the logical replication pieces you read about above. `topic.prefix: orbit` plus table `public.jobs` is what produces the `orbit.public.jobs` topic name. The connector creates that topic itself, which is why [guide 04](04-kafka-strimzi.md) did not declare it.

## Step 3 Verify the pipeline end to end

### 3a. Connect runtime Ready

```bash
kubectl -n orbit get kafkaconnect orbit-connect
kubectl -n orbit get pods -l strimzi.io/cluster=orbit-connect
```

Expected.

```
NAME            DESIRED REPLICAS   READY
orbit-connect   1                  True

NAME                              READY   STATUS    RESTARTS   AGE
orbit-connect-connect-0           1/1     Running   0          2m
```

### 3b. Connector Ready

```bash
kubectl -n orbit get kafkaconnector
```

Expected.

```
NAME                       CLUSTER         CONNECTOR CLASS                                       READY
orbit-postgres-connector   orbit-connect   io.debezium.connector.postgresql.PostgresConnector    True
```

For the runtime truth, the task state, exec into the Connect pod and ask its REST API:

```bash
kubectl -n orbit exec -it deploy/orbit-connect-connect -- \
  curl -s localhost:8083/connectors/orbit-postgres-connector/status
```

Expected, note that both connector and task show `RUNNING`.

```json
{"name":"orbit-postgres-connector",
 "connector":{"state":"RUNNING","worker_id":"..."},
 "tasks":[{"id":0,"state":"RUNNING","worker_id":"..."}],
 "type":"source"}
```

### 3c. The CDC topic exists

```bash
kubectl -n orbit get kafkatopic
```

Once the connector has started you will see `orbit.public.jobs` appear alongside `job.requests`. Strimzi's Topic Operator picks up the auto created topic.

```
NAME                  CLUSTER       PARTITIONS   READY
job.requests          orbit-kafka   3            True
orbit.public.jobs     orbit-kafka   1            True
```

### 3d. Insert a row, watch the event

Start a consumer on the CDC topic:

```bash
kubectl -n orbit exec -it orbit-kafka-quorum-0 -- \
  bin/kafka-console-consumer.sh \
  --bootstrap-server orbit-kafka-kafka-bootstrap:9092 \
  --topic orbit.public.jobs --from-beginning
```

In another terminal, insert a row into `jobs`:

```bash
kubectl -n orbit exec -it postgres-0 -- \
  psql -U orbit -d orbit -c \
  "INSERT INTO jobs (id, payload, status) VALUES (gen_random_uuid(), 'hello cdc', 'done');"
```

Expect `INSERT 0 1`, and within a second the consumer prints a CDC event like:

```json
{"before":null,
 "after":{"id":"...","payload":"hello cdc","status":"done","result":null,"created_at":...},
 "op":"c","source":{"db":"orbit","schema":"public","table":"jobs",...},"ts_ms":...}
```

`"op":"c"` is a create, an insert. That is CDC working. One DB write became one Kafka event, with no application code publishing it. In the real flow the `node-gateway` consumes exactly this event and pushes "done!" to the browser.

## Common pitfalls

`replication slot "orbit_slot" already exists` or the connector stuck means a slot survived a previous run. Drop it and let Debezium recreate it:

```bash
kubectl -n orbit exec -it postgres-0 -- \
  psql -U orbit -d orbit -c "SELECT pg_drop_replication_slot('orbit_slot');"
kubectl -n orbit annotate kafkaconnector orbit-postgres-connector \
  strimzi.io/restart="true" --overwrite
```

Connect pod `ImagePullBackOff` or `ErrImagePull` means the custom image is not where the cluster looks. For kind, re run the `kind load docker-image` step in Option A. Confirm the `image:` in `kafka-connect.yaml` exactly matches the tag you built, with no stray `your-org`.

`wal_level` is not logical, or no events ever arrive. Check it from inside Postgres:

```bash
kubectl -n orbit exec -it postgres-0 -- psql -U orbit -d orbit -c "SHOW wal_level;"
```

It must print `logical`. If not, the StatefulSet args did not take. Re apply `k8s/infra/postgres/statefulset.yaml` and let the pod restart.

Topic `orbit.public.jobs` never appears means the connector is not `RUNNING`, so re check 3b. Often the publication is missing because the init SQL did not run, or the table is empty and you have not inserted yet. The topic is created on the first captured change.

For anything else, see [09 Troubleshooting, CDC events never arrive](09-troubleshooting.md#cdc-events-never-arrive--connector-init-fails).

## What you built

You configured Postgres for logical replication, the WAL plus publication plus slot plus full replica identity, and you know why each piece exists. You built a custom Debezium Connect image with the Postgres plugin baked in. You ran a `KafkaConnect` and `KafkaConnector` that streams `public.jobs` changes to `orbit.public.jobs`, proven by a live insert turning into an event.

Next are the application services and edge auth. See [06 Services & auth](06-services-and-auth.md). To deploy them the real way, jump to [07 Argo CD](07-argocd-setup.md).
