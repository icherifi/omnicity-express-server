import { Router } from "express";
import { saveEnergyChoice } from "../../handlers/energy";

const router = Router();

router.post("/", saveEnergyChoice);

export default router; 