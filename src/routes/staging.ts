import { Router } from "express";
import { startStaging, getStagingStatus } from "../handlers/staging";

const router = Router();

// /api/scans/:id/stage
router.post("/:id/stage", startStaging);
router.get("/:id/stage", getStagingStatus);

export default router;
