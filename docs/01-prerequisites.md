<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# 01 Prerequisites

Part of the Orbit guides. Back to the [big picture](00-overview.md). Next is [Run it locally on Docker Compose](02-run-local-compose.md).

This page installs the tools you need to run Orbit, from the quick Compose demo all the way to the full Kubernetes and GitOps walkthrough. Read the list, install what you need for the path you want, and use the version check commands to confirm each tool works.

In a hurry? For the Docker Compose demo only (guide 02) you need just Docker. Everything else on this page is for the Kubernetes guides (03 onward). Install Docker, then jump straight to [02 Run it locally](02-run-local-compose.md).

Everything below is written for macOS with [Homebrew](https://brew.sh). If you don't have Homebrew yet, run this.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

---

## The toolbox at a glance

Here is what each tool does and when you need it.

1. Docker Desktop runs every service in containers. It is the engine behind Compose and kind. You need it for everything.
2. Node.js 20 with Corepack and pnpm builds and runs the Node services (the auth service and `node-gateway`) and the pnpm monorepo. You need it if you edit or run the Node services outside Docker.
3. Python 3.12 runs the worker if you run it outside its container. You need it only if you run the worker on the host.
4. kubectl is the CLI that talks to any Kubernetes cluster. You need it for guides 03 and up.
5. kind is Kubernetes in Docker, your local multi node cluster. You need it for guides 03 and up.
6. helm is the package manager for Kubernetes, used to install Strimzi. You need it for guides 03 and up.
7. PlantUML is optional. It renders the `.puml` diagrams in `docs/diagrams/` to images. You need it only if you want pictures.

---

## 1. Docker Desktop, required for everything

Docker is the one tool you cannot skip. Compose runs the whole app in containers, and kind runs an entire Kubernetes cluster inside Docker.

```bash
brew install --cask docker
```

Then launch Docker Desktop once from Applications (or run `open -a Docker`) so it can finish first time setup and start the daemon. Wait for the whale icon in the menu bar to stop animating.

Verify it with these commands.

```bash
docker --version          # Docker version 27.x or newer
docker compose version    # Docker Compose version v2.x  (note: "compose", a subcommand)
docker run --rm hello-world   # prints "Hello from Docker!"
```

If `docker run hello-world` prints the greeting, your engine is healthy.

Tip. For the Kubernetes guides, give Docker Desktop a little room. Go to Settings, then Resources, and set at least 4 CPUs and 6 to 8 GB RAM. A three node kind cluster plus Strimzi Kafka is hungrier than the Compose demo.

---

## 2. Node.js 20 with Corepack and pnpm

Orbit's Node services live in a pnpm monorepo. You only need this if you plan to run or edit those services outside Docker. The Compose and k8s paths build them in containers for you.

```bash
brew install node@20
brew link --overwrite node@20   # if brew warns it's keg-only
```

Node 20 ships with Corepack, which manages pnpm for you. Turn it on.

```bash
corepack enable
```

That makes the `pnpm` command available at the version the repo pins in its `package.json`. You do not need a separate pnpm install.

Verify it with these commands.

```bash
node --version     # v20.x
corepack --version # 0.x present
pnpm --version     # 9.x (the version pinned by the repo)
```

---

## 3. Python 3.12, only if running the worker on the host

The `python-worker` runs in its own container in both the Compose and k8s paths. You only need a host Python if you want to run or debug the worker directly.

```bash
brew install python@3.12
```

Verify it.

```bash
python3.12 --version   # Python 3.12.x
```

---

## 4. kubectl, talk to Kubernetes

This is the universal Kubernetes CLI. You will use it constantly from guide 03 onward.

```bash
brew install kubectl
```

Verify it.

```bash
kubectl version --client   # Client Version: v1.3x.x
```

It is normal for `kubectl version` to complain it cannot reach a server until you create a cluster in guide 03.

---

## 5. kind, your local Kubernetes cluster

kind (Kubernetes in Docker) spins up a real multi node Kubernetes cluster using Docker containers as the nodes. It is how Orbit gives you a three node cluster on a laptop.

```bash
brew install kind
```

Verify it.

```bash
kind --version   # kind version 0.2x.x
```

You will create the `orbit` cluster in [03 kind cluster](03-kind-cluster.md).

---

## 6. helm, the Kubernetes package manager

helm installs prepackaged Kubernetes apps called charts. Orbit uses it for the Strimzi Kafka operator (guide 04).

```bash
brew install helm
```

Verify it.

```bash
helm version   # version.BuildInfo{Version:"v3.x.x", ...}
```

---

## 7. PlantUML rendering, optional

The diagrams in [`docs/diagrams/`](diagrams) are PlantUML (`.puml`) text files. GitHub and many editors render them inline, so you usually don't need anything. To render them to PNG or SVG locally, run this.

```bash
brew install plantuml         # pulls in a Java runtime too
plantuml docs/diagrams/01-system-context.puml   # writes 01-system-context.png
```

---

## Replace the your-org placeholder before the Kubernetes guides

The Kubernetes manifests and CI workflow reference container images at `ghcr.io/your-org/orbit-<service>`. `your-org` is a placeholder. Before you do the GitOps parts (guides 04, 05, 07, 08) you must replace it with your own GitHub org or username, the one that owns your fork and its GHCR registry.

Find every occurrence.

```bash
grep -rn "your-org" k8s/ argocd/ .github/
```

You can replace them all in one pass once you have forked. Swap `YOUR_GITHUB_NAME` for your actual GitHub owner.

```bash
grep -rl "your-org" k8s/ argocd/ .github/ \
  | xargs sed -i '' 's/your-org/YOUR_GITHUB_NAME/g'
```

The Docker Compose demo (guide 02) does not use these images. It builds locally, so you can ignore the placeholder until you reach Kubernetes.

---

## You're ready

Quick self check before moving on.

```bash
docker compose version && kubectl version --client && kind --version && helm version
```

1. Just want to see the app work? Go to [02 Run it locally on Docker Compose](02-run-local-compose.md).
2. Going for the full walkthrough? Go to [03 Create the kind cluster](03-kind-cluster.md).

When something refuses to cooperate, the [09 Troubleshooting](09-troubleshooting.md) guide has a Symptom, Cause, Fix entry for most of it.
