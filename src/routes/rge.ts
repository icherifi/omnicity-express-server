import { Router } from "express";
import { searchRge } from "../handlers/rge";

const router = Router();

// GET /api/rge/search?q=...&domaine=...&code_postal=...&siret=...
router.get("/search", searchRge);

export default router; 