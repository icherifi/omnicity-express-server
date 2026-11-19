import { CorsOptions } from "cors";
import rateLimit from "express-rate-limit";

/**
 * CORS allow-list. CORS_ORIGINS is a comma separated list of allowed front-end origins
 * (e.g. "https://app.example.com,http://localhost:3000"). Requests without an Origin
 * header (the iOS app, curl, server-to-server) are not browser cross-origin requests
 * and are always allowed; they are protected by the Bearer token.
 */
export function buildCorsOptions(): CorsOptions {
  const allowed = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  if (allowed.length === 0 && process.env.NODE_ENV === "production") {
    console.warn("CORS_ORIGINS is not set: every browser origin will be refused in production.");
  }

  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowed.includes(origin)) return callback(null, true);
      // Local development convenience only.
      if (process.env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    maxAge: 600,
  };
}

/** General ceiling per IP. */
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

/** Routes that cost real money or call third parties (OpenAI, Claude, ADEME, IZI). */
export const expensiveLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
