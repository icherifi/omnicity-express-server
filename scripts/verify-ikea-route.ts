/**
 * Standalone check that the new /api/ikea/model/:itemNo route actually serves a
 * real file over HTTP - isolated from stagingOrchestratorService.ts (mid-Phase-4
 * rewrite, expected to not compile against the new types yet), by mounting only
 * the ikea router directly rather than going through routes/index.ts.
 *
 * Run: npx ts-node scripts/verify-ikea-route.ts
 */
import express from "express";
import ikeaRoutes from "../src/routes/ikea";

const app = express();
app.use("/api/ikea", ikeaRoutes);

const PORT = 6301;
const server = app.listen(PORT, async () => {
  console.log(`test server up on :${PORT}`);
  try {
    const resp = await fetch(`http://localhost:${PORT}/api/ikea/model/70294339`);
    console.log("status:", resp.status);
    console.log("content-type:", resp.headers.get("content-type"));
    const buf = Buffer.from(await resp.arrayBuffer());
    console.log("bytes:", buf.length);
    console.log("looks like glb magic (glTF):", buf.readUInt32LE(0) === 0x46546c67);
  } finally {
    server.close();
  }
});
