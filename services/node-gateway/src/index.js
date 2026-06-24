// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
// node-gateway event hub. Enqueues jobs, serves history, consumes CDC, pushes WS.
// Identity arrives already verified as X-Auth-User from nginx.
import http from "node:http";
import express from "express";
import { v4 as uuidv4 } from "uuid";

import { config } from "./config.js";
import { connectProducer, publishJob, consumeCdc } from "./kafka.js";
import { recordAccepted, markQueued, listForOwner, getWorkerAvailable, setWorkerAvailable, getAutoscale, setAutoscale, countReadyWorkers } from "./db.js";
import { attachWebSocket, notifyJobUpdate } from "./ws.js";

const app = express();
app.use(express.json());

// identity is set at the edge by nginx as X-Auth-User, gateway just reads it
const ownerOf = (req) => req.header("x-auth-user") || "anonymous";

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// start a job. write the row as accepted, publish, then mark it queued. if the
// publish fails the row stays accepted, in the database but not on the queue
app.post("/jobs", async (req, res) => {
  const jobId = uuidv4();
  const owner = ownerOf(req);
  const payload = (req.body && req.body.payload) || "hello";

  await recordAccepted({ jobId, payload, owner });
  try {
    await publishJob({ jobId, payload, owner });
    await markQueued(jobId);
    console.log(`[gateway] queued job ${jobId} for ${owner}`);
    res.status(202).json({ jobId, status: "queued" });
  } catch (err) {
    console.error(`[gateway] publish failed, job ${jobId} stays accepted: ${err.message}`);
    res.status(202).json({ jobId, status: "accepted" });
  }
});

// this user's job history, newest first
app.get("/jobs", async (req, res) => {
  const jobs = await listForOwner(ownerOf(req));
  res.json({ jobs });
});

// read or toggle autoscaling. off makes the autoscaler hold the worker at 1
app.get("/autoscale", async (_req, res) => {
  try {
    res.json({ enabled: await getAutoscale() });
  } catch (err) {
    console.error("[gateway] autoscale read failed", err);
    res.json({ enabled: true });
  }
});
app.post("/autoscale", async (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  try {
    await setAutoscale(enabled);
    console.log(`[gateway] autoscaling set to ${enabled}`);
    res.json({ enabled });
  } catch (err) {
    console.error("[gateway] autoscale write failed", err);
    res.status(500).json({ error: "could not change autoscaling" });
  }
});

// how many workers are alive and ready to process
app.get("/workers", async (_req, res) => {
  try {
    res.json({ ready: await countReadyWorkers() });
  } catch (err) {
    console.error("[gateway] worker count failed", err);
    res.json({ ready: 1 });
  }
});

// read or toggle whether the worker is up. off pauses it so jobs queue in Kafka
app.get("/worker", async (_req, res) => {
  try {
    res.json({ available: await getWorkerAvailable() });
  } catch (err) {
    console.error("[gateway] worker state read failed", err);
    res.json({ available: true }); // fail open
  }
});
app.post("/worker", async (req, res) => {
  const available = !!(req.body && req.body.available);
  try {
    await setWorkerAvailable(available);
    console.log(`[gateway] worker availability set to ${available}`);
    res.json({ available });
  } catch (err) {
    console.error("[gateway] worker state write failed", err);
    res.status(500).json({ error: "could not change service state" });
  }
});

const server = http.createServer(app);
attachWebSocket(server);

// start the CDC consumer and fan row changes out to WS. retry until it sticks,
// since Debezium creates the topic only on the first row change
function startCdc() {
  consumeCdc((after, op) => {
    console.log(`[gateway] CDC ${op} for job ${after.id} -> ${after.status}`);
    notifyJobUpdate(after);
  }).catch((err) => {
    console.error(`[gateway] CDC consumer not ready, retrying in 3s: ${err.message}`);
    setTimeout(startCdc, 3000);
  });
}

async function start() {
  await connectProducer();
  startCdc();
  server.listen(config.port, () => console.log(`[gateway] listening on :${config.port}`));
}

start().catch((err) => {
  console.error("[gateway] fatal", err);
  process.exit(1);
});
