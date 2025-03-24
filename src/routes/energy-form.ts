import { Router } from "express";
import { verifyToken } from "../middleware/auth";
import { createSession, sendStepAnswer, getQuizSummary, getQuizResults } from "../handlers/energy-form";

const router = Router();

router.use(verifyToken);

// /api/energy-form/create-session
router.get("/create-session", createSession);

// /api/energy-form/send-step-answer
router.post("/send-step-answer", sendStepAnswer);

// /api/energy-form/get-quiz-summary/:sessionId
router.get("/get-quiz-summary/:sessionId", getQuizSummary);

// /api/energy-form/get-quiz-results
router.post("/get-quiz-results", getQuizResults);

export default router;