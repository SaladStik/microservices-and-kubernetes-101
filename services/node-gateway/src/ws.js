// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
// WebSocket hub. Browser subscribes by jobId, we push CDC updates back.
import { WebSocketServer } from "ws";

// maps a jobId to a Set of WebSocket connections
const subscribers = new Map();

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "subscribe" && msg.jobId) {
          if (!subscribers.has(msg.jobId)) subscribers.set(msg.jobId, new Set());
          subscribers.get(msg.jobId).add(ws);
        }
      } catch {
        /* ignore bad client messages */
      }
    });

    ws.on("close", () => {
      for (const set of subscribers.values()) set.delete(ws);
    });
  });

  console.log("[gateway] WebSocket hub listening on /ws");
}

// the CDC consumer calls this when a job row changes
export function notifyJobUpdate(after) {
  const jobId = after.id;
  const set = subscribers.get(jobId);
  if (!set || set.size === 0) return;

  const payload = JSON.stringify({
    type: "job-update",
    jobId,
    status: after.status,
    result: after.result,
    payload: after.payload,
    created_at: after.created_at,
  });

  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}
