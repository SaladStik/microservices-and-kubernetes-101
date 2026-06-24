// Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
// Redis client wiring. Redis over JWT because it is revocable and shared.
import Redis from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.redis.url, {
  // keep retrying if Redis is not up yet
  maxRetriesPerRequest: null,
});

redis.on("connect", () => console.log(`[auth] connected to Redis at ${config.redis.url}`));
redis.on("error", (err) => console.error("[auth] redis error:", err.message));
