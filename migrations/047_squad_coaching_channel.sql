ALTER TABLE member_squads DROP CONSTRAINT member_squads_kind_check;
ALTER TABLE member_squads ADD CONSTRAINT member_squads_kind_check CHECK (kind IN ('project','mutual_help','coaching'));
ALTER TABLE member_squads ADD COLUMN communication_channel_name text NOT NULL DEFAULT ''
  CHECK (length(communication_channel_name) <= 100);
