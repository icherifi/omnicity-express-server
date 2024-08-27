import { Router } from "express";
import { getCredential } from "../handlers/log";
import { createScan, getScans } from "../handlers/scan";

const router = Router();

// /api/uuid
router.get("/uuid", getCredential);


// /api/scans
router.post("/scans", createScan)

// /api/scans
router.get("/scans", getScans)
export default router;
