import { Router } from "express";
import { verifyToken } from "../middleware/auth";
import { saveEnergyMix } from "../handlers/energy-mix";

const router = Router();

router.use(verifyToken);

// /api/energy-mix/save-energy-mix
router.post("/save-energy-mix", saveEnergyMix);

export default router;