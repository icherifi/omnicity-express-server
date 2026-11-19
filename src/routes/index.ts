import { Router } from "express";
import projectRoutes from "./project";
import scanRoutes from "./scan";
import stagingRoutes from "./staging";
import ikeaRoutes from "./ikea";
import localModelRoutes from "./localModels";
import energyRoutes from "./energy/index";
import dpeRoutes from "./dpe";
import rgeRoutes from "./rge";
import { verifyToken, requireApproved } from "../middleware/auth";
import { getMe } from "../handlers/me";
import { expensiveLimiter } from "../middleware/security";

const router = Router();

// --- Public -----------------------------------------------------------------
router.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

// Read-only proxies for static catalog assets, fetched by the 3D viewer (no way to
// attach a Bearer header there). Ids are strictly validated in their handlers.
router.use("/ikea", ikeaRoutes);
router.use("/local-models", localModelRoutes);

// --- Any signed-in user (even if not yet activated) --------------------------
// Lets the clients know which screen to show ("account pending activation" or the app).
router.get("/me", verifyToken, getMe);

// --- Signed-in AND activated by an administrator -----------------------------
const requireActiveUser = [verifyToken, requireApproved];

router.use("/projects", requireActiveUser, projectRoutes);
router.use("/scans", requireActiveUser, scanRoutes);
router.use("/scans", requireActiveUser, stagingRoutes);
router.use("/energy", requireActiveUser, energyRoutes);
router.use("/dpe", requireActiveUser, dpeRoutes);
router.use("/rge", requireActiveUser, expensiveLimiter, rgeRoutes);

export default router;
