// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
import { Navigate } from "react-router-dom";
import JobConsole from "../components/JobConsole.jsx";

// /app route. client side guard only, real enforcement is server side on /api and /ws
export default function ConsolePage({ user, onLogout }) {
  if (!user) return <Navigate to="/login" replace />;
  return <JobConsole user={user} onLogout={onLogout} />;
}
