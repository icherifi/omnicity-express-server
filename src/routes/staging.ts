import { Router } from "express";
import { startStaging, getStagingStatus } from "../handlers/staging";
import { requireScanAccess } from "../middleware/requireAccess";
import { expensiveLimiter } from "../middleware/security";

// Mounted behind verifyToken + requireApproved (see routes/index.ts).
const router = Router();

// The scan must belong to a project the caller can access before the service-role
// client (which bypasses row level security) is ever used by the handlers.
router.param("id", requireScanAccess);

// /api/scans/:id/stage
router.post("/:id/stage", expensiveLimiter, startStaging);
router.get("/:id/stage", getStagingStatus);

export default router;
