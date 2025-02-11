import { Router } from "express";
import projectRoutes from "./project";
import scanRoutes from "./scan";
import { getCredential } from "../handlers/log";

const router = Router();

// /api/uuid
router.get("/uuid", getCredential);


router.use("/projects", projectRoutes);
router.use("/scans", scanRoutes);

export default router;