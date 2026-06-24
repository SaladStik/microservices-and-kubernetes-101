// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
import { useEffect, useState } from "react";
import { createJob, listJobs, getWorkerState, setWorkerState, getWorkers, getAutoscale, setAutoscale } from "../backend/client.js";
import { useJobSocket } from "../hooks/useJobSocket.js";

// status order, so a job never moves backward when events arrive out of order
const RANK = { accepted: 1, queued: 2, processing: 3, completed: 4, failed: 4 };

// main screen once logged in. request via createJob, live response via the socket,
// history from Postgres, plus the worker up and down toggle
export default function JobConsole({ user, onLogout }) {
  const [payload, setPayload] = useState("hello orbit");
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState({}); // keyed by id so updates and history merge
  const [workerUp, setWorkerUp] = useState(true);
  const [workersReady, setWorkersReady] = useState(1);
  const [autoscale, setAutoscaleOn] = useState(true);
  const { connected, subscribe, lastEvent } = useJobSocket();

  const upsert = (job) =>
    setJobs((prev) => {
      const cur = prev[job.id] || {};
      const merged = { ...cur, ...job };
      // never move a status backward
      if (cur.status && job.status && (RANK[job.status] || 0) < (RANK[cur.status] || 0)) {
        merged.status = cur.status;
        merged.result = cur.result ?? job.result;
      }
      return { ...prev, [job.id]: merged };
    });

  // load history and resubscribe to in flight jobs once the socket is ready
  useEffect(() => {
    if (!connected) return;
    listJobs().then((history) => {
      const map = {};
      for (const j of history) {
        map[j.id] = j;
        if (j.status !== "completed" && j.status !== "failed") subscribe(j.id);
      }
      setJobs((prev) => ({ ...map, ...prev }));
    });
  }, [connected, subscribe]);

  // poll worker state and the ready worker count so the indicators stay honest
  useEffect(() => {
    let alive = true;
    const tick = () => {
      getWorkerState().then((s) => alive && setWorkerUp(s.available));
      getWorkers().then((w) => alive && setWorkersReady(w.ready));
      getAutoscale().then((a) => alive && setAutoscaleOn(a.enabled));
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // merge each live update into the list
  useEffect(() => {
    if (lastEvent)
      upsert({
        id: lastEvent.jobId,
        status: lastEvent.status,
        result: lastEvent.result,
        payload: lastEvent.payload,
        created_at: lastEvent.created_at,
      });
  }, [lastEvent]);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const { jobId, status } = await createJob(payload); // returns right away with 202
      upsert({ id: jobId, payload, status: status || "accepted", created_at: new Date().toISOString() });
      subscribe(jobId); // done arrives later
    } catch {
      // ignore a transient submit failure
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleWorker(available) {
    try {
      const s = await setWorkerState(available);
      setWorkerUp(s.available);
    } catch {
      // ignore a transient toggle failure
    }
  }

  async function toggleAutoscale(enabled) {
    try {
      const a = await setAutoscale(enabled);
      setAutoscaleOn(a.enabled);
    } catch {
      // ignore a transient toggle failure
    }
  }

  // fire many jobs at once to build a backlog. on Kubernetes KEDA scales the worker
  async function simulateLoad(n = 20) {
    setSubmitting(true);
    try {
      await Promise.all(
        Array.from({ length: n }, async (_, i) => {
          try {
            const { jobId, status } = await createJob(`load ${i + 1}`);
            upsert({ id: jobId, payload: `load ${i + 1}`, status: status || "accepted", created_at: new Date().toISOString() });
            subscribe(jobId);
          } catch {
            // ignore a transient failure in the burst
          }
        })
      );
    } finally {
      setSubmitting(false);
    }
  }

  const rows = Object.values(jobs).sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || "")
  );

  return (
    <div className="card">
      <div className="between">
        <h3 style={{ margin: 0 }}>Your jobs</h3>
        <span className="muted">
          {connected ? "live" : "connecting"} · signed in as <b>{user}</b> ·{" "}
          <a href="#" onClick={onLogout}>logout</a>
        </span>
      </div>

      {/* resilience demo, toggle the processing service */}
      <div className="between" style={{ margin: "8px 0 4px" }}>
        <span>
          Processing service:{" "}
          {workerUp
            ? <span className="pill done">up</span>
            : <span className="pill err">down</span>}
          {"  "}
          <span className="pill done">{workersReady} ready to process</span>
        </span>
        {workerUp ? (
          <button onClick={() => toggleWorker(false)}>Simulate service down</button>
        ) : (
          <button onClick={() => toggleWorker(true)}>Bring service back up</button>
        )}
      </div>

      {/* autoscaling on and off */}
      <div className="between" style={{ margin: "4px 0" }}>
        <span>
          Autoscaling:{" "}
          {autoscale
            ? <span className="pill done">on</span>
            : <span className="pill err">off</span>}
        </span>
        {autoscale ? (
          <button onClick={() => toggleAutoscale(false)}>Turn autoscaling off</button>
        ) : (
          <button onClick={() => toggleAutoscale(true)}>Turn autoscaling on</button>
        )}
      </div>
      {!workerUp && (
        <p className="muted">
          The worker is paused. Submit a job now - it will sit <b>queued</b> in
          Kafka (nothing is lost). Hit <b>Bring service back up</b> and watch the
          worker catch up and complete it.
        </p>
      )}

      <label>Payload (the worker reverses it; include "fail" to force a dead-letter)</label>
      <div className="row">
        <input style={{ flex: 1 }} value={payload} onChange={(e) => setPayload(e.target.value)} />
        <button onClick={handleSubmit} disabled={submitting || !connected}>
          Start job
        </button>
        <button onClick={() => simulateLoad(20)} disabled={submitting || !connected}>
          Simulate load
        </button>
      </div>

      <p className="muted">
        Live updates arrive over the WebSocket; history is loaded from Postgres
        (the read model), so a job finished while you were logged out still shows.
      </p>

      <div className="log">
        {rows.length === 0 && <div className="muted">No jobs yet - start one above.</div>}
        {rows.map((j) => (
          <div className="line" key={j.id}>
            <code>{j.id.slice(0, 8)}</code>{" "}
            {j.status === "completed" ? (
              <><span className="pill done">completed</span> result: <b>{j.result}</b></>
            ) : j.status === "failed" ? (
              <>
                <span className="pill err">failed</span> couldn't be processed (a
                downstream service may be down). Parked in the dead-letter queue
                and can be replayed once it recovers. <i>{j.result}</i>
              </>
            ) : j.status === "accepted" ? (
              <><span className="pill err">accepted</span> saved to the database but not on the queue yet</>
            ) : j.status === "processing" ? (
              <><span className="pill pending">processing</span> the worker is on it</>
            ) : (
              <>
                <span className="pill pending">{j.status || "queued"}</span>{" "}
                {workerUp ? "waiting for the worker…" : "queued - service is down, waiting in the queue"}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
