import { beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";

let app: express.Express;

beforeAll(async () => {
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  const { default: router } = await import("../src/routes");
  app = express();
  app.use(express.json());
  app.use("/api", router);
});

describe("anonymous access", () => {
  it("health check is public", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
  });

  it.each([
    ["GET", "/api/projects"],
    ["GET", "/api/projects/11111111-1111-1111-1111-111111111111"],
    ["PUT", "/api/projects/11111111-1111-1111-1111-111111111111"],
    ["DELETE", "/api/projects/11111111-1111-1111-1111-111111111111"],
    ["GET", "/api/projects/11111111-1111-1111-1111-111111111111/scans"],
    ["POST", "/api/scans"],
    ["GET", "/api/scans/project/11111111-1111-1111-1111-111111111111"],
    ["POST", "/api/scans/1/stage"],
    ["GET", "/api/scans/1/stage"],
    ["POST", "/api/dpe/save-form"],
    ["POST", "/api/energy/choice"],
    ["GET", "/api/energy/form/session"],
    ["GET", "/api/rge/search"],
    ["GET", "/api/me"],
  ])("%s %s requires a token", async (method, path) => {
    const res = await (request(app) as any)[method.toLowerCase()](path);
    expect(res.status).toBe(401);
  });

  it("no longer exposes every scan or every user id", async () => {
    expect((await request(app).get("/api/scans")).status).toBe(401);
    expect((await request(app).get("/api/uuid")).status).toBe(404);
  });
});

describe("public catalog proxies validate ids", () => {
  it("rejects path traversal in local model ids", async () => {
    const res = await request(app).get("/api/local-models/model/..%2F..%2Fsecret");
    expect(res.status).toBe(400);
  });

  it("rejects path traversal in ikea item numbers", async () => {
    const res = await request(app).get("/api/ikea/model/..%2F..%2Fsecret");
    expect(res.status).toBe(400);
  });
});
