import { Router } from "express";
import { saveDpeFormToDb } from "../handlers/dpe";

// Mounted behind verifyToken + requireApproved (see routes/index.ts).
const router = Router();

// /api/dpe/save-form  (the projectId in the body is checked by row level security)
router.post("/save-form", saveDpeFormToDb);

export default router;
