import { Router } from "express";
import { verifyToken } from "../../middleware/auth";
import {
  saveEnergyResult,
  getEnergyResult
} from "../../handlers/energy";
import formRoutes from "./form";
import choiceRoutes from "./choice";

const router = Router();

router.use(verifyToken);

router.post("/result/:projectId", saveEnergyResult);
router.get("/result/:projectId", getEnergyResult);

router.use("/form", formRoutes);
router.use("/choice", choiceRoutes);

export default router; 