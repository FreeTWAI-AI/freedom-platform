-- Native posts can publish with a member-uploaded image in the same command (#387).
-- The creation reservation records 'upload' beside the automatic preview sources;
-- published thumbnail rows already accept source='upload'. No row is rewritten.
ALTER TABLE community_social_thumbnail_asset_targets
  DROP CONSTRAINT community_social_thumbnail_asset_targets_create_source_check;
ALTER TABLE community_social_thumbnail_asset_targets
  ADD CONSTRAINT community_social_thumbnail_asset_targets_create_source_check
  CHECK (create_source IN ('youtube', 'page', 'upload'));
-- Reservation immutability, pointer, writer-floor triggers and runtime grants are unchanged.
