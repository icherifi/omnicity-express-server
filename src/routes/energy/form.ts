import { Router } from "express";
import cors from "cors"; // Import cors middleware
import {
  createSession,
  sendStepAnswer,
  getQuizSummary,
  getQuizResults
} from "../../handlers/energy";

const router = Router();

router.get("/session", createSession);
router.post("/step-answer", sendStepAnswer);
router.get("/quiz-summary/:sessionId", getQuizSummary);
router.post("/quiz-results", getQuizResults);

export default router;