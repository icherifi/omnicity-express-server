import { Router } from "express";
import formRoutes from "./form";
import choiceRoutes from "./choice";

// Mounted behind verifyToken + requireApproved (see routes/index.ts).
// Per-project energy results live under /api/projects/:projectId/energy.
const router = Router();

router.use("/form", formRoutes);
router.use("/choice", choiceRoutes);

export default router;
