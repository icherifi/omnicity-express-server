import { Router } from "express";
import { getProjects, findProject, updateProject, deleteProject, uploadImage, createProjects, getProjectImages, updateProjectImageFullPath } from "../handlers/project";
import { getScansByProjectId } from "../handlers/scan";
import { verifyToken } from "../middleware/auth";
import { saveEnergyResult, getEnergyResult } from "../handlers/energy";

const router = Router();

router.use(verifyToken);

// /api/projects/
router.get("", getProjects);

// /api/projects/:projectId
router.get("/:projectId", findProject);

// /api/projects/
router.post("", createProjects);

// /api/projects/:projectId
router.put("/:projectId", updateProject);

// /api/projects/:projectId
router.delete("/:projectId", deleteProject);

// /api/projects/:projectId/images
router.get("/:projectId/images", getProjectImages);

// /api/projects/:projectId/images/:imageId
router.post("/:projectId/images/:imageId", uploadImage);

// /api/projects/:projectId/imageFullPath
router.put("/:projectId/imageFullPath", updateProjectImageFullPath);

// /api/projects/:projectId/scans
router.get("/:projectId/scans", getScansByProjectId);

// /api/projects/:projectId/energy
router.post("/:projectId/energy", saveEnergyResult);

// /api/projects/:projectId/energy
router.get("/:projectId/energy", getEnergyResult);

export default router;