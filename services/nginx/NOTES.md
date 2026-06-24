<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# nginx notes

The single front door. Edge security lives here. The config file itself stays terse.

## What this service shows

1. One door. Only nginx is exposed. Every other service is on the internal network. Compare compose with one published port against k8s with NodePort plus NetworkPolicy.
2. TLS termination at the edge. `:80` exists only to `301` redirect to `:443`. TLS stops here and internal hops are plain HTTP on the trusted network. The self signed cert warning is itself worth noting.
3. Default deny allowlist. A route works only if you list it explicitly. `/api/` and `/internal/` fall through to `403`. Exact match (`=`) wins over prefixes.
4. Delegated auth with `auth_request`. Before a protected route, nginx fires a subrequest to the auth service `/internal/verify`. On 401 the upstream is never touched.
5. Trusted identity. On 200 the auth service returns the user. nginx forwards it as `X-Auth-User`, so internal services know who you are without validating anything.
6. Sync versus enqueue routing. `/api/login|logout|me` goes to the auth service for request and response. `/api/jobs` goes straight to the gateway as a command onto the queue.

## The key idea

Auth, TLS, and exposure are infrastructure concerns you solve once at the edge. Every microservice does not reimplement them.

## Demo live

1. `curl -I http://localhost` and see the `301` to https.
2. Hit `/api/jobs` without logging in and get `401` because auth_request blocked it.
3. Hit `/internal/verify` from the browser and get `403` because it is never public.

## Common questions

1. Why not auth in each service? You get duplication and drift. Centralize at the edge.
2. Is the self signed cert insecure? It is untrusted, not unencrypted. That is fine for local TLS. Production uses a real CA like cert-manager or Let's Encrypt.
