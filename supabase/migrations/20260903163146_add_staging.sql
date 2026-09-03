-- Virtual staging: automated furniture placement/replacement run by Claude against a
-- headless Blender instance. Furniture comes live from IKEA's catalog via the Blender
-- bridge (see blender-bridge/ikea_lib.py) — no local furniture catalog table needed.

alter table public.scans
  add column staged_usdz_path text,
  add column staging_status text not null default 'none',
  add column staging_summary jsonb,
  add column staged_at timestamptz;

comment on column public.scans.staged_usdz_path is
  'Storage path (in the "documents" bucket, same convention as usdz_path) of the USDZ produced by the automated staging pipeline.';
comment on column public.scans.staging_status is
  'One of: none, pending, processing, done, error.';
comment on column public.scans.staging_summary is
  'JSON summary of the staging run: furniture placed/replaced (by IKEA item number), wall/floor colors chosen, and any tool errors.';
