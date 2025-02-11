import { Router } from "express";
import { createScan, getScans, getScansByProjectId } from "../handlers/scan";

const router = Router();

// /api/scans
router.post("", createScan)

// /api/scans
router.get("", getScans)

// /api/scans/project/:projectId
router.get("/project/:projectId", getScansByProjectId);

export default router;
