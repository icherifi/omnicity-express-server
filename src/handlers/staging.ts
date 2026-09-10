import { createClient } from '@supabase/supabase-js';
import { Request, Response } from 'express';
import dotenv from 'dotenv';
import { Database } from '../types/database.types';
import { runStaging } from '../services/stagingOrchestratorService';
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
  if (!scan.serialized) {
    return res.status(400).json({ error: 'Scan has no serialized room data' });
  }
  if (scan.staging_status === 'processing' || scan.staging_status === 'pending') {
    return res.status(409).json({ error: `Staging already ${scan.staging_status}` });
  }

  // Clear any previous attempt's summary/error — otherwise a client polling mid-run sees
  // "processing" alongside a stale error from the last failed attempt and (reasonably)
  // reads that as the current state.
  await supabase
    .from('scans')
    .update({ staging_status: 'processing', staging_summary: null })
    .eq('id', id);
  res.status(202).json({ message: 'Staging started', staging_status: 'processing' });

  try {
    const serialized: RoomPlanCapturedRoom =
      typeof scan.serialized === 'string'
        ? JSON.parse(scan.serialized)
        : (scan.serialized as unknown as RoomPlanCapturedRoom);

    const { summary, previewBuffer } = await runStaging(serialized);

    // No exported 3D file anymore - the frontend composes the scene live from
    // staging_summary.actions + cached IKEA GLBs. Only the preview render (for
    // display in the "done" UI state) needs to be persisted anywhere.
    const previewPath = `staging/${id}/preview.png`;
    const { error: uploadError } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(previewPath, previewBuffer, { contentType: 'image/png', upsert: true });
    if (uploadError) throw uploadError;

    // Reaching this line means the tool loop and final render both succeeded -
    // summary.errors just lists non-fatal hiccups Claude already worked around
    // along the way (e.g. an IKEA item with no product page, a bad model download).
    // Flagging a successful run as "error" because of those was wrong before - it
    // hid a fully successful run behind an error screen.
    await supabase
      .from('scans')
      .update({
        staging_status: 'done',
        staging_summary: { ...summary, preview_render_path: previewPath } as any,
        staged_at: new Date().toISOString(),
      })
      .eq('id', id);
  } catch (e: any) {
    console.error('Staging failed', e);
    // This write itself can hit the same kind of transient network blip that just
    // failed the run (e.g. a momentary DNS hiccup affecting more than one host) -
    // without its own retry, that leaves the row stuck at "processing" forever,
    // since nothing else will ever mark it as done or failed.
    const markError = () =>
      supabase
        .from('scans')
        .update({
          staging_status: 'error',
          staging_summary: { errors: [e?.message ?? String(e)] } as any,
        })
        .eq('id', id);

    let { error: markErrorFailed } = await markError();
    if (markErrorFailed) {
      console.error('Failed to record staging error, retrying once', markErrorFailed);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      ({ error: markErrorFailed } = await markError());
    }
    if (markErrorFailed) {
      console.error('Giving up recording staging error - scan will stay stuck as "processing"', markErrorFailed);
    }
  }
};

/** GET /api/scans/:id/stage — poll staging progress/result. */
export const getStagingStatus = async (req: Request, res: Response) => {
  const { id } = req.params;

  const { data: scan, error } = await supabase
    .from('scans')
    .select('id, staging_status, staging_summary, staged_at, serialized')
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
