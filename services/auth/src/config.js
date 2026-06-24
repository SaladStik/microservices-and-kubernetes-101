// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
// Config helper. All env reading and defaults live here.
export const config = {
  port: Number(process.env.PORT || 3000),

  // server side sessions live in Redis
  redis: {
    url: process.env.REDIS_URL || "redis://redis:6379",
  },

  // in production these come from a secret store, never code
  auth: {
    demoUser: process.env.ORBIT_DEMO_USER || "admin",
    demoPassword: process.env.ORBIT_DEMO_PASSWORD || "admin",
    cookieName: "orbit_token",
    // session lifetime in seconds, reset on each check to keep it alive
    sessionTtlSeconds: Number(process.env.ORBIT_SESSION_TTL || 3600),
    // Secure cookie travels over HTTPS only, true since the edge is TLS
    cookieSecure: process.env.ORBIT_COOKIE_SECURE === "true",
  },
};
