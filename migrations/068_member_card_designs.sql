-- Opt-in presentation for an existing share. Defaults keep every current card calm,
-- with no headline and no links, until the owner saves a choice.
ALTER TABLE member_card_shares
  ADD COLUMN design text NOT NULL DEFAULT 'calm' CHECK (design IN ('calm','workshop','night','classic')),
  ADD COLUMN headline text CHECK (headline IS NULL OR char_length(headline) BETWEEN 1 AND 60),
  ADD COLUMN links jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 8);
