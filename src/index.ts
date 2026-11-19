import express, { NextFunction, Request, Response } from "express";
import router from "./routes";
import cors from "cors";
import helmet from "helmet";
import { buildCorsOptions, globalLimiter } from "./middleware/security";
import { recoverInterruptedStagingRuns } from "./handlers/staging";

const app = express();

// Fly.io terminates TLS in front of us: trust it so rate limiting sees the real client IP.
app.set("trust proxy", 1);

app.use(helmet({
  // GLB models are loaded by the front-end from another origin.
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// CORS allow-list (CORS_ORIGINS), also answers preflight requests.
const corsOptions = buildCorsOptions();
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(globalLimiter);

// Room scans are sent as JSON; images/files go through multer with their own limits.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "25mb" }));

app.use("/api", router);

// Last-resort error handler: never leak internals to the client.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large" });
  }
  if (err?.name === "MulterError") {
    return res.status(400).json({ error: err.message });
  }
  console.error("Unhandled error", err);
  res.status(500).json({ error: "Server error" });
});

const PORT = process.env.PORT || 6300;

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  recoverInterruptedStagingRuns().catch((e) => console.error("Staging recovery failed", e));
});
