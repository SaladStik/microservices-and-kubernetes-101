<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# 06 Services and Auth, the edge, the auth service, and each service

This is the deep dive on how requests get in and who is allowed. The headline idea is that there is exactly one door into Orbit (nginx). It terminates TLS, it is default deny, and a single backend (the auth service) is the auth authority, backed by server side sessions in Redis. Because of that, the business services carry no auth code at all.

This pairs with [diagram 02, internal network security](diagrams/02-internal-network-security.puml), [diagram 03, auth flow](diagrams/03-auth-flow.puml), and [diagram 12, TLS edge](diagrams/12-tls-edge.puml). For the event side of the system see [`events-and-jobs.md`](events-and-jobs.md). For the big picture see [`00-overview.md`](00-overview.md).

---

## nginx, the sole ingress, default deny

In both Docker Compose and Kubernetes, only nginx is reachable from outside. In compose that is enforced by mapping a single port. In k8s it is a NodePort on nginx plus NetworkPolicies that block everything else. Every other service lives on the internal network and is never exposed.

nginx is configured to deny by default. A route only works if it is explicitly allowlisted. Walk through [`services/nginx/conf.d/default.conf`](../services/nginx/conf.d/default.conf).

---

## TLS terminates at the edge and only there

Before any of the routing happens, nginx does one more job. It terminates TLS and HTTPS. There are two `server` blocks in [`default.conf`](../services/nginx/conf.d/default.conf).

```nginx
# :80 exists only to bounce you to HTTPS
server {
    listen 80;
    return 301 https://$host$request_uri;
}

# :443 is the real edge
server {
    listen 443 ssl;
    ssl_certificate     /etc/nginx/certs/tls.crt;
    ssl_certificate_key /etc/nginx/certs/tls.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ...
}
```

So you open `https://localhost`, and `http://localhost` issues a `301` redirect to it. That redirect is the key idea in why `:80` and `:443` differ. Plaintext exists only to escort you to the encrypted port, never to serve real traffic.

1. Self signed cert for the demo. The key and cert are generated with `make certs` into [`services/nginx/certs/`](../services/nginx/certs) and mounted at `/etc/nginx/certs` (a volume in compose, a TLS `Secret` in k8s). They are never baked into the image. Your browser will warn once because the cert is self signed, which is expected here.
2. The session cookie is `Secure`. Because the edge is now HTTPS, the auth service sets `secure: true` on `orbit_token`, so the browser refuses to send it over plain HTTP.
3. Internal traffic stays plain HTTP. TLS terminates at the edge. Behind it, on the trusted internal network, services speak plain HTTP. There is no cert to manage on the auth service, gateway, Redis, Postgres, or Kafka. In a zero trust setup you would add mTLS internally too. See the shortcuts list below.

See [diagram 12, TLS edge](diagrams/12-tls-edge.puml).

---

## The routes, walked through

### Public routes, no auth needed

```nginx
location = /api/login  { proxy_pass http://auth; }
location = /api/logout { proxy_pass http://auth; }
location = /api/me     { proxy_pass http://auth; }   # auth service returns 401 itself
location / { proxy_pass http://ui; }                 # the UI shell + assets
```

The login endpoints must be public. You cannot authenticate if the door to authenticating is locked. They go to the auth service, the auth authority. `/` serves the React UI from the separate `ui` service. The page is public, but the data behind it is not.

### Protected routes, auth_request first

```nginx
location = /api/jobs {
    auth_request        /_auth;
    auth_request_set    $auth_user $upstream_http_x_auth_user;
    proxy_set_header    X-Auth-User $auth_user;
    proxy_pass          http://node_gateway/jobs;   # STRAIGHT to the gateway
}

location = /ws {
    auth_request        /_auth;
    auth_request_set    $auth_user $upstream_http_x_auth_user;
    proxy_set_header    X-Auth-User $auth_user;
    proxy_pass          http://node_gateway;
    proxy_http_version  1.1;
    proxy_set_header    Upgrade $http_upgrade;
    proxy_set_header    Connection "upgrade";
    proxy_read_timeout  3600s;
}
```

Starting a job (`/api/jobs`) and the live updates WebSocket (`/ws`) both run an `auth_request` before the upstream is ever touched. Here is the important change. `/api/jobs` proxies straight to the `node-gateway`, not the auth service, rewriting the path to the gateway's `/jobs`. The auth service answers auth questions. A job is a command, so once nginx has confirmed who you are, it hands the command directly to the queue producer. The same route serves the read model. A `GET /api/jobs` hits the gateway's history endpoint, and a `POST` enqueues a new job. This is the split where auth is synchronous and goes to the auth service while work is enqueued and goes to the gateway, enforced right here in the proxy config. More on the command and query split is in [`events-and-jobs.md`](events-and-jobs.md).

### Explicitly denied

```nginx
location /api/      { return 403; }   # any /api/* not allowlisted above
location /internal/ { return 403; }   # the auth service's verifier is NOT public
```

These prefix rules are the default deny net. The exact match (`=`) routes above always win in nginx, so `= /api/jobs` is allowed while the catch all `/api/` refuses everything else. The key point is that `/internal/` is refused from outside. A browser can never call the verifier directly.

---

## The auth_request to auth service /internal/verify pattern

This is the heart of edge auth. When nginx hits a protected route, it fires an internal subrequest to `/_auth`, which proxies to the auth service ([`default.conf`](../services/nginx/conf.d/default.conf)).

```nginx
location = /_auth {
    internal;                                   # only nginx can reach this
    proxy_pass              http://auth/internal/verify;
    proxy_pass_request_body off;                # the verifier doesn't need the body
    proxy_set_header        Content-Length "";
    proxy_set_header        Cookie $http_cookie; # forward the session cookie
}
```

The auth service's verifier is tiny ([`services/auth/src/index.js`](../services/auth/src/index.js)).

```js
app.get("/internal/verify", async (req, res) => {
  const session = await getSession(req.cookies[COOKIE_NAME]); // look up Redis + slide TTL
  if (!session) return res.status(401).end();    // -> nginx refuses the request
  res.set("X-Auth-User", session.user);          // -> trusted identity upstream
  res.status(200).end();                          // -> nginx proceeds
});
```

The contract has three parts.

1. A 200 means nginx continues to the real upstream.
2. A 401 means nginx rejects the original request and the upstream is never reached.
3. On 200 the auth service returns the username in `X-Auth-User`. nginx captures it (`auth_request_set $auth_user $upstream_http_x_auth_user`) and forwards it upstream as a trusted header. So `node-gateway` knows who for free, without ever validating anything.

Note that `getSession` doesn't just read the session. It also refreshes the TTL on every hit (sliding expiration). Since nginx runs `auth_request` before every protected request, an active user's session is continually kept alive, while an idle one expires after `ORBIT_SESSION_TTL`. More on that next.

See [diagram 03](diagrams/03-auth-flow.puml) for the request and subrequest sequence.

---

## Why node-gateway and python-worker have no auth

By the time a request reaches the gateway, nginx has already asked the auth service whether this is allowed and gotten a yes. The gateway therefore trusts the internal network and implements no auth. Its `index.js` says exactly that. The python-worker never even has an HTTP server. It only speaks Kafka and Postgres, both internal only.

This is the payoff of edge auth. Auth logic lives in one place (the auth service), the business services stay small and focused on events, and there is no auth code duplicated or subtly wrong across services.

---

## Server side sessions in Redis, not a stateless JWT

On a successful login the auth service creates a server side session in Redis and hands the browser only an opaque session id in an HttpOnly cookie ([`services/auth/src/index.js`](../services/auth/src/index.js)).

```js
const sessionId = await createSession(username);   // random UUID, data stored in Redis
res.cookie(COOKIE_NAME, sessionId, {
  httpOnly: true,                  // JavaScript CANNOT read this cookie -> mitigates XSS theft
  sameSite: "lax",
  secure: config.auth.cookieSecure, // true now that the edge serves HTTPS
  maxAge: config.auth.sessionTtlSeconds * 1000,
});
```

The session itself lives in Redis under `session:<uuid>`, and the cookie value is just that UUID. It carries no claims. The whole session lifecycle is three small functions in [`auth.js`](../services/auth/src/auth.js).

```js
// createSession: store {user, role} in Redis with a TTL, return the id
await redis.set(key(id), JSON.stringify({ user, role: "user" }), "EX", TTL);

// getSession: read it back AND slide the TTL forward ("keep the session alive")
const raw = await redis.get(key(id));
if (raw) await redis.expire(key(id), TTL);

// destroySession: delete the key -> instant, global logout
await redis.del(key(id));
```

Why server side sessions instead of a stateless JWT? There are three key points, spelled out in [`redis.js`](../services/auth/src/redis.js).

1. Revocable. Logout `DEL`s the key, so the session dies instantly, everywhere. A stateless JWT stays valid until it expires. You cannot easily kill one without building extra denylist machinery.
2. Shared. Every auth service replica reads the same Redis, so you can scale the auth service horizontally and a user's session works no matter which pod handles the request.
3. Sliding keep alive. Because `getSession` resets the TTL on every check, and nginx checks on every protected request, active users stay logged in while idle ones expire. That is a property you would have to bolt onto JWTs by hand.

Two key points about the cookie itself.

1. HttpOnly means client side JavaScript literally cannot read it. Even if an attacker injects a script (XSS), they cannot exfiltrate the session id. The browser still attaches it automatically to same origin requests, so the UI never has to store or handle anything. See the comment in [`services/ui/src/backend/client.js`](../services/ui/src/backend/client.js) that says there is NO token handling here. Note the folder is named `auth/`, not `api/`. The UI has no API of its own. It is just a thin client to the auth service node service, and any real work is enqueued, not executed here.
2. The cookie value is meaningless on its own. It is a random UUID, and the real identity is the Redis lookup. Steal the cookie and you have a session only until the user logs out (which revokes it) or it idles out.

The demo's `verify` forwards `session.user` as the trusted identity. That only works because `/internal/verify` is unreachable from outside (the `/internal/` deny rule) and the cookie is HttpOnly. The browser can present a valid cookie but cannot read it, forge a session id, or reach the verifier directly.

---

## The UI routing, public Home, login, guarded console

The React app ([`services/ui/src/App.jsx`](../services/ui/src/App.jsx)) has three routes.

1. `/` shows the `Home` page. It is public. This is the landing page that explains the demo, no auth.
2. `/login` shows the `LoginPage`. This is the login form.
3. `/app` shows the `ConsolePage`. It is guarded. This is the job console.

On load the app calls `getMe()` so a returning user with a valid cookie skips the login form. The guard on `/app` is in [`ConsolePage.jsx`](../services/ui/src/pages/ConsolePage.jsx).

```jsx
if (!user) return <Navigate to="/login" replace />;
```

This client side guard is UX only. It is there so an unauthenticated visitor gets bounced to a nice login page instead of a broken console. It is not a security boundary, and the page's comment says so directly. The real enforcement is server side. nginx and the auth service reject every `/api/jobs` and `/ws` call without a valid cookie, no matter what the browser's JavaScript does. A user could edit the React state to see the console and still not be able to start a job or open the WebSocket. Never rely on the frontend for authorization.

---

## What makes this secure, and what doesn't

### The real protections, keep these

1. TLS at the edge. nginx serves HTTPS on `:443` and redirects `:80` to it. The session cookie is `Secure`, so it never travels in plaintext. See [diagram 12](diagrams/12-tls-edge.puml).
2. Single ingress. Only nginx is exposed, so there is exactly one door to reason about. See [diagram 02](diagrams/02-internal-network-security.puml).
3. Default deny allowlist. nginx refuses everything not explicitly listed (`/api/` returns 403, `/internal/` returns 403). New endpoints are closed until opened.
4. Edge auth via `auth_request`. Auth is checked before the upstream is touched, in one place (the auth service). See [diagram 03](diagrams/03-auth-flow.puml).
5. Revocable server side sessions. Sessions live in Redis. Logout deletes the key for instant, global revocation, and the opaque cookie carries no claims to forge. A stateless JWT stays valid until it expires.
6. Internal only services. `node-gateway` and `python-worker` are not reachable from outside and hold no secrets or auth logic.
7. NetworkPolicies (k8s). In the cluster, the network layer enforces the same rule that only nginx is public and services only talk to what they need, not just the proxy config.
8. HttpOnly cookie. The session id cannot be read or stolen by client JS.

### Deliberate shortcuts, harden before production

1. Self signed TLS cert. `make certs` generates a self signed cert ([`services/nginx/certs/`](../services/nginx/certs)), so browsers warn and there is no trust chain. Use a real CA issued cert (for example cert-manager plus Let's Encrypt) in production.
2. Demo credentials. `admin` and `admin`, hardcoded defaults ([`auth/src/config.js`](../services/auth/src/config.js)). Replace with a real identity provider or user store.
3. In repo secrets and passwords. The Postgres password and other demo defaults live in code and manifests. Move them to a real secret store (sealed secrets, External Secrets, a vault). Never commit them.
4. Plain HTTP internally. TLS terminates at the edge, and services trust the internal network. In a zero trust environment you would add mTLS between the proxy and upstreams, which also stops the `X-Auth-User` header from being spoofed.
5. Single demo user, single role. Everyone is `role: "user"`. Real systems need multiple users and proper authorization (RBAC), plus per user data scoping.
6. No rate limiting or abuse protection. Login and job submission are not throttled. Add rate limiting (for example nginx `limit_req`) and brute force protection on login.
7. Trusted `X-Auth-User` header. This is safe only because `/internal/` is denied and the internal network is closed. In a hostile network you would want mTLS between the proxy and upstreams so the header cannot be spoofed.

The README links here for exactly this list. It is the map of what is a demo and what is real for the whole repo.

---

## Where to go next

1. The event queue end of the system is in [`events-and-jobs.md`](events-and-jobs.md).
2. How the JS services are organized and built is in [`monorepo-pnpm.md`](monorepo-pnpm.md).
3. Argo CD accounts and RBAC, auth for the platform, is in [`07-argocd-setup.md`](07-argocd-setup.md).
4. Back to the overview is [`00-overview.md`](00-overview.md).
