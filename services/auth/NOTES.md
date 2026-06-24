<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# auth notes

The auth authority and nothing else. This answers the where-does-auth-live question.

## What this service shows

1. An auth service is a thin backend for the frontend. Here it does exactly one job, identity. It does NOT touch jobs or Kafka.
2. Server side sessions in Redis versus stateless JWT. The cookie `orbit_token` is an opaque session id. The real data lives in Redis under `session:<id>`.
3. Revocable. Logout deletes the key so it is instantly invalid everywhere. A JWT stays valid until it expires.
4. Shared. Every auth service replica reads the same store so you scale horizontally.
5. Sliding TTL, the keep alive. Every verify refreshes the TTL, so active users stay logged in and idle ones expire after `ORBIT_SESSION_TTL`.
6. The `auth_request` contract. `/internal/verify` returns 200 with `X-Auth-User` or it returns 401. It is `internal` only, so a browser can never call it directly.
7. HttpOnly cookie. JS cannot read it so XSS cannot steal it. The browser sends it automatically. It is `Secure` because the edge is HTTPS.

## The key idea

Identity is a capability the edge consumes, not logic spread through services. Swapping JWT for Redis sessions changes only this service.

## Walk the code in this order

1. `config.js`, all env and defaults so the rest is pure logic.
2. `redis.js`, the session store client.
3. `auth.js`, create, get with slide TTL, destroy session, and `checkCredentials`.
4. `index.js`, `/internal/verify` and `/api/login|logout|me`. Note there is no /api/jobs.

## Demo live

1. Log in, then run `docker compose exec redis redis-cli keys 'session:*'` and see it.
2. Delete that key and the next action 401s, which is revocation. Show that the JWT cannot do that.

## Common questions

1. Why opaque cookie instead of JWT? You get revocation and a smaller blast radius.
2. What if Redis restarts? Demo Redis is in memory so everyone re logs in. Production would persist with AOF or RDB, or use managed Redis.
