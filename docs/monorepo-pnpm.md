<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# The monorepo and pnpm

Orbit keeps every service in one repository (a monorepo) and manages the JavaScript half with pnpm workspaces. This page explains both choices and the exact commands you will use.

New here? Start with [`00-overview.md`](00-overview.md). For the runtime story see [`events-and-jobs.md`](events-and-jobs.md) and [`06-services-and-auth.md`](06-services-and-auth.md).

---

## Why a monorepo for this project

Orbit is several services (`nginx`, `ui`, `auth`, `node-gateway`, `python-worker`, `debezium-connect`) plus Kubernetes manifests, Argo CD config, CI, and docs. They form one system that only makes sense together. They share a naming contract (topics, the `orbit_token` cookie, the `jobs` table) and they change in lockstep.

Keeping them in one repo buys you three things.

1. One clone, one checkout tells the whole story. You read the entire system in one place instead of hopping between repositories.
2. Atomic cross service changes. Rename a Kafka topic and you can update the producer, the consumer, and the manifests in a single commit or PR.
3. Shared tooling and docs live next to the code they describe.

The trade off in production is that you want CI to only rebuild what changed. Orbit's GitHub Actions workflow does exactly that. See [diagram 10, CI and CD image pipeline](diagrams/10-cicd-image-pipeline.puml) and [`docs/08-cicd-and-image-updater.md`](08-cicd-and-image-updater.md).

---

## What is pnpm, and how is it different from npm

pnpm is a drop in package manager for Node.js. Same `package.json`, same registry, with a smarter install model.

1. Content addressable store. Every version of every package is downloaded once into a global store on your machine (`~/.pnpm-store`). If ten projects use `express@4.x`, it is on disk a single time.
2. Hard links instead of copies. A project's `node_modules` is built from hard links into that store, so installs are fast and take almost no extra disk. npm copies a full dependency tree into every project.
3. Strict, non flat `node_modules`. npm hoists dependencies into a flat tree, which lets you accidentally `import` a package you never declared (a phantom dependency). It works on your machine and breaks in CI. pnpm keeps `node_modules` non flat, so you can only import what you actually listed as a dependency. This strictness catches a whole class of works on my machine bugs.

For this project this matters because the behavior is reproducible. Everyone who runs the same commands gets the same tree.

---

## pnpm workspaces, a polyglot monorepo

A workspace lets one repo contain many packages that pnpm manages together. The definition is one file, [`pnpm-workspace.yaml`](../pnpm-workspace.yaml).

```yaml
packages:
  - "services/*"
```

This says any folder under `services/*` that has a `package.json` is a workspace package. That last clause is the important one.

1. `services/ui`, `services/auth`, and `services/node-gateway` have a `package.json`, so pnpm manages them.
2. `services/python-worker` (Python), `services/nginx` (config), and `services/debezium-connect` (a Connect image) have no `package.json`, so pnpm simply ignores them.

So pnpm manages only the JavaScript half, and the non JS services live happily in the same repo untouched. That is what makes Orbit a polyglot monorepo. One repository, multiple languages, one tool per language doing what it is good at.

---

## The root package.json and pnpm --filter

The root [`package.json`](../package.json) is `"private": true` so it is never published. It exists mostly to hold workspace wide scripts.

```json
{
  "name": "orbit-monorepo",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "dev:ui":       "pnpm --filter orbit-ui dev",
    "build":        "pnpm -r --if-present build",
    "start:auth":    "pnpm --filter orbit-auth start",
    "start:gateway":"pnpm --filter orbit-node-gateway start"
  }
}
```

Two pnpm features power these.

1. `pnpm --filter <pkg> <script>` runs a script in one workspace package, selected by its `name` field (for example `orbit-ui`, `orbit-auth`, `orbit-node-gateway`). `pnpm --filter orbit-ui dev` starts only the UI's Vite dev server.
2. `pnpm -r` (recursive) runs across all packages. `pnpm -r --if-present build` builds every package that defines a `build` script and quietly skips those that don't.

So `pnpm build` at the root builds the whole JS half in one command, while the `dev:ui`, `start:auth`, and `start:gateway` scripts target individual services.

---

## packageManager and Corepack, reproducible pnpm

Notice `"packageManager": "pnpm@9.12.0"` in the root `package.json`. That field is read by Corepack, a tool that ships with Node.js. When Corepack is enabled, running `pnpm` in this repo automatically uses exactly pnpm 9.12.0, not whatever version happens to be installed globally. Everyone, and every Docker build, gets the same pnpm.

The service Dockerfiles use this for reproducible images. They enable Corepack and pin pnpm via that field rather than `npm install -g pnpm@something`. The pattern is essentially this.

```dockerfile
RUN corepack enable             # turn on Corepack
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile   # uses the pinned pnpm; lockfile is law
COPY . .
```

`--frozen-lockfile` means install exactly what the lockfile says and fail if it doesn't match. That is the right flag for CI and image builds, where you never want a surprise upgrade.

---

## Typical commands

```bash
# one-time: turn on Corepack so `pnpm` resolves to the pinned 9.12.0
corepack enable

# install all JS workspace dependencies from the repo root
pnpm install

# run a single service in dev (Vite HMR for the UI)
pnpm --filter orbit-ui dev          # or: pnpm dev:ui

# run the auth service or the gateway
pnpm --filter orbit-auth start       # or: pnpm start:auth
pnpm --filter orbit-node-gateway start

# build everything that has a build script
pnpm build
```

The Python `python-worker` sits outside all of this. It has its own `requirements` and Dockerfile and runs via Docker Compose or Kubernetes, not pnpm.

---

## A note on the Docker images and the production grade alternative

For clarity, each JS service's Dockerfile builds with its own folder as the build context and installs that service's dependencies on its own. This keeps every Dockerfile self contained and easy to read in isolation. You don't have to understand the whole workspace to understand one image.

The production grade alternative is to build from the repo root context so the build can see `pnpm-workspace.yaml` and the single root `pnpm-lock.yaml`, then do two things.

1. Install with `pnpm install --frozen-lockfile` once against the shared lockfile, for better caching and guaranteed consistent versions across services.
2. Use `pnpm deploy --filter <service> /out` to produce a pruned, standalone copy of just that service plus exactly the dependencies it needs, ideal for a small final image.

Orbit favors the simpler per service approach so the focus stays on events and GitOps, not Docker plumbing. It is worth knowing the better pattern exists for when you grow this into a real pipeline.

---

## Where to go next

1. The event queue itself is in [`events-and-jobs.md`](events-and-jobs.md).
2. The edge, auth, and per service deep dive is in [`06-services-and-auth.md`](06-services-and-auth.md).
3. CI that rebuilds only the changed service is in [`08-cicd-and-image-updater.md`](08-cicd-and-image-updater.md).
4. Back to the overview is [`00-overview.md`](00-overview.md).
