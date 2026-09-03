alter table public.scans
  add column usdz_path text;

comment on column public.scans.usdz_path is
  'Storage path of the exported USDZ 3D model in the "documents" bucket (e.g. plans-<project_id>/scan-<uuid>.usdz). Set by the OmniScan iOS app at scan creation, using the same identifier as the uploaded file so the row and the object stay paired.';
