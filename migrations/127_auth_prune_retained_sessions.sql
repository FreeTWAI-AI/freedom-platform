-- Row security hides some references from context-free scheduled pruning.
-- Record sessions the foreign key still protects so they do not fill every batch.
ALTER TABLE sessions ADD COLUMN prune_retained_at timestamptz;

-- Plain indexes support FK checks, including consumed verification rows.
CREATE INDEX tenant_high_risk_verifications_prune_session ON tenant_high_risk_verifications (session_hash);
CREATE INDEX model_broker_authorizations_prune_session ON model_broker_authorizations (original_session_hash);
CREATE INDEX credential_ingest_authorizations_prune_session ON credential_ingest_authorizations (original_session_hash);
