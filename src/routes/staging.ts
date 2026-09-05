import { Router } from "express";
import { startStaging, getStagingStatus } from "../handlers/staging";
import { verifyToken } from "../middleware/auth";

const router = Router();

router.use(verifyToken);

// /api/scans/:id/stage
router.post("/:id/stage", startStaging);
router.get("/:id/stage", getStagingStatus);

export default router;
