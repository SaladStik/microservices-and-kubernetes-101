<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# 03 Create the local Kubernetes cluster (kind)

> Part of the Orbit guides. Back: [Run it locally on Docker Compose](02-run-local-compose.md) · Up: [Overview](00-overview.md) · Next: [Kafka on Strimzi](04-kafka-strimzi.md)

Now you leave Docker Compose behind and stand up a real multi node Kubernetes cluster on your laptop using kind, which stands for Kubernetes IN Docker. This guide only creates the cluster. Deploying Orbit onto it happens in the later guides.

1. [04 Kafka on Strimzi](04-kafka-strimzi.md) installs the Kafka operator and cluster.
2. [05 Postgres and Debezium CDC](05-postgres-debezium-cdc.md) brings up the data layer.
3. [07 Argo CD](07-argocd-setup.md) deploys the app services through GitOps.

You need `kind`, `kubectl`, and Docker installed and running. See [01 Prerequisites](01-prerequisites.md). Docker Desktop should have about 4 CPUs and 6 to 8 GB RAM for a comfortable three node cluster.

---

## Step 1 Create the cluster

```bash
kind create cluster --config k8s/kind/kind-cluster.yaml
```

The Makefile does the same thing.

```bash
make kind-up
```

This takes a minute or two while kind pulls the node image and boots Kubernetes.

---

## What the config does

[`k8s/kind/kind-cluster.yaml`](../k8s/kind/kind-cluster.yaml) defines the following.

```yaml
name: orbit
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30080   # nginx HTTP NodePort
        hostPort: 80
        protocol: TCP
      - containerPort: 30443   # nginx HTTPS NodePort
        hostPort: 443
        protocol: TCP
  - role: worker
  - role: worker
```

1. The cluster name is `orbit`. Every Make target such as `kind-down` and `load-images` refers to it by this name.
2. It has three nodes, one control plane and two workers, so you can actually see pods scheduled across machines. `kubectl get pods -o wide` shows different `NODE` values. A single node would hide that.
3. The port mappings are `80` to `30080` and `443` to `30443`. The nginx edge Service is a NodePort exposing both `30080` (to container `80`) and `30443` (to container `443`). See [`services/nginx/k8s/service.yaml`](../services/nginx/k8s/service.yaml). kind forwards your host `80` and `443` to those NodePorts on the control plane node. Once nginx is deployed, <http://localhost> issues a `301` redirect to <https://localhost>, the TLS terminated edge, the same HTTPS URL you used in the Compose demo. Nothing answers there yet. The app is not deployed until the later guides.

This mirrors the [Kubernetes topology diagram (08)](diagrams/08-kubernetes-topology.puml).

---

## Step 2 Verify the cluster

```bash
kubectl get nodes
```

After a moment all nodes show `Ready`.

```
NAME                  STATUS   ROLES           AGE   VERSION
orbit-control-plane   Ready    control-plane   90s   v1.3x.x
orbit-worker          Ready    <none>          70s   v1.3x.x
orbit-worker2         Ready    <none>          70s   v1.3x.x
```

`kubectl` is already pointed at the new cluster. kind sets the context to `kind-orbit` automatically. Confirm it.

```bash
kubectl config current-context   # kind-orbit
```

---

## Step 3 (optional) Build and load app images into kind

For offline or local runs you can build the four app images and load them directly into the cluster, skipping any registry.

```bash
make load-images
```

Under the hood this loops over the services and runs the following for `nginx`, `auth`, `node-gateway`, and `python-worker`.

```bash
docker build -t orbit-<svc>:dev services/<svc>
kind load docker-image orbit-<svc>:dev --name orbit
```

The `kind load` step copies each image straight into the nodes container runtime, so a Deployment referencing `orbit-<svc>:dev` runs without pulling anything.

There are two different image sources. Do not mix them up.

1. `make load-images` produces images tagged `orbit-<svc>:dev` for local offline use. To run them you point your manifests at those local tags and set `imagePullPolicy: IfNotPresent`. Otherwise Kubernetes tries to pull `:dev` from a registry and fails.
2. The GitOps path is the default this repo is built around. It pulls images from GHCR at `ghcr.io/your-org/orbit-<svc>`. That path needs the `your-org` placeholder replaced (see [Prerequisites](01-prerequisites.md#replace-the-your-org-placeholder-before-the-kubernetes-guides)) and CI to have pushed images (guide 08).

If you see `ImagePullBackOff`, you almost certainly hit this. See [Troubleshooting, Images will not pull](09-troubleshooting.md#images-wont-pull--imagepullbackoff).

---

## Step 4 Create the `nginx-tls` Secret for the HTTPS edge

The nginx edge serves HTTPS and terminates TLS in the cluster. Its Deployment mounts an `nginx-tls` Secret at `/etc/nginx/certs` and never bakes the cert into the image. Its readiness probe hits `:443`. That Secret is not in git. You create it from your locally generated self signed cert. Do this before or right after deploying the app in the later guides, or the nginx pod will not become Ready.

```bash
make certs        # generate services/nginx/certs/tls.crt + tls.key (gitignored)
make tls-secret   # create the nginx-tls Secret in the orbit namespace
```

`make tls-secret` runs roughly the following.

```bash
kubectl create secret tls nginx-tls \
  --cert=services/nginx/certs/tls.crt \
  --key=services/nginx/certs/tls.key \
  -n orbit --dry-run=client -o yaml | kubectl apply -f -
```

The `orbit` namespace must exist first. The infra app (`kubectl apply -k k8s/infra`) creates it. See [guide 04](04-kafka-strimzi.md). If you run `make tls-secret` before the namespace exists, create it with `kubectl create ns orbit` or just run it again after the infra is applied. Forgetting this Secret shows up as a stuck nginx pod or connection refused on `https://localhost`. See [Troubleshooting, cannot reach https://localhost](09-troubleshooting.md#cant-reach-httpslocalhost--connection-refused-on-443).

---

## Tear down

```bash
make kind-down
# equivalent to: kind delete cluster --name orbit
```

This removes the entire cluster and frees the host ports 80 and 443.

---

## Where to next

The cluster is up but empty. Deploy Orbit onto it in order.

1. [04 Kafka on Strimzi](04-kafka-strimzi.md) brings up the three node KRaft quorum.
2. [05 Postgres and Debezium CDC](05-postgres-debezium-cdc.md).
3. [06 Services and auth](06-services-and-auth.md).
4. [07 Argo CD and GitOps](07-argocd-setup.md).

Stuck? Common kind issues such as ports 80 and 443 in use, ImagePullBackOff, pending pods, and the missing `nginx-tls` secret are in [09 Troubleshooting](09-troubleshooting.md).
