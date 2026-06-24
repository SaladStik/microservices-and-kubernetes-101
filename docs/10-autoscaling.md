<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# 10 Autoscaling the worker

Part of the Orbit guides. Back to [the big picture](00-overview.md).

Real load makes the queue grow. The system watches the Kafka backlog and runs
more workers, one more for every 3 queued messages. It floors at 1 and scales
back down once the backlog clears.

There are two versions, and they follow the same rule. One is real, one is a
stand-in.

1. Docker Compose, a stand-in. The `autoscaler` service is a small container that
   reads the backlog and scales the `python-worker` service. It runs
   automatically, so you just submit load with the Simulate load button or
   `make load` and watch the ready worker count climb and fall. This is NOT how
   you would scale in production. It is a hack to make the idea visible without a
   cluster. It mounts the Docker socket to scale a Compose service, which is fine
   on your laptop and nowhere else. Real Kubernetes does not have this service.
2. Kubernetes, the real way. KEDA scales the worker pods natively, on the same
   lag rule. There is no custom autoscaler container and no Docker socket. You
   declare a ScaledObject and KEDA does the rest. This is how it is done properly,
   and it is the version this guide covers.

So if you are reading the Compose setup and wondering why there is an autoscaler
container, that is why. On a real cluster you delete that idea and let KEDA do it.

The rest of this page is the Kubernetes version with KEDA.

## Before you start

1. You have the kind cluster up (guide 03), Strimzi Kafka (guide 04), and the
   app deployed (guides 05 and 07).
2. The processing service is up, not paused. The service down toggle pauses the
   worker, which is a different demo.

## How it works

KEDA reads the committed offsets of the `python-worker` consumer group and the
end of the `job.requests` topic. The gap between them is the backlog, called lag.
Desired pods is the lag divided by 3, rounded up, kept between 1 and 10. The
topic has 12 partitions, so up to 12 consumers can run in parallel.

The rule lives in [`services/python-worker/k8s/scaledobject.yaml`](../services/python-worker/k8s/scaledobject.yaml).
The worker Deployment has no `replicas` field on purpose. KEDA owns the count.

## Install KEDA

```bash
make keda-install
```

That runs helm. If you prefer plain manifests.

```bash
kubectl apply -f https://github.com/kedacore/keda/releases/download/v2.15.1/keda-2.15.1.yaml
```

The ScaledObject ships with the worker. Argo CD applies it, or apply it yourself.

```bash
kubectl apply -k services/python-worker/k8s
```

## Run the demo

1. Watch the worker pods in one terminal.

```bash
make watch-workers
```

2. Make load in another terminal. Pick a count with N.

```bash
make load N=30
```

You can also click Simulate load in the UI, which submits 20 jobs at once.

3. Watch the pods scale up toward 10, drain the backlog fast, then drop back to 1
   about 30 seconds after the queue is empty.

Check what KEDA created.

```bash
kubectl -n orbit get scaledobject
kubectl -n orbit get hpa
```

## What this shows

1. Scaling on a real signal, the queue backlog, not CPU.
2. More consumers in a group share the partitions, so throughput rises with pods.
3. The system scales itself up under load and back down when it is idle.

For why a single worker stays correct under load, see
[`events-and-jobs.md`](events-and-jobs.md). For setup problems, see
[`09-troubleshooting.md`](09-troubleshooting.md).
