// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import Home from "./pages/Home.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import ConsolePage from "./pages/ConsolePage.jsx";
import { getMe, logout } from "./backend/client.js";

// routes and current user. /app is guarded, redirects to /login if no user
export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  // ask who am i so a valid cookie skips login. 401 just means not logged in
  useEffect(() => {
    getMe().then((me) => {
      if (me) setUser(me.user);
      setReady(true);
    });
  }, []);

  async function handleLogout(e) {
    e?.preventDefault();
    await logout();
    setUser(null);
  }

  return (
    <BrowserRouter>
      <div className="wrap">
        <h1><Link to="/" style={{ color: "inherit", textDecoration: "none" }}>Orbit</Link></h1>
        <p className="muted">
          UI → nginx → auth service (auth) → gateway → Kafka → worker → Postgres → Debezium →
          gateway → you.
        </p>

        {!ready ? (
          <p className="muted">Loading…</p>
        ) : (
          <Routes>
            <Route path="/" element={<Home user={user} />} />
            <Route path="/login" element={<LoginPage user={user} onLogin={setUser} />} />
            <Route path="/app" element={<ConsolePage user={user} onLogout={handleLogout} />} />
          </Routes>
        )}
      </div>
    </BrowserRouter>
  );
}
