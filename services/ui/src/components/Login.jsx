// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
import { useState } from "react";
import { login } from "../backend/client.js";

// login form. no token, the auth service sets a cookie on success
export default function Login({ onLogin }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    try {
      const { user } = await login(username, password);
      onLogin(user);
    } catch {
      setError("Invalid credentials");
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h3>Sign in</h3>
      <label>Username</label>
      <input value={username} onChange={(e) => setUsername(e.target.value)} />
      <label>Password</label>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <div style={{ marginTop: 14 }}>
        <button type="submit">Login</button>
      </div>
      {error && <p className="muted">{error}</p>}
    </form>
  );
}
