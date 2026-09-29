import { Request, Response } from "express";
import * as ikeaService from "../services/ikeaService";

/** GET /api/ikea/search?q= */
export const search = async (req: Request, res: Response) => {
  const query = req.query.q;
  if (typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: "Missing q query param" });
  }
  try {
    const results = await ikeaService.search(query);
    res.status(200).json(results);
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? String(e) });
  }
};

/** GET /api/ikea/product/:itemNo */
export const getProduct = async (req: Request, res: Response) => {
  try {
    const product = await ikeaService.getProduct(req.params.itemNo);
    res.status(200).json(product);
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? String(e) });
  }
};

/**
 * GET /api/ikea/model/:itemNo — streams the cached/downloaded GLB. Unauthenticated
 * on purpose: this is a read-only proxy to IKEA's own public catalog (not user
 * data), and drei's useGLTF(url) has no easy way to attach a Bearer header.
 */
export const getModel = async (req: Request, res: Response) => {
  try {
    const path = await ikeaService.getModel(req.params.itemNo);
    res.setHeader("Content-Type", "model/gltf-binary");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(path);
  } catch (e: any) {
    res.status(502).json({ error: e?.message ?? String(e) });
  }
};
