-- An asset label does not permit new SQL media bytes after the R2-only cutover.
-- Bridge retains historical bytes until the separately verified retirement.
CREATE OR REPLACE FUNCTION fence_social_thumbnail_writer()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mode_value text;
BEGIN
 SELECT mode INTO STRICT mode_value
 FROM domain_media_storage_policy
 WHERE purpose='community.social-thumbnail' FOR SHARE;
 IF (NEW.storage_source='asset' AND mode_value='legacy')
    OR (mode_value='r2_only' AND
        (NEW.storage_source='legacy' OR NEW.image_bytes IS NOT NULL)) THEN
  RAISE EXCEPTION 'Thumbnail writer violates the storage floor' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.storage_source='asset'
    AND (NEW.storage_source<>'asset' OR NEW.image_bytes IS DISTINCT FROM OLD.image_bytes) THEN
  RAISE EXCEPTION 'Legacy thumbnail writer is fenced' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
