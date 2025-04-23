import { Router } from "express";
import cors from "cors"; // Import cors middleware
import {
  createIziSession,
  sendStepIziAnswer,
  getQuizSummary,
  getQuizResults,
  autoFillForm
} from "../../handlers/energy";

const router = Router();

router.get("/session", createIziSession);
router.post("/step-answer", sendStepIziAnswer);
router.get("/quiz-summary/:sessionId", getQuizSummary);
router.post("/quiz-results", getQuizResults);
router.post("/auto-fill", autoFillForm);

export default router;