<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# 04 Kafka on Strimzi (the three node KRaft quorum)

> Part of the Orbit guides. Back: [Create the kind cluster](03-kind-cluster.md) · Up: [Overview](00-overview.md) · Next: [Postgres + Debezium CDC](05-postgres-debezium-cdc.md)

You have a running Kubernetes cluster from [03 kind](03-kind-cluster.md). Now you put a real event bus on it. Orbit uses Apache Kafka, run by the Strimzi operator, in modern KRaft mode with no ZooKeeper, as a three node quorum.

By the end you will understand what an operator is, apply a `Kafka` cluster and its topics, and watch all three Kafka pods reach `Ready`.

You need `kubectl` and `helm` installed. See [01 Prerequisites](01-prerequisites.md). `helm` is not preinstalled. The prerequisites guide has the `brew install helm` step.

The diagram for this guide is [`docs/diagrams/07-kafka-kraft-quorum.puml`](diagrams/07-kafka-kraft-quorum.puml). It shows the three nodes and why three.

## The mental model is operator first, cluster second

There are two distinct things here, and the order matters.

1. The Strimzi operator is a controller pod that adds Custom Resource Definitions, or CRDs, so Kubernetes understands the words `Kafka`, `KafkaNodePool`, `KafkaTopic`, `KafkaConnect`, and more. The operator watches for those resources and turns them into real pods, services, and config.
2. The Kafka cluster itself is a `Kafka` resource plus a `KafkaNodePool` and a `KafkaTopic` that describe what you want. On its own this YAML does nothing. It only becomes pods once the operator is running to reconcile it.

So the rule is install the operator first, then apply the `Kafka` CR. If you apply the `Kafka` CR before the CRDs exist, `kubectl` rejects it with "no matches for kind Kafka". If you apply it after the CRDs exist but before the operator is running, the YAML is accepted but nothing happens until the operator wakes up.

### What is an operator, really

An operator is a program running in the cluster that encodes the operational knowledge a human SRE would otherwise apply by hand. To run Kafka, it creates StatefulSets, wires up services, rolls the pods one at a time on config changes, and formats storage for KRaft. You declare the what, a three node cluster with RF=3. The operator does the how. The CRDs are the new API types that let you express that what as ordinary Kubernetes objects you can `kubectl apply` and later put under GitOps.

## Step 1 Install the Strimzi operator

There are two common ways. Pick one. Both install the same CRDs and operator. They differ in how the operator is packaged and how widely it watches.

### Option A Helm, recommended, cluster wide watch

```bash
helm repo add strimzi https://strimzi.io/charts/
helm repo update
helm install strimzi-cluster-operator strimzi/strimzi-kafka-operator \
  -n kafka --create-namespace \
  --set watchAnyNamespace=true
```

Expected output, abbreviated.

```
"strimzi" has been added to your repositories
NAME: strimzi-cluster-operator
NAMESPACE: kafka
STATUS: deployed
```

The operator pod runs in its own `kafka` namespace. `watchAnyNamespace=true` lets that one operator manage Kafka clusters in any namespace, including the `orbit` namespace where the `Kafka` CR lives. This is the clean separation you want in real clusters. One operator, many tenants. Helm makes upgrades with `helm upgrade` and uninstall with `helm uninstall` easy, and lets you pin a chart version.

### Option B kubectl create from the install bundle, single namespace

```bash
kubectl create -f 'https://strimzi.io/install/latest?namespace=orbit' -n orbit
```

This downloads a generated YAML bundle of CRDs, RBAC, and the operator Deployment, preconfigured to watch the `orbit` namespace only, and applies it. The `?namespace=orbit` query param rewrites the bundle so the operator RBAC and watch scope target `orbit`.

Expected output, abbreviated.

```
customresourcedefinition.apiextensions.k8s.io/kafkas.kafka.strimzi.io created
customresourcedefinition.apiextensions.k8s.io/kafkanodepools.kafka.strimzi.io created
deployment.apps/strimzi-cluster-operator created
...
```

### Which should you use, and why

The two options differ in a few ways. With Helm the operator lives in a dedicated `kafka` namespace, watches any namespace through `watchAnyNamespace=true`, and upgrades cleanly with `helm upgrade` and pinned versions. With the kubectl bundle the operator lives inside `orbit`, watches only `orbit`, and you upgrade by re downloading the bundle and editing YAML. Helm suits multi tenant or production like setups. The bundle suits a quick single namespace demo.

Either works here. Option A mirrors how you would actually run it and keeps the operator out of your app namespace, so the rest of the guides use it. If you took Option B, just remember the operator already lives in `orbit`.

Use `kubectl create` and not `apply` for the bundle in Option B. The CRD schemas are large and `apply` can hit the annotation size limit on first install.

### Verify the operator is up

```bash
# Option A:
kubectl -n kafka rollout status deploy/strimzi-cluster-operator
kubectl -n kafka get pods

# Option B:
kubectl -n orbit rollout status deploy/strimzi-cluster-operator
```

Expected.

```
deployment "strimzi-cluster-operator" successfully rolled out
NAME                                        READY   STATUS    RESTARTS   AGE
strimzi-cluster-operator-7c4b...-x9k2q      1/1     Running   0          40s
```

Confirm the new API types now exist:

```bash
kubectl get crd | grep strimzi
```

You should see `kafkas`, `kafkanodepools`, `kafkatopics`, `kafkaconnects`, `kafkaconnectors`, and more. These are the resource types the operator just introduced to Kubernetes. Until they appeared, the `Kafka` YAML below was meaningless.

## Step 2 Understand what you are about to apply

Three resources make up the Orbit Kafka cluster. Read them before applying. This is the heart of the matter.

### KafkaNodePool, the nodes

Here is [`k8s/infra/kafka/kafka-nodepool.yaml`](../k8s/infra/kafka/kafka-nodepool.yaml).

```yaml
kind: KafkaNodePool
metadata:
  name: quorum
  labels:
    strimzi.io/cluster: orbit-kafka   # binds this pool to the Kafka named below
spec:
  replicas: 3
  roles:
    - controller   # votes in the KRaft metadata quorum
    - broker       # stores topic partitions
  storage:
    type: jbod
    volumes:
      - id: 0
        type: persistent-claim
        size: 5Gi
        kraftMetadata: shared
```

In KRaft mode each node is both a controller and a broker. A controller is a voter in the metadata quorum, the Raft log that replaces ZooKeeper. A broker stores and serves topic partition data.

`replicas: 3` gives the classic three node quorum. Why three? A quorum needs a majority to make progress. With three nodes a majority is two. If one node dies, the remaining two of three still form a majority, so the cluster keeps making decisions. With two nodes a majority is also two, so losing one leaves you with no majority and the cluster stalls. Three is the smallest count that tolerates a single failure. Diagram 07 draws this.

### Kafka, the cluster and durability config

Here is [`k8s/infra/kafka/kafka.yaml`](../k8s/infra/kafka/kafka.yaml).

```yaml
kind: Kafka
metadata:
  name: orbit-kafka
  annotations:
    strimzi.io/node-pools: enabled   # nodes come from KafkaNodePool resources
    strimzi.io/kraft: enabled        # KRaft mode (no ZooKeeper)
spec:
  kafka:
    version: 3.8.0
    listeners:
      - name: plain
        port: 9092
        type: internal
        tls: false
    config:
      default.replication.factor: 3
      min.insync.replicas: 2
      offsets.topic.replication.factor: 3
      transaction.state.log.replication.factor: 3
      transaction.state.log.min.isr: 2
```

The two annotations flip on the modern setup. `strimzi.io/node-pools: enabled` means the cluster gets its nodes from `KafkaNodePool` resources instead of an inline `spec.kafka.replicas`. `strimzi.io/kraft: enabled` runs in KRaft mode with no ZooKeeper.

The durability config is what makes the three node quorum worth running. `default.replication.factor: 3` copies every partition to all three nodes. `min.insync.replicas: 2` means a producer write is only acknowledged once two of those three copies are in sync.

Together, RF=3 and minISR=2, the cluster tolerates losing one node with zero data loss. A committed write already lives on at least two nodes, and the surviving two still form a majority for the metadata quorum. That is the entire reason you run three.

Other services reach the cluster at `orbit-kafka-kafka-bootstrap:9092` in namespace, or `orbit-kafka-kafka-bootstrap.orbit.svc:9092` fully qualified. Strimzi creates that Service for you. It is in the [naming contract](../README.md#naming-contract-used-everywhere).

### KafkaTopic, the request topic

[`k8s/infra/kafka/topics.yaml`](../k8s/infra/kafka/topics.yaml) declares `job.requests` as a managed resource. The Topic Operator reconciles it into a real topic.

```yaml
kind: KafkaTopic
metadata:
  name: job.requests
  labels:
    strimzi.io/cluster: orbit-kafka
spec:
  partitions: 3
  replicas: 3
  config:
    retention.ms: 604800000   # 7 days
    min.insync.replicas: 2
```

The other topic in this system, `orbit.public.jobs`, the CDC topic, is not declared here. Debezium creates it automatically in [guide 05](05-postgres-debezium-cdc.md). You only declare topics you own directly.

## Step 3 Apply the Kafka cluster

There are two ways, and they install the same manifests. Both pull from `k8s/infra/`, which also contains Postgres and Debezium, covered in guide 05. Applying it now brings up everything, and the Kafka pieces are what you verify here.

### Option 1 GitOps, the main event, set up later

In the full flow the `orbit-infra` Argo CD Application ([`argocd/apps/infra.yaml`](../argocd/apps/infra.yaml)) syncs `k8s/infra` for you. Nobody runs `kubectl apply` by hand. You set that up in [07 Argo CD](07-argocd-setup.md). If you have already done guide 07, the infra is already applied and you can skip straight to Step 4 Verify.

### Option 2 Manual apply, fine for now

To work through guides 04 and 05 before installing Argo CD, apply the infra kustomization directly:

```bash
kubectl apply -k k8s/infra
```

Expected output, abbreviated.

```
namespace/orbit created
kafkanodepool.kafka.strimzi.io/quorum created
kafka.kafka.strimzi.io/orbit-kafka created
kafkatopic.kafka.strimzi.io/job.requests created
kafkaconnect.kafka.strimzi.io/orbit-connect created
...
```

The moment the `Kafka` resource lands, the operator notices it and starts creating the StatefulSet like pods, services, and PVCs.

If you took install Option B above, operator in `orbit`, single namespace, this still works. If you took Option A, operator in `kafka` with `watchAnyNamespace=true`, the operator simply reaches across to manage these.

## Step 4 Verify

Watch the operator build the cluster:

```bash
kubectl -n orbit get kafka,kafkanodepool,strimzipodset,pods
```

Early on you will see pods being created. Give it a couple of minutes. The first run pulls images and formats KRaft storage. Eventually:

```
NAME                                   DESIRED KAFKA REPLICAS   READY
kafka.kafka.strimzi.io/orbit-kafka     3                        True

NAME                                       DESIRED REPLICAS   ROLES                  READY
kafkanodepool.kafka.strimzi.io/quorum      3                  ["controller","broker"]   3

NAME                                              PODS   READY PODS
strimzipodset.core.strimzi.io/orbit-kafka-quorum  3      3

NAME                        READY   STATUS    RESTARTS   AGE
pod/orbit-kafka-quorum-0    1/1     Running   0          3m
pod/orbit-kafka-quorum-1    1/1     Running   0          3m
pod/orbit-kafka-quorum-2    1/1     Running   0          3m
```

Three pods, `...-quorum-0/1/2`, each `1/1 Running`, each playing controller and broker. That is your quorum.

Block until the cluster reports Ready, handy in scripts:

```bash
kubectl -n orbit wait kafka/orbit-kafka --for=condition=Ready --timeout=300s
```

Expected.

```
kafka.kafka.strimzi.io/orbit-kafka condition met
```

Confirm the topic exists and is managed:

```bash
kubectl -n orbit get kafkatopic
```

Expected.

```
NAME           CLUSTER       PARTITIONS   REPLICATION FACTOR   READY
job.requests   orbit-kafka   3            3                    True
```

### Optional, prove it end to end with the console tools

You can produce and consume a message using the tools baked into the Kafka image:

```bash
# In one terminal - consume:
kubectl -n orbit exec -it orbit-kafka-quorum-0 -- \
  bin/kafka-console-consumer.sh \
  --bootstrap-server orbit-kafka-kafka-bootstrap:9092 \
  --topic job.requests --from-beginning

# In another terminal - produce (type a line, press Enter):
kubectl -n orbit exec -it orbit-kafka-quorum-0 -- \
  bin/kafka-console-producer.sh \
  --bootstrap-server orbit-kafka-kafka-bootstrap:9092 \
  --topic job.requests
> hello orbit
```

The consumer prints `hello orbit`. The bus works.

## Troubleshooting

Pods stuck `Pending` is almost always storage. The kind default `StorageClass` must be able to bind the PVCs. See [09 Troubleshooting, Strimzi Kafka pods stuck Pending](09-troubleshooting.md#strimzi-kafka-pods-stuck-pending).

`no matches for kind "Kafka"` means you applied the cluster before the CRDs existed. Re run Step 1, confirm `kubectl get crd | grep strimzi`, then re apply.

`Kafka` accepted but no pods appear means the operator is not running or is not watching `orbit`. Check `kubectl -n kafka get pods` for Option A and that you set `watchAnyNamespace=true`, or that the bundle targeted `orbit` for Option B.

## What you built

You installed the Strimzi operator and its CRDs, the new Kubernetes API types. You ran a three node KRaft Kafka quorum, `orbit-kafka`, with RF=3 and minISR=2 that survives one node failing. You created the managed `job.requests` topic.

Next is the data layer and Change Data Capture, where Postgres and Debezium turn a database row change into the `orbit.public.jobs` event. See [05 Postgres + Debezium CDC](05-postgres-debezium-cdc.md).
