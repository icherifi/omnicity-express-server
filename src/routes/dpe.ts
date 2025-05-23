import { Router } from "express";
import { saveDpeFormToDb } from "../handlers/dpe";
import { verifyToken } from "../middleware/auth";

const router = Router();

router.use(verifyToken);

// /api/dpe/save-form
router.post("/save-form", saveDpeFormToDb);

export default router;