// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
import { useEffect, useRef, useState, useCallback } from "react";

// WebSocket not polling, the server pushes job completion driven by CDC

export function useJobSocket() {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);
  const socketRef = useRef(null);

  useEffect(() => {
    let closed = false;
    let retry;

    // reconnect on close so live updates survive a dropped connection
    function connect() {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      socketRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "job-update") setLastEvent(msg);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
    }
    connect();

    // stop reconnecting and close on unmount
    return () => {
      closed = true;
      clearTimeout(retry);
      socketRef.current?.close();
    };
  }, []);

  // subscribe to a jobId. safe for queued history jobs, completion arrives live
  const subscribe = useCallback((jobId) => {
    socketRef.current?.send(JSON.stringify({ type: "subscribe", jobId }));
  }, []);

  return { connected, subscribe, lastEvent };
}
