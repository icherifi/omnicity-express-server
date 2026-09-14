import { Request, Response } from "express";
import * as localModelService from "../services/localModelService";

/**
 * GET /api/local-models/model/:modelId — streams the cached/downloaded GLB for
 * a non-IKEA model (see localModelService.ts). Mirrors src/handlers/ikea.ts's
 * getModel exactly, including staying unauthenticated: drei's useGLTF(url) has
 * no easy way to attach a Bearer header, and this only ever serves the small,
 * fixed catalog of models this app itself onboarded - not arbitrary user data.
 */
export const getModel = async (req: Request, res: Response) => {
  try {
    const filePath = await localModelService.getModel(req.params.modelId);
    res.setHeader("Content-Type", "model/gltf-binary");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(filePath);
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? String(e) });
  }
};
