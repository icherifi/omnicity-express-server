import { Router } from "express";
import projectRoutes from "./project";
import scanRoutes from "./scan";
import { getCredential } from "../handlers/log";
import energyFormRoutes from "./energy-form";
import energyMixRoutes from "./energy-mix";

const router = Router();

// /api/uuid
router.get("/uuid", getCredential);


router.use("/projects", projectRoutes);
router.use("/scans", scanRoutes);
router.use("/energy-form", energyFormRoutes);
router.use("/energy-mix", energyMixRoutes);

export default router;