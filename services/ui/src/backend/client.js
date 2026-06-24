// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
// thin client. auth is an HttpOnly cookie, no token handling

async function request(path, options = {}) {
  try {
    return await fetch(path, {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      ...options,
    });
  } catch {
    // network blip, for example during a restart. act like a failed response
    return { ok: false, status: 0, json: async () => ({}) };
  }
}

// auth, synchronous and not queued
export async function login(username, password) {
  const res = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error("Invalid credentials");
  return res.json();
}

export async function logout() {
  await request("/api/logout", { method: "POST" });
}

// current user, or null when not logged in (401)
export async function getMe() {
  const res = await request("/api/me");
  if (!res.ok) return null;
  return res.json();
}

// enqueue, do not execute. gateway publishes to Kafka, done arrives over the WebSocket
export async function createJob(payload) {
  const res = await request("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ payload }),
  });
  if (!res.ok) throw new Error("Could not submit job");
  return res.json();
}

// job history from the Postgres read model, so jobs finished while logged out still show
export async function listJobs() {
  const res = await request("/api/jobs");
  if (!res.ok) return [];
  const data = await res.json();
  return data.jobs || [];
}

// service down demo. when down, jobs queue in Kafka until the worker returns
export async function getWorkerState() {
  const res = await request("/api/worker");
  if (!res.ok) return { available: true };
  return res.json();
}

export async function setWorkerState(available) {
  const res = await request("/api/worker", {
    method: "POST",
    body: JSON.stringify({ available }),
  });
  if (!res.ok) throw new Error("Could not change service state");
  return res.json();
}

// how many workers are alive and ready to process
export async function getWorkers() {
  const res = await request("/api/workers");
  if (!res.ok) return { ready: 1 };
  return res.json();
}

// autoscaling on or off
export async function getAutoscale() {
  const res = await request("/api/autoscale");
  if (!res.ok) return { enabled: true };
  return res.json();
}

export async function setAutoscale(enabled) {
  const res = await request("/api/autoscale", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error("Could not change autoscaling");
  return res.json();
}
