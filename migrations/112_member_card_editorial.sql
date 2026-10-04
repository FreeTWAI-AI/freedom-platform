-- Preserve existing choices; make the new brand template the default for new cards.
ALTER TABLE member_card_shares DROP CONSTRAINT member_card_shares_design_check;
ALTER TABLE member_card_shares ADD CONSTRAINT member_card_shares_design_check
  CHECK (design IN ('editorial','calm','workshop','night','classic'));
ALTER TABLE member_card_shares ALTER COLUMN design SET DEFAULT 'editorial';
