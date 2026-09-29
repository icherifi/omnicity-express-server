/**
 * Persistent standalone server exposing only /api/ikea/* - for exercising the
 * frontend against a real endpoint while stagingOrchestratorService.ts is
 * mid-migration and doesn't compile yet (blocking the real `npm run dev`).
 * Defaults to 6300 (the real server's usual port, free until that's fixed);
 * override with PORT=... if the real server happens to be up too.
 */
import express from "express";
import cors from "cors";
import ikeaRoutes from "../src/routes/ikea";

const PORT = Number(process.env.PORT) || 6300;
const app = express();
app.use(cors());
app.use("/api/ikea", ikeaRoutes);
app.listen(PORT, () => console.log(`ikea-only test server up on :${PORT}`));
