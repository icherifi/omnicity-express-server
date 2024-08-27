import { Router } from "express";
import { createProject, getProjects } from "../handlers/project";

const router = Router();

// /api/projects
router.post("/projects", createProject);

// /api/projects/
router.get("/projects", getProjects);

// /api/projects/:projectId
//router.get("/scans", getScans)
export default router;
