<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# Orbit Diagrams

Bite sized PlantUML diagrams, one idea each. Any single diagram should be graspable in under a minute. Read them roughly in order. The first few build the mental model and the later ones cover Kafka internals, Kubernetes, and the CI and GitOps pipeline.

## What each diagram shows

1. `01-system-context.puml`, the whole system on one page, who talks to who, including `ui`, `redis`, the HTTPS edge, and `/api/jobs` going straight to the gateway.
2. `02-internal-network-security.puml`, only nginx is exposed and everything else is internal, with NetworkPolicies enforcing this in k8s.
3. `03-auth-flow.puml`, nginx runs an `auth_request` to the auth service, which looks up a Redis backed session, an opaque cookie with sliding TTL keep alive, revocable on logout, and internal services never see the cookie.
4. `04-job-request-flow.puml`, a job is a command, nginx authenticates it then proxies straight to the gateway with the auth service bypassed, which records a `queued` row with owner, publishes to `job.requests`, and returns `202 "queued"`.
5. `05-cdc-completion-flow.puml`, how the UI learns a job is done, the worker UPDATEs the existing row to `completed`, Debezium captures it, and the result rides a WebSocket back.
6. `06-event-queue-and-job-lifecycle.puml`, one job's full lifecycle as a state machine (Submitted, Queued, Processing, Completed, Captured, Delivered) with event queue vocabulary and a note on durable history, read back on later login, independent of the live WebSocket.
7. `07-kafka-kraft-quorum.puml`, the three node KRaft quorum, each node is controller plus broker, RF=3 and min-ISR=2, tolerates one failure.
8. `08-kubernetes-topology.puml`, how the services map onto a kind cluster in namespace `orbit`, with nginx on NodePorts (30080/30443 to host 80/443).
9. `09-gitops-argocd.puml`, git holds desired state and Argo CD (app of apps to child Applications) reconciles it into the live cluster.
10. `10-cicd-image-pipeline.puml`, push, GitHub Actions builds the changed service, GHCR with tag = SHA, Image Updater writes the tag back to git, and Argo CD rolls the Deployment.
11. `11-end-to-end-sequence.puml`, the comprehensive happy path from login with a Redis session through job submission, CDC completion, and reading history back after logout and login.
12. `12-tls-edge.puml`, TLS terminates at the nginx edge, `http://localhost` :80 to 301 to `https://localhost` :443, and internal services speak plain HTTP.
13. `13-dead-letter-queue.puml`, what happens to a job that cannot be processed, it is parked in the dead letter queue, not lost and not blocking, and replayed once a down service recovers.
14. `14-autoscaling.puml`, KEDA scales the worker on the Kafka backlog, one more pod per 3 queued, floor 1 and ceiling 10.
15. `15-rolling-update.puml`, zero downtime rollout. Argo CD applies the new image, Kubernetes starts the new pod, waits for it to be healthy, then kills the old one.

## How to render PlantUML

PlantUML files (`.puml`) are plain text. You need a renderer to turn them into images.

### VS Code, easiest while editing

1. Install the PlantUML extension, author jebbs.
2. Open any `.puml` file and press Alt+D to open a live preview. You need either a local Java plus Graphviz install, or point the extension at a PlantUML server, see the extension settings.

### PlantUML CLI

```bash
# requires Java + Graphviz, plus plantuml.jar (or a 'plantuml' wrapper)
plantuml docs/diagrams/*.puml          # -> PNGs next to each .puml
plantuml -tsvg docs/diagrams/*.puml    # -> SVGs instead
```

### Docker, no local install

```bash
docker run --rm -v "$PWD:/work" plantuml/plantuml -tpng /work/docs/diagrams/*.puml
```

Swap `-tpng` for `-tsvg` if you prefer scalable output.

### Viewing on GitHub

GitHub does NOT render `.puml` files natively. Some browser extensions and external viewers, such as the PlantUML proxy and `planttext.com`, can display them. For a guaranteed preview, render to PNG or SVG using one of the methods above and commit or link the image.
