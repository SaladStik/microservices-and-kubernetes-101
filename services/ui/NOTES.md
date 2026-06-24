<!-- Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/ -->
# ui notes

A React and Vite SPA, its own deployable service. Focus on the two things that are not generic React, the auth model and the live channel. Basic JSX and state does not need explaining.

## What this service shows

1. The UI has no API of its own. `src/backend/client.js` is a thin client. Auth calls go to the auth service. A job command goes to `/api/jobs` which nginx routes straight to the gateway. The UI contains no business logic.
2. No token in JavaScript. Auth is an HttpOnly cookie the browser attaches automatically. JS literally cannot read it, so XSS cannot steal it.
3. WebSocket means server pushed updates. `src/hooks/useJobSocket.js` is the key file. HTTP is the client asking and the server answering. A WebSocket stays open so the server can speak first. Job completion is pushed, not polled.
4. Push for live versus query for catch up. On login the console calls `listJobs()` once to load history, the jobs that finished while you were away. Then it relies on the WebSocket for live updates. Two transports, on purpose.
5. Public versus guarded routes. `/` (Home) is public. `/login` is public. `/app` is guarded client side, but the real enforcement is server side through nginx and the auth service. The client guard is only for UX.

## The key idea

The done line is not the response to your click. It is a separate event, pushed later, triggered by a database change three services away.

## Walk the code in this order

1. `src/backend/client.js`, the thin client for auth, enqueue, and history.
2. `src/hooks/useJobSocket.js`, the WebSocket lifecycle and the key idea.
3. `src/components/JobConsole.jsx`, merges history and live updates by jobId.
4. `src/App.jsx` and `pages/*`, routing and the public versus guarded split.

## Demo live

1. Start a job, log out, wait, then log back in and see it listed as completed. That history comes from Postgres. Then start another and watch it flip live over the WebSocket.

## Common questions

1. Why a separate UI service? You ship and scale the frontend independently of the auth service.
2. Why not poll for status? Polling wastes requests. The server pushes when ready.
