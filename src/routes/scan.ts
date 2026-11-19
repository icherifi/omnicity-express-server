import { Router } from "express";
import { createScan, getScansByProjectId } from "../handlers/scan";
import { requireProjectAccess } from "../middleware/requireAccess";

// Mounted behind verifyToken + requireApproved (see routes/index.ts).
// There is deliberately no "list every scan" route any more.
const router = Router();

router.param("projectId", requireProjectAccess);

// /api/scans  (the project_id in the body is checked by row level security)
router.post("", createScan);

// /api/scans/project/:projectId
router.get("/project/:projectId", getScansByProjectId);

export default router;
