<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# Reading path, core first, advanced after

This repo covers a lot. Do not try to read all of it in one straight line. Start with the core spine, the event driven round trip running locally on Docker Compose, until you can explain it without notes. Everything else, Kubernetes, Strimzi, GitOps, CI, and RBAC, is an advanced module layered on top of that same app you already understand.

The golden rule is to see the app work before you see how it deploys. Compose first, Kubernetes later.

---

## The fast path if you only have about 90 minutes

Read Part 1 only, entirely on Docker Compose. Skip Kubernetes, Strimzi, Argo CD, and CI. The event driven architecture is the point. The platform is a bonus.

1. Run `cp .env.example .env && make certs && docker compose up --build`.
2. Open https://localhost, log in as admin / admin, and run the demo below.
3. Walk the spine, steps 1 through 7, reading each service's `NOTES.md` and its one diagram. Done.

Save Part 2 for a later session or as self study using the numbered guides.

---

## Part 1 the core spine, read this first

Order matters. Each step adds one hop to the picture. For every step the move is the same. Look at the diagram, run the demo, then read that service's `NOTES.md` and skim the file it points to.

1. Big picture. See [`00-overview.md`](00-overview.md), diagrams 01-system-context and 11-end-to-end. The one idea is that nothing calls anything directly to do work. It all flows through events.
2. The edge and TLS. See `services/nginx`, diagrams 02-internal-network-security and 12-tls-edge. The one idea is one public door, where `:80` redirects to `:443` and everything else is internal.
3. Auth at the edge. See `services/auth` plus Redis, diagram 03-auth-flow. The one idea is that nginx asks the auth service whether you are allowed via `auth_request`, and the services carry no auth.
4. The command path. See `services/ui` and `services/node-gateway`, diagram 04-job-request-flow. The one idea is that a job is a command. You enqueue it and get `202` now, with the result later.
5. The worker. See `services/python-worker`, diagram 05. The one idea is a pure consumer. It consumes, does work, writes to Postgres, and tells no one.
6. CDC completion. See `services/debezium-connect`, diagram 05-cdc-completion-flow. The one idea is that the database change becomes an event that pushes done to the browser.
7. Queue, lifecycle, and history. See [`events-and-jobs.md`](events-and-jobs.md), diagram 06-event-queue-and-job-lifecycle. The one idea is one job's full lifecycle and why it survives logout, which is the read model.

By the end of step 7 you should be able to answer this. You click Start and nothing comes back with the result. How does the page ever show done?

### The live demo, run it during steps 4 through 7

1. Open https://localhost and log in as admin / admin.
2. Submit a job, for example "hello orbit". Note that the `202` returns instantly. The work has not happened yet.
3. About 3 seconds later the completed line appears over the WebSocket. Note that this was pushed. It was not the response to your click.
4. Persistence. Start another job, immediately log out, wait, then log back in. The finished job is still listed. That history came from Postgres, not the WebSocket.
5. The CDC magic trick. In a terminal, change a row by hand.
   ```
   docker compose exec postgres psql -U orbit -d orbit \
     -c "update jobs set status='completed', result='by hand' where id='<id>';"
   ```
   The browser updates with zero application code involved. That is Change Data Capture. Any committed database change becomes an event.

---

## Part 2 advanced modules, any order after the spine

Each module is independent. Pick what fits your time and interest. None of them change the application. They are about how the same app is run and shipped.

1. Local Kubernetes with kind. See [`03-kind-cluster.md`](03-kind-cluster.md), diagram 08-kubernetes-topology. It covers how the same services map onto a cluster.
2. Three node Kafka with Strimzi and KRaft. See [`04-kafka-strimzi.md`](04-kafka-strimzi.md), diagram 07-kafka-kraft-quorum. It covers operators, CRDs, and why you want a three node quorum.
3. Postgres and Debezium on Kubernetes. See [`05-postgres-debezium-cdc.md`](05-postgres-debezium-cdc.md), diagram 05-cdc-completion-flow. It covers logical replication and the connector as a resource.
4. GitOps with Argo CD. See [`07-argocd-setup.md`](07-argocd-setup.md), diagram 09-gitops-argocd. It covers desired state in git, app of apps, and users plus RBAC.
5. CI and Image Updater. See [`08-cicd-and-image-updater.md`](08-cicd-and-image-updater.md), diagram 10-cicd-image-pipeline. It covers building only the changed service and auto rolling on a new image.
6. Autoscaling the worker with KEDA. See [`10-autoscaling.md`](10-autoscaling.md), diagram 14-autoscaling. It covers scaling on a queue backlog, one more pod per 3 queued. Click Simulate load and watch the pods grow and shrink.
7. The monorepo with pnpm. See [`monorepo-pnpm.md`](monorepo-pnpm.md). It covers workspaces, one lockfile, and a polyglot repo.

Suggested grouping for a follow up session.

1. The running it block. Go kind, then Strimzi, then Postgres and Debezium. You now have the full stack on a real cluster.
2. The shipping it block. Go Argo CD, then CI and Image Updater. This is the GitOps loop. Push code, the right image builds, the cluster updates itself.

---

## What to deliberately de-emphasize

So you are not overwhelmed, treat these as production concerns to revisit later, not core to the spine, and move on.

1. NetworkPolicies. A default deny set is included as an example.
2. Secrets management. The repo uses plain demo secrets on purpose.
3. TLS trust. The cert is self signed. A real CA or cert-manager is a separate topic.
4. High availability and persistence tuning for Redis, Postgres, and Kafka.

Each is called out in the relevant `NOTES.md` and in [`06-services-and-auth.md`](06-services-and-auth.md) under what makes this secure and what does not.

---

## A note on reading the code

Every service keeps its narrative in a `NOTES.md` next to the code, so the source stays lean and realistic. When you walk a service, read its `NOTES.md`, then open the files it lists in order. The inline comments explain why an individual line exists. The `NOTES.md` explains why the service exists.
