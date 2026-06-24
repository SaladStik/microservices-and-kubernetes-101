<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# 07 Argo CD, GitOps, user accounts, and RBAC

> Part of the Orbit guides. Back: [Services & auth](06-services-and-auth.md) · Up: [Overview](00-overview.md) · Next: [CI/CD & Image Updater](08-cicd-and-image-updater.md)

So far you may have run `kubectl apply` by hand. That is fine for getting started, but the key idea of Orbit is GitOps. Git is the source of truth, and a controller in the cluster continuously makes the cluster match git. Nobody deploys by hand. That controller is Argo CD.

This guide installs Argo CD, connects it to your repo, deploys all of Orbit via the app of apps pattern, and then sets up local user accounts and RBAC so you can give others scoped access.

You need a running cluster from [03 kind](03-kind-cluster.md). You do not need Kafka or Postgres applied first. Argo CD will apply the `orbit-infra` app for you. You need `kubectl` and optionally the `argocd` CLI installed. See [01 Prerequisites](01-prerequisites.md). The CLI install is in Step 3.

The diagram is [`docs/diagrams/09-gitops-argocd.puml`](diagrams/09-gitops-argocd.puml). It shows git as desired, Argo CD in the middle, and the cluster as live, with selfHeal and prune.

## Step 1 Install Argo CD

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

Or use the Makefile shortcut, which is idempotent and safe to re run:

```bash
make argocd-install
```

Expected, abbreviated.

```
namespace/argocd created
customresourcedefinition.apiextensions.k8s.io/applications.argoproj.io created
deployment.apps/argocd-server created
deployment.apps/argocd-repo-server created
statefulset.apps/argocd-application-controller created
...
```

Wait for it to come up:

```bash
kubectl -n argocd rollout status deploy/argocd-server
kubectl -n argocd get pods
```

All pods should reach `Running` and `1-1 Ready` within a minute or two.

## Step 2 Get the initial admin password

Argo CD generates a random `admin` password on install and stores it in a secret:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d; echo
```

Or:

```bash
make argocd-password
```

Expect a random string like `kQ3xT9...`. Copy it. That is your `admin` login.

## Step 3 Access the UI and CLI

### Install the argocd CLI

```bash
brew install argocd     # macOS
```

For other platforms, see the prerequisites guide or the argoproj docs.

### Port forward the server

The install ships a `ClusterIP` service, so forward it to localhost. Use 8081 to avoid clashing with the app's edge, which kind maps to host `80` and `443`.

```bash
kubectl -n argocd port-forward svc/argocd-server 8081:443
```

For the UI, open <https://localhost:8081>, accept the self signed cert, and log in as `admin` with the password from Step 2.

For the CLI, in another terminal, use `--insecure` because of the self signed cert and `--grpc-web` because you are behind a port forward:

```bash
argocd login localhost:8081 --username admin --password '<password>' \
  --insecure --grpc-web
```

Expected.

```
'admin:login' logged in successfully
Context 'localhost:8081' updated
```

Change the admin password once you are in with `argocd account update-password`.

## Step 4 Connect the repo with a GitHub PAT

Argo CD must read your manifests from GitHub. A private repo needs credentials. Even for public repos, adding the repo explicitly is the clean way.

### Why a PAT or deploy key

Argo CD's repo server clones over HTTPS. A private repo requires auth. A Personal Access Token with read access, or a read only deploy key, lets Argo CD clone without using your password. Later, Image Updater needs a token with write access to commit tag bumps back. That is a separate token in [guide 08](08-cicd-and-image-updater.md). Keep read and write tokens distinct so you can scope and rotate them independently.

The click by click PAT creation steps live in [08 CI/CD & Image Updater, GitHub Personal Access Token](08-cicd-and-image-updater.md#step-1--create-a-github-personal-access-token). For this step you only need read access to the repo, classic `repo` scope, or fine grained Contents Read.

### Option A argocd repo add, imperative

```bash
argocd repo add https://github.com/<owner>/<repo>.git \
  --username <your-github-username> \
  --password <PAT>
```

Expected.

```
Repository 'https://github.com/<owner>/<repo>.git' added
```

### Option B declarative repo Secret, GitOps friendly

Same effect, but as a Kubernetes Secret labeled so Argo CD picks it up:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: orbit-repo
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository   # <-- this label is what matters
stringData:
  type: git
  url: https://github.com/<owner>/<repo>.git
  username: <your-github-username>
  password: <PAT>
```

```bash
kubectl apply -f orbit-repo-secret.yaml   # don't commit a filled-in copy!
```

The `argocd.argoproj.io/secret-type: repository` label is how Argo CD discovers the credential. Option B is preferable in real life because the declaration lives in git, with the secret value supplied separately, for example via SealedSecrets. For this setup, either is fine.

To verify, `argocd repo list` shows your repo with `STATUS: Successful`.

## Step 5 Deploy Orbit, project plus app of apps

```bash
make argocd-apps
```

That runs:

```bash
kubectl apply -f argocd/projects/orbit-project.yaml
kubectl apply -f argocd/app-of-apps.yaml
```

### The AppProject is a security boundary

[`argocd/projects/orbit-project.yaml`](../argocd/projects/orbit-project.yaml) defines the `orbit` AppProject. It constrains which repos apps may come from, which namespaces and clusters they may deploy to, `orbit` and `argocd`, and which resource kinds they may create. It whitelists the cluster scoped `Namespace` the infra app needs. Everything in Orbit lives under this project.

### The app of apps pattern

[`argocd/app-of-apps.yaml`](../argocd/app-of-apps.yaml) is a single root `Application` (`orbit-root`) that points at the `argocd/apps/` folder and recurses:

```yaml
spec:
  source:
    repoURL: https://github.com/your-org/orbit-microservices-k8s.git
    path: argocd/apps
    directory:
      recurse: true
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

Applying this one Application makes Argo CD pull in every child Application under `argocd/apps/`. That is `orbit-infra` for Kafka, Postgres, and Debezium, plus one per microservice, `orbit-auth`, `orbit-node-gateway`, `orbit-python-worker`, `orbit-nginx`, and `orbit-ui`. One apply, whole platform. That is the app of apps pattern.

Replace `your-org` with your GitHub owner in `argocd/app-of-apps.yaml` and all of `argocd/apps/*`, and `services/*/k8s/*`, so the `repoURL` and image names point at your fork. If you did the `sed` step in [guide 05](05-postgres-debezium-cdc.md#make-the-manifest-match-your-image), this is already done. Commit and push that change. Argo CD reads it from git.

### Automated sync, prune plus selfHeal

Every Orbit Application sets `automated: { prune: true, selfHeal: true }`. With selfHeal, if the live cluster drifts from git, say someone runs `kubectl edit` on a Deployment, Argo CD reverts it to match git. With prune, if you delete a manifest from git, Argo CD deletes the live resource. Git is authoritative in both directions.

To change the cluster, you change git, not the cluster.

### Verify

```bash
argocd app list
# or:
kubectl -n argocd get applications
```

Expect `orbit-root` plus children, marching toward `Synced` and `Healthy`:

```
NAME                  SYNC STATUS   HEALTH STATUS
orbit-root            Synced        Healthy
orbit-infra           Synced        Healthy
orbit-auth             Synced        Healthy
orbit-node-gateway    Synced        Healthy
orbit-python-worker   Synced        Healthy
orbit-nginx           Synced        Healthy
orbit-ui              Synced        Healthy
```

Watch one sync in detail:

```bash
argocd app get orbit-infra
argocd app sync orbit-infra    # force a sync if you're impatient
```

If an app is `OutOfSync` or `Degraded`, see [09 Troubleshooting, Argo CD app OutOfSync or Degraded](09-troubleshooting.md#argo-cd-app-outofsync--degraded). A common cause is `your-org` placeholders not replaced, so the `repoURL` or image does not resolve.

## Step 6 User accounts and RBAC with local users

`admin` is all powerful and you do not want to hand it out broadly. Argo CD supports local accounts plus RBAC to scope what each can do. SSO and OIDC also exist, where you wire Argo CD to an identity provider, but local users are plenty for this setup, so you use them.

There are two ConfigMaps in play. `argocd-cm` declares accounts and their capabilities. `argocd-rbac-cm` declares policies, who can do what.

### 6a. Add local users in argocd-cm

Add an `accounts.<name>` key. The value is a comma separated list of capabilities. `login` can log into the UI and CLI. `apiKey` can mint API tokens.

```bash
kubectl -n argocd edit configmap argocd-cm
```

Add under `data:`:

```yaml
data:
  accounts.alice: apiKey, login
  accounts.bob: login
```

The change is picked up live, no restart needed. Verify:

```bash
argocd account list
```

Expected.

```
NAME    ENABLED   CAPABILITIES
admin   true      login
alice   true      apiKey, login
bob     true      login
```

### 6b. Set passwords

New local accounts have no password until you set one. As `admin`:

```bash
argocd account update-password \
  --account alice \
  --current-password '<admin-password>' \
  --new-password '<alice-password>'
```

`--current-password` is the password of the account you are authenticated as, which is admin's. `--account alice` is who you are setting it for.

### 6c. Disable or enable an account

To revoke access without deleting the account, add `accounts.<name>.enabled: "false"` in `argocd-cm`:

```yaml
data:
  accounts.bob.enabled: "false"
```

Re enable by setting it back to `"true"` or removing the key. Disabled accounts cannot log in or use tokens.

### 6d. Define RBAC in argocd-rbac-cm

By default, non admin local users can do almost nothing, which is good. You grant abilities with policies.

Argo CD ships two built in roles. `role:admin` can do everything. `role:readonly` can view everything and change nothing. You can bind users to those, or define your own.

Edit the RBAC ConfigMap:

```bash
kubectl -n argocd edit configmap argocd-rbac-cm
```

Set `data:` to something like:

```yaml
data:
  # Default for anyone not matched below: read-only.
  policy.default: role:readonly

  policy.csv: |
    # --- a custom role: orbit developers can sync/view orbit's apps ---
    p, role:orbit-developer, applications, get,  orbit/*, allow
    p, role:orbit-developer, applications, sync, orbit/*, allow
    # (deliberately NOT granting applications/delete or update - devs can sync,
    #  not delete apps or edit their spec)

    # --- bind users to roles ---
    g, alice, role:orbit-developer
    g, bob,   role:readonly
```

Reading the policy lines. A line `p, <role>, <resource>, <action>, <object>, allow` is a permission. This role may perform `action` on `resource` matching `object`. So `applications, sync, orbit/*` means sync any Application in the `orbit` project, where `orbit/*` is `<project>/<app-name>`. Scoping to `orbit/*` means alice cannot touch apps in other projects.

A line `g, <user>, <role>` is a group binding. It grants `<role>` to `<user>`. And `policy.default` is the fallback role for unmatched subjects. `role:readonly` is a safe default. Everyone can look, only granted roles can act.

The change applies live. If you ever see it not take effect, the RBAC controller re reads the CM on change. A `kubectl -n argocd rollout restart deploy/argocd-server` forces it.

### 6e. Verify a user can only do what their role allows

Log in as alice and check her permissions:

```bash
argocd login localhost:8081 --username alice --password '<alice-password>' \
  --insecure --grpc-web

# Should SUCCEED - orbit-developer can sync orbit apps:
argocd app sync orbit-python-worker

# Should be DENIED - she has no delete permission:
argocd app delete orbit-python-worker
# => PermissionDenied desc = permission denied: applications, delete, orbit/orbit-python-worker
```

You can also dry run the policy without logging in, using the CLI's RBAC checker:

```bash
argocd admin settings rbac can alice sync 'orbit/orbit-python-worker' \
  --policy-file <(kubectl -n argocd get cm argocd-rbac-cm -o jsonpath='{.data.policy\.csv}')
# => Yes
argocd admin settings rbac can alice delete 'orbit/orbit-python-worker' \
  --policy-file <(kubectl -n argocd get cm argocd-rbac-cm -o jsonpath='{.data.policy\.csv}')
# => No
```

`Yes` and `No` confirm the policy does exactly what you intended.

## What you built

You installed Argo CD, accessed it via UI and CLI, and connected it to your repo with a read PAT. You deployed the whole Orbit platform via the app of apps pattern with automated prune and selfHeal, so git is now the source of truth. You created local user accounts with scoped RBAC, a custom `orbit-developer` role, verified to allow only what you intended.

Next, connect CI to this GitOps setup so a code push auto builds and auto deploys, including the GitHub PAT for write back and the Image Updater. See [08 CI/CD & Image Updater](08-cicd-and-image-updater.md).
