import { Router } from "express";
import { getModel } from "../handlers/localModels";

const router = Router();

// Deliberately no verifyToken - see src/handlers/localModels.ts's getModel comment.

// /api/local-models/model/:modelId
router.get("/model/:modelId", getModel);

export default router;
