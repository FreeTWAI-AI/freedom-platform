-- Public editorial revisions use current project metadata without changing
-- the original submission payload, consent, or pinned source version.
ALTER TABLE oss_projects ADD COLUMN public_metadata_revised boolean NOT NULL DEFAULT false;
