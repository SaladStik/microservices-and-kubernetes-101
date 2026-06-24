# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
# Run `make help` to list targets.
.DEFAULT_GOAL := help
SHELL := /bin/bash

CLUSTER ?= orbit
NS      ?= orbit
N       ?= 30

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# TLS, self signed, for the HTTPS edge
.PHONY: certs tls-secret
certs: ## Generate a self signed cert for the edge in services/nginx/certs
	./services/nginx/certs/generate-certs.sh

tls-secret: ## Create the nginx-tls Secret in the cluster from the generated cert
	kubectl create secret tls nginx-tls \
	  --cert=services/nginx/certs/tls.crt \
	  --key=services/nginx/certs/tls.key \
	  -n $(NS) --dry-run=client -o yaml | kubectl apply -f -

# Local, Docker Compose. certgen makes the TLS cert, so no make certs needed
.PHONY: up down logs rebuild
up: ## Start the whole stack locally with compose
	docker compose up --build -d
	@echo "open https://localhost   (login admin/admin)"

down: ## Stop the local stack and remove volumes
	docker compose down -v

reset: ## Full reset, wipe the Postgres db and Kafka topics, then start fresh
	./scripts/reset.sh

logs: ## Tail compose logs
	docker compose logs -f --tail=100

rebuild: ## Rebuild app images and restart
	docker compose up --build -d nginx ui auth node-gateway python-worker

# Kubernetes with kind
.PHONY: kind-up kind-down kustomize-build
kind-up: ## Create the local kind cluster
	kind create cluster --config k8s/kind/kind-cluster.yaml

kind-down: ## Delete the local kind cluster
	kind delete cluster --name $(CLUSTER)

load-images: ## Build app images and load them into kind for offline dev
	for svc in nginx ui auth node-gateway python-worker; do \
	  docker build -t orbit-$$svc:dev services/$$svc ; \
	  kind load docker-image orbit-$$svc:dev --name $(CLUSTER) ; \
	done

kustomize-build: ## Render all manifests to check them
	kubectl kustomize k8s/infra
	for svc in nginx ui auth node-gateway python-worker; do \
	  kubectl kustomize services/$$svc/k8s ; \
	done

# Autoscaling, KEDA scales the worker on Kafka backlog
.PHONY: keda-install load watch-workers
keda-install: ## Install KEDA into the cluster
	helm repo add kedacore https://kedacore.github.io/charts
	helm repo update
	helm install keda kedacore/keda --namespace keda --create-namespace

load: ## Submit N jobs to build a backlog. Override with N=50
	./scripts/load.sh $(N)

autoscale: ## Run the Compose autoscaler. Scales the worker on Kafka lag
	./scripts/autoscale.sh

watch-workers: ## Watch the worker pods scale up and down
	kubectl -n $(NS) get pods -l app=python-worker -w

# Argo CD
.PHONY: argocd-install argocd-password argocd-apps
argocd-install: ## Install Argo CD into the cluster
	kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

argocd-password: ## Print the initial Argo CD admin password
	kubectl -n argocd get secret argocd-initial-admin-secret \
	  -o jsonpath='{.data.password}' | base64 -d; echo

argocd-apps: ## Apply the Argo CD project and app-of-apps
	kubectl apply -f argocd/projects/orbit-project.yaml
	kubectl apply -f argocd/app-of-apps.yaml
