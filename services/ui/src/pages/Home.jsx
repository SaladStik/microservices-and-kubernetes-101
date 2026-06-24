// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
import { Link } from "react-router-dom";

// public landing page, no auth needed
export default function Home({ user }) {
  return (
    <div className="card">
      <h3>Welcome to Orbit</h3>
      <p className="muted">
        A tiny event-driven system: submit a job, it travels through Kafka to a
        worker, the result lands in Postgres, and Change Data Capture pushes
        "done" back to your browser over a WebSocket.
      </p>
      <p className="muted">
        This page is public. Everything that actually does work is behind a login.
      </p>
      <div style={{ marginTop: 16 }}>
        {user ? (
          <Link to="/app"><button>Open the console →</button></Link>
        ) : (
          <Link to="/login"><button>Login to continue →</button></Link>
        )}
      </div>
    </div>
  );
}
