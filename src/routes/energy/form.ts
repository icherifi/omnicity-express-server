import { Router } from "express";
import cors from "cors"; // Import cors middleware
import {
  createIziSessionHandler,
  sendStepIziAnswerHandler,
  getQuizSummary,
  getQuizResults,
  autoFillForm
} from "../../handlers/energy";

const router = Router();

router.get("/session", createIziSessionHandler);
router.post("/step-answer", sendStepIziAnswerHandler);
router.get("/quiz-summary/:sessionId", getQuizSummary);
router.post("/quiz-results", getQuizResults);
router.post("/auto-fill", autoFillForm);

export default router;