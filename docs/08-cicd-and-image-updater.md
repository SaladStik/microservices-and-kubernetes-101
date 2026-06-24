<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# 08 CI/CD plus GitHub PAT plus Argo CD Image Updater

> Part of the Orbit guides. Back: [Argo CD setup](07-argocd-setup.md) · Up: [Overview](00-overview.md) · Next: [Troubleshooting](09-troubleshooting.md)

In [07 Argo CD](07-argocd-setup.md) git became the source of truth. Change git, the cluster follows. But who changes git when you ship new code? This guide closes the loop. You push code, CI builds just the changed image, Argo CD Image Updater writes the new tag back to git, Argo CD syncs, and the Deployment rolls.

No human edits a manifest to deploy. This guide also covers the GitHub Personal Access Token you need, with click by click steps, and exactly which token is used for which job.

The diagrams are [`docs/diagrams/10-cicd-image-pipeline.puml`](diagrams/10-cicd-image-pipeline.puml) for the full loop and [`docs/diagrams/09-gitops-argocd.puml`](diagrams/09-gitops-argocd.puml) for the GitOps half.

## Who uses which token, read this first

There are three credentials, and confusing them is the number one source of pain.

1. CI pushes images to GHCR using the workflow's built in `GITHUB_TOKEN` with `packages: write`. GitHub Actions auto provides it. No PAT needed.
2. Argo CD reads your repo using a PAT with read, Contents Read or `repo`. It clones private manifests. This is set up in [guide 07](07-argocd-setup.md#step-4--connect-the-repo-github-pat).
3. Image Updater writes the tag back to git using a PAT with write, Contents Read and Write or `repo`. It commits the `.argocd-source-*.yaml` bump.
4. The cluster pulls a private GHCR image using a PAT with `read:packages` as a pull secret. This is only needed if the GHCR package is private.

The key insight is that CI does not need a PAT. GitHub Actions injects a scoped `GITHUB_TOKEN` per run. Granting it `packages: write`, which the workflow does, is enough to push to your own GHCR. The PATs are for the GitOps side, Argo CD and Image Updater, which runs in your cluster, outside GitHub.

## Step 1 Create a GitHub Personal Access Token

To find the page, go to GitHub, your avatar, Settings, Developer settings at the bottom of the left sidebar, then Personal access tokens.

GitHub offers two kinds. Either works. Fine grained is the modern, narrower one.

### Classic token

1. Go to Personal access tokens, Tokens (classic), Generate new token (classic).
2. Give it a name and expiry.
3. Set scopes. `repo` is required for Image Updater's git write back, and to clone a private repo. `repo` covers Contents read and write. `write:packages` plus `read:packages` is only needed if you push to GHCR manually, for example the Debezium image in [guide 05](05-postgres-debezium-cdc.md). CI does not need this in a PAT, it uses `GITHUB_TOKEN`. `read:packages` is required to pull a private GHCR image into the cluster, the `ghcr-creds` pull secret.
4. Click Generate token, copy it now, you cannot see it again.

### Fine grained token

1. Go to Personal access tokens, Fine grained tokens, Generate new token.
2. Set Resource owner to you or your org, and Repository access to the Orbit repo.
3. Set Repository permissions. Contents Read and write is for git write back and repo clone. Packages Read and write, or Read only if you only pull, is for GHCR.
4. Click Generate token, copy it.

The minimum for the loop in this guide is a token that can write Contents, for git write back. Add Packages Read only if your GHCR package is private.

Keep these out of git. The example secret files ([`argocd/image-updater/git-creds.example.yaml`](../argocd/image-updater/git-creds.example.yaml), [`argocd/image-updater/ghcr-creds.example.yaml`](../argocd/image-updater/ghcr-creds.example.yaml)) are templates. Copy to a non committed filename before filling in.

## Step 2 Understand the CI workflow

[`.github/workflows/build-changed-service.yml`](../.github/workflows/build-changed-service.yml) builds only the service you changed.

1. The `detect` job uses `dorny/paths-filter` to check which `services/<name>/` folders changed and emits a JSON list, for example `["auth","python-worker"]`:
   ```yaml
   filters: |
     ui: services/ui/**
     auth: services/auth/**
     node-gateway: services/node-gateway/**
     python-worker: services/python-worker/**
     nginx: services/nginx/**
     debezium-connect: services/debezium-connect/**
   ```
2. The `build` job is a matrix over exactly that list, so a one line auth service change rebuilds only the auth service image:
   ```yaml
   matrix:
     service: ${{ fromJSON(needs.detect.outputs.services) }}
   permissions:
     contents: read
     packages: write          # <-- lets GITHUB_TOKEN push to GHCR
   ```
3. Each image is built and pushed with two tags, the commit SHA and `latest`:
   ```yaml
   tags: |
     ghcr.io/${{ owner }}/orbit-${{ matrix.service }}:${{ github.sha }}
     ghcr.io/${{ owner }}/orbit-${{ matrix.service }}:latest
   ```
   It logs into GHCR with the built in `secrets.GITHUB_TOKEN` and only `push`es on `push` events to `main`. PRs build but do not push.

The SHA tag is the linchpin. Image Updater watches GHCR for new SHA shaped tags and rolls the matching Deployment when one appears. `latest` is just a convenience pointer.

### Public versus private GHCR package

After CI's first push, the package appears under your account's Packages. By default a new package is private.

A public package lets the cluster pull and lets Image Updater list tags with no credentials. This is simplest for class. Make it public at the GHCR package, Package settings, Change visibility, Public.

A private package means you must give the cluster a pull secret and Image Updater a read token, Step 4b.

## Step 3 Install Argo CD Image Updater

Image Updater is a separate controller that lives next to Argo CD:

```bash
kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj-labs/argocd-image-updater/stable/manifests/install.yaml
```

Expected, abbreviated.

```
serviceaccount/argocd-image-updater created
configmap/argocd-image-updater-config created
deployment.apps/argocd-image-updater created
```

Wait for it:

```bash
kubectl -n argocd rollout status deploy/argocd-image-updater
```

## Step 4 Give Image Updater its credentials

### 4a. Git write back credential, git-creds, required

Image Updater commits the new tag back to git, so it needs a token that can write Contents. From the template [`argocd/image-updater/git-creds.example.yaml`](../argocd/image-updater/git-creds.example.yaml):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: git-creds
  namespace: argocd
type: Opaque
stringData:
  username: <your-github-username>
  password: <PAT-with-Contents-write>
```

```bash
cp argocd/image-updater/git-creds.example.yaml git-creds.local.yaml
# edit in your username + write PAT, then:
kubectl apply -f git-creds.local.yaml
```

Do not commit the filled in file. Name it `*.local.yaml`, covered by `.gitignore`, or add it yourself.

Each Application already requests `write-back-method: git`, see Step 5. If your secret is not the default name, point the Application at it with `write-back-method: git:secret:argocd/git-creds`.

### 4b. GHCR pull and read credential, ghcr-creds, private packages only

Skip this if your GHCR package is public. For a private package, create a docker registry secret so pods can pull and Image Updater can list tags. The one liner, from [`argocd/image-updater/ghcr-creds.example.yaml`](../argocd/image-updater/ghcr-creds.example.yaml):

```bash
kubectl create secret docker-registry ghcr-creds \
  --docker-server=ghcr.io \
  --docker-username=<your-github-username> \
  --docker-password=<PAT-with-read:packages> \
  -n orbit
```

Then tell Image Updater to use it by adding to each app Application:

```yaml
argocd-image-updater.argoproj.io/img.pull-secret: pullsecret:orbit/ghcr-creds
```

## Step 5 The per Application annotations, already in the repo

Each app Application under `argocd/apps/*` already carries the Image Updater annotations. From [`argocd/apps/python-worker.yaml`](../argocd/apps/python-worker.yaml):

```yaml
annotations:
  argocd-image-updater.argoproj.io/image-list: img=ghcr.io/your-org/orbit-python-worker
  argocd-image-updater.argoproj.io/img.update-strategy: newest-build
  argocd-image-updater.argoproj.io/img.allow-tags: regexp:^[0-9a-f]{7,40}$
  argocd-image-updater.argoproj.io/img.kustomize.image-name: orbit-python-worker
  argocd-image-updater.argoproj.io/write-back-method: git
  argocd-image-updater.argoproj.io/git-branch: main
```

Line by line.

`image-list: img=ghcr.io/.../orbit-python-worker` is the image to watch, under the alias `img`.

`img.update-strategy: newest-build` picks the most recently pushed image, correct for SHA tags, which do not sort by version.

`img.allow-tags: regexp:^[0-9a-f]{7,40}$` only considers SHA shaped tags. This deliberately ignores `latest` and any other label, so the Deployment pins to an immutable commit, not a moving tag.

`img.kustomize.image-name: orbit-python-worker` is which kustomize image to rewrite. It matches `images[].name` in the service's kustomization ([`services/python-worker/k8s/kustomization.yaml`](../services/python-worker/k8s/kustomization.yaml)):

```yaml
images:
  - name: orbit-python-worker
    newName: ghcr.io/your-org/orbit-python-worker
    newTag: latest
```

`write-back-method: git` commits the change back to the repo using `git-creds`, rather than patching the live cluster.

`git-branch: main` is the branch to commit to.

Replace `your-org` with your GitHub owner in `argocd/apps/*` and `services/*/k8s/*`. The `image-list` and `newName` must point at your GHCR. If you ran the `sed` in [guide 05](05-postgres-debezium-cdc.md#make-the-manifest-match-your-image), done. Commit and push so Argo CD reads it.

## Step 6 End to end demo

Let's watch a code change flow all the way to a rolling Deployment. You touch `python-worker`. Any service works.

### 1. Make a trivial change, commit, push

```bash
# bump a comment / log line in the worker
echo "# touch $(date +%s)" >> services/python-worker/main.py
git checkout -b demo/cdc-bump
git add services/python-worker/main.py
git commit -m "demo: trivial python-worker change"
git push -u origin demo/cdc-bump
# then open a PR and merge to main (the workflow pushes images on main)
```

Images are pushed only on `push` to `main`. PRs build only. Merge to main.

### 2. Watch CI build only that image

Go to GitHub, Actions, the `build-changed-service` run. Expect `detect` to output `["python-worker"]`. Expect `build` to run one matrix leg, python-worker, and push `ghcr.io/<owner>/orbit-python-worker:<sha>` plus `:latest`.

Confirm the new tag exists under your account's Packages.

### 3. Watch Image Updater detect the new SHA tag

```bash
kubectl -n argocd logs deploy/argocd-image-updater -f
```

Expected lines, abbreviated.

```
Setting new image to ghcr.io/<owner>/orbit-python-worker:<sha>
Committing 1 parameter update(s) for application orbit-python-worker
Successfully updated image '...orbit-python-worker' to '...:<sha>', writing back to git
```

It polls roughly every couple of minutes, so be patient, or restart the deploy to poke it.

### 4. Watch it write the tag back to git

Image Updater commits a `.argocd-source-orbit-python-worker.yaml` override file, or updates the kustomization image tag, into `services/python-worker/k8s/` on `main`. Pull and look:

```bash
git fetch origin main && git log origin/main --oneline -3
```

You will see a commit authored by the Image Updater bumping the tag to the new SHA. The deploy is a git commit, exactly the GitOps promise.

### 5. Watch Argo CD sync and the Deployment roll

```bash
argocd app get orbit-python-worker
kubectl -n orbit rollout status deploy/python-worker
```

Argo CD notices git changed, a new SHA in the manifest, syncs, and Kubernetes rolls the Deployment to the new image:

```
NAME                  SYNC STATUS   HEALTH STATUS
orbit-python-worker   Synced        Healthy
...
deployment "python-worker" successfully rolled out
```

Confirm the running image is the new SHA:

```bash
kubectl -n orbit get deploy python-worker \
  -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
# => ghcr.io/<owner>/orbit-python-worker:<sha>
```

That is the whole loop. Push, build, write back, sync, roll, with no human editing a manifest. Diagram 10 traces each arrow.

## Troubleshooting

Image Updater logs nothing or says "no candidate". Check `allow-tags` matches your tag, SHA shaped, and the package is reachable, public or `ghcr-creds` applied for private. Confirm `image-list` points at your owner, not `your-org`.

`failed to push: authentication required` on write back means the `git-creds` PAT lacks Contents Write, or `repo`. Recreate it, Step 1, and re apply the secret.

`ImagePullBackOff` after the roll means a private package without a pull secret. Create `ghcr-creds`, Step 4b, and reference it. See [09 Troubleshooting, Images won't pull](09-troubleshooting.md#images-wont-pull-imagepullbackoff).

App `OutOfSync` and never settles. Make sure `your-org` is replaced and the branch matches `git-branch: main`. See [09 Troubleshooting, Argo CD app OutOfSync](09-troubleshooting.md#argo-cd-app-outofsync--degraded).

## What you built

You built a clear map of which credential does which job, CI's `GITHUB_TOKEN` versus the read and write PATs. You built a change only CI pipeline pushing SHA tagged images to GHCR. You wired Argo CD Image Updater to commit new tags back to git, closing the loop so a code push auto deploys through GitOps.

You have now built the whole Orbit platform, app, event bus, CDC, GitOps, and CI/CD. If something misbehaves, head to [09 Troubleshooting](09-troubleshooting.md).
