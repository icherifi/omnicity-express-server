/**
 * Phase 4 real end-to-end check: triggers a real staging run through the actual
 * POST /api/scans/:id/stage endpoint (not calling runStaging() directly), polls
 * GET until done/error, same as the real frontend would. First phase with real
 * Claude API cost - everything else was already proven by Phases 1-3.
 *
 * Run: npx ts-node scripts/verify-staging-e2e.ts
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const API_BASE = "http://localhost:6300";
const SCAN_ID = 6508;

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: "omnicity.adm@gmail.com",
    password: "OMnicity@06#",
  });
  if (authError || !authData.session) throw new Error(`Auth failed: ${authError?.message}`);
  const token = authData.session.access_token;
  console.log("authenticated");

  const startResp = await fetch(`${API_BASE}/api/scans/${SCAN_ID}/stage`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log("start status:", startResp.status, await startResp.json().catch(() => null));
  if (startResp.status !== 202 && startResp.status !== 409) {
    throw new Error(`Unexpected start status ${startResp.status}`);
  }

  const start = Date.now();
  const TIMEOUT_MS = 10 * 60 * 1000;
  while (Date.now() - start < TIMEOUT_MS) {
    const pollResp = await fetch(`${API_BASE}/api/scans/${SCAN_ID}/stage`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const scan = await pollResp.json();
    console.log(`[${Math.round((Date.now() - start) / 1000)}s] status=${scan.staging_status}`);

    if (scan.staging_status === "done" || scan.staging_status === "error") {
      console.log("\n=== FINAL RESULT ===");
      console.log(JSON.stringify(scan, null, 2).slice(0, 4000));
      process.exit(scan.staging_status === "done" ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.error("TIMEOUT waiting for staging to complete");
  process.exit(1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
