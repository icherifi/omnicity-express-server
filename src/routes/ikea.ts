import { Router } from "express";
import { search, getProduct, getModel } from "../handlers/ikea";

const router = Router();

// Deliberately no verifyToken - read-only proxy to IKEA's own public catalog,
// not user data. See src/handlers/ikea.ts's getModel comment.

// /api/ikea/search?q=
router.get("/search", search);
router.get("/product/:itemNo", getProduct);
router.get("/model/:itemNo", getModel);

export default router;
