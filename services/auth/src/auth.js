// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
// Session logic. Opaque session id in the cookie, revocable with a sliding TTL.
import { randomUUID } from "node:crypto";
import { redis } from "./redis.js";
import { config } from "./config.js";

export const COOKIE_NAME = config.auth.cookieName;
const TTL = config.auth.sessionTtlSeconds;

const key = (id) => `session:${id}`;

// real systems check a user store or an IdP here
export function checkCredentials(username, password) {
  return username === config.auth.demoUser && password === config.auth.demoPassword;
}

// create a session in Redis with a TTL and return its id for the cookie
export async function createSession(user) {
  const id = randomUUID();
  await redis.set(key(id), JSON.stringify({ user, role: "user" }), "EX", TTL);
  return id;
}

// look up a session. each hit resets the TTL so active sessions stay alive
export async function getSession(id) {
  if (!id) return null;
  const raw = await redis.get(key(id));
  if (!raw) return null;
  await redis.expire(key(id), TTL); // slide expiry forward
  return JSON.parse(raw);
}

// destroy a session on logout, instant unlike a JWT expiry
export async function destroySession(id) {
  if (id) await redis.del(key(id));
}
