-- Optional member-supplied link, displayed only: never fetched or embedded.
-- Opaque artifact refs stay intact for existing integrations and work records.
ALTER TABLE showcases ADD COLUMN public_url text CHECK (public_url IS NULL OR char_length(public_url) BETWEEN 1 AND 2000);
