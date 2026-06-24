// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
// Postgres access for the gateway read model.
import pg from "pg";
import { config } from "./config.js";

const pool = new pg.Pool(config.pg);

// write the row as accepted. it is in the database but not yet on the queue
export async function recordAccepted({ jobId, payload, owner }) {
  await pool.query(
    `INSERT INTO jobs (id, payload, owner, status)
     VALUES ($1, $2, $3, 'accepted')
     ON CONFLICT (id) DO NOTHING`,
    [jobId, payload, owner]
  );
}

// move accepted to queued once the Kafka publish succeeds. if it stays accepted,
// the job is in the database but never reached the queue
export async function markQueued(jobId) {
  await pool.query(
    `UPDATE jobs SET status = 'queued', updated_at = now()
     WHERE id = $1 AND status = 'accepted'`,
    [jobId]
  );
}

// a user's recent jobs, newest first
export async function listForOwner(owner, limit = 200) {
  const { rows } = await pool.query(
    `SELECT id, payload, status, result, created_at, updated_at
     FROM jobs
     WHERE owner = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [owner, limit]
  );
  return rows;
}

// control flag the UI flips. false pauses the worker so jobs queue in Kafka
export async function getWorkerAvailable() {
  const { rows } = await pool.query("SELECT available FROM worker_control WHERE id = 1");
  return rows.length ? rows[0].available : true;
}

// how many workers heartbeated recently, so the UI can show ready workers
export async function countReadyWorkers() {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM worker_heartbeat WHERE last_seen > now() - interval '10 seconds'"
  );
  return rows[0].n;
}

export async function setWorkerAvailable(available) {
  await pool.query("UPDATE worker_control SET available = $1 WHERE id = 1", [available]);
}

// autoscaling on or off. off makes the autoscaler hold the worker at the floor
export async function getAutoscale() {
  const { rows } = await pool.query("SELECT autoscale FROM worker_control WHERE id = 1");
  return rows.length ? rows[0].autoscale : true;
}

export async function setAutoscale(enabled) {
  await pool.query("UPDATE worker_control SET autoscale = $1 WHERE id = 1", [enabled]);
}
