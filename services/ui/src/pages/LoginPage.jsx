// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
import { useNavigate, Link } from "react-router-dom";
import Login from "../components/Login.jsx";

// /login route. on success record the user and go to the console
export default function LoginPage({ user, onLogin }) {
  const navigate = useNavigate();

  function handleLogin(u) {
    onLogin(u);
    navigate("/app");
  }

  return (
    <div>
      <Login onLogin={handleLogin} />
      <p className="muted">
        {user ? <Link to="/app">You're signed in - go to the console</Link>
              : <Link to="/">← back home</Link>}
      </p>
    </div>
  );
}
