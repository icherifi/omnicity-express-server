/** Persistent variant of verify-ikea-route.ts, for the frontend Phase 2 manual check. */
import express from "express";
import cors from "cors";
import ikeaRoutes from "../src/routes/ikea";

const app = express();
app.use(cors());
app.use("/api/ikea", ikeaRoutes);
app.listen(6301, () => console.log("ikea-only test server up on :6301"));
