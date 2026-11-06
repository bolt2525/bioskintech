-- CLINICAL database migration, separate from the auth/accounting ledger.
-- Prepared only. Apply deliberately with the existing clinical migration role.
-- No images, proposals pending review, or changes to face_map_data/body_map_data.
BEGIN;
ALTER TABLE public.physical_exams
  ADD COLUMN IF NOT EXISTS skin_visual_review JSONB;
COMMIT;
