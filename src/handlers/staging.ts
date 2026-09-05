import { createClient } from '@supabase/supabase-js';
import { Request, Response } from 'express';
import dotenv from 'dotenv';
import { Database } from '../types/database.types';
import { runStaging } from '../services/stagingOrchestratorService';
import { downloadBridgeFile } from '../services/blenderBridgeService';
import { RoomPlanCapturedRoom } from '../types/staging.types';

dotenv.config();
const supabaseUrl = process.env.SUPABASE_URL;
// documents is a private bucket (RLS blocks anon reads) - this handler runs as a
// trusted background job with no per-user scoping, so service_role is correct here,
// not the anon key the rest of the codebase uses for user-facing requests.
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}
const supabase = createClient<Database>(supabaseUrl, supabaseKey);

const DOCUMENTS_BUCKET = 'documents';

async function signedUsdzUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}

/** POST /api/scans/:id/stage — kicks off automated staging in the background and returns immediately. */
export const startStaging = async (req: Request, res: Response) => {
  const { id } = req.params;

  const { data: scan, error } = await supabase
    .from('scans')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ details: error });
  }
  if (!scan) {
    return res.status(404).json({ error: 'Scan not found' });
  }
  if (!scan.usdz_path) {
    return res.status(400).json({ error: 'Scan has no usdz_path' });
  }
  if (scan.staging_status === 'processing' || scan.staging_status === 'pending') {
    return res.status(409).json({ error: `Staging already ${scan.staging_status}` });
  }

  await supabase.from('scans').update({ staging_status: 'processing' }).eq('id', id);
  res.status(202).json({ message: 'Staging started', staging_status: 'processing' });

  try {
    const serialized: RoomPlanCapturedRoom | undefined = scan.serialized
      ? ((typeof scan.serialized === 'string' ? JSON.parse(scan.serialized) : scan.serialized) as RoomPlanCapturedRoom)
      : undefined;

    const { summary, exportFileUrl, previewFileUrl } = await runStaging(await signedUsdzUrl(scan.usdz_path), serialized);

    const staged = await downloadBridgeFile(exportFileUrl);
    const stagedPath = `staging/${id}/staged.usdz`;
    const { error: uploadError } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(stagedPath, staged.buffer, { contentType: staged.contentType, upsert: true });
    if (uploadError) throw uploadError;

    const preview = await downloadBridgeFile(previewFileUrl);
    const previewPath = `staging/${id}/preview.png`;
    await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(previewPath, preview.buffer, { contentType: preview.contentType, upsert: true });

    await supabase
      .from('scans')
      .update({
        staging_status: summary.errors.length > 0 ? 'error' : 'done',
        staged_usdz_path: stagedPath,
        staging_summary: { ...summary, preview_render_path: previewPath } as any,
        staged_at: new Date().toISOString(),
      })
      .eq('id', id);
  } catch (e: any) {
    console.error('Staging failed', e);
    await supabase
      .from('scans')
      .update({
        staging_status: 'error',
        staging_summary: { errors: [e?.message ?? String(e)] } as any,
      })
      .eq('id', id);
  }
};

/** GET /api/scans/:id/stage — poll staging progress/result. */
export const getStagingStatus = async (req: Request, res: Response) => {
  const { id } = req.params;

  const { data: scan, error } = await supabase
    .from('scans')
    .select('id, staging_status, staged_usdz_path, staging_summary, staged_at')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ details: error });
  }
  if (!scan) {
    return res.status(404).json({ error: 'Scan not found' });
  }

  res.status(200).json(scan);
};
