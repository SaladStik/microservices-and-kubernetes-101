// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
// auth authority. login, logout, the auth_request verifier, and /api/me.
import express from "express";
import cookieParser from "cookie-parser";

import { config } from "./config.js";
import {
  checkCredentials,
  createSession,
  getSession,
  destroySession,
  COOKIE_NAME,
} from "./auth.js";

const app = express();
app.use(express.json());
app.use(cookieParser());

// ---- Health ----
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// nginx auth_request endpoint. 200 allows, 401 denies, also slides the TTL.
// Username goes back so nginx forwards it upstream as X-Auth-User.
app.get("/internal/verify", async (req, res) => {
  const session = await getSession(req.cookies[COOKIE_NAME]);
  if (!session) return res.status(401).end();
  res.set("X-Auth-User", session.user);
  res.status(200).end();
});

// ---- Login / logout -------------------------------------------------------
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!checkCredentials(username, password)) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  const sessionId = await createSession(username);
  res.cookie(COOKIE_NAME, sessionId, {
    httpOnly: true, // JS cannot read it so XSS cannot steal it
    sameSite: "lax",
    secure: config.auth.cookieSecure, // HTTPS only
    maxAge: config.auth.sessionTtlSeconds * 1000,
  });
  res.json({ ok: true, user: username });
});

app.post("/api/logout", async (req, res) => {
  await destroySession(req.cookies[COOKIE_NAME]); // kill it in Redis now
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get("/api/me", async (req, res) => {
  const session = await getSession(req.cookies[COOKIE_NAME]);
  if (!session) return res.status(401).json({ error: "unauthenticated" });
  res.json({ user: session.user, role: session.role });
});

// No /api/jobs here on purpose. nginx routes that straight to the node-gateway.

app.listen(config.port, () => console.log(`[auth] listening on :${config.port}`));
