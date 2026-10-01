-- Existing shares were enabled before contacts could appear on a card, so they stay off
-- until the owner turns this on; new cards default to on.
-- No column GRANT: default privileges cover columns added to an existing table (same as 059, 068).
ALTER TABLE member_card_shares
  ADD COLUMN show_profile_links boolean NOT NULL DEFAULT false,
  ADD COLUMN profile_link_prefs jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(profile_link_prefs) = 'object');
ALTER TABLE member_card_shares ALTER COLUMN show_profile_links SET DEFAULT true;
