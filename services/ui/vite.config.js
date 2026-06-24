// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// server.proxy only matters for npm run dev, forwarding /api and /ws to the stack
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // secure: false accepts the self signed dev cert
      "/api": { target: "https://localhost", changeOrigin: true, secure: false },
      "/ws": { target: "wss://localhost", ws: true, secure: false },
    },
  },
});
