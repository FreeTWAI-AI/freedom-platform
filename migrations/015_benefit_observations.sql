-- Optional first-person observations. These are not acceptance, QC, income or
-- independently verified mutual-benefit facts. Revisions append new records.
CREATE TABLE work_benefit_observations (
  observation_id uuid PRIMARY KEY,
  community_id uuid NOT NULL REFERENCES communities,
  work_item_ref uuid NOT NULL REFERENCES work_items,
  reporter_principal_ref uuid NOT NULL REFERENCES users,
  work_claim_ref uuid REFERENCES work_claims,
  role text NOT NULL CHECK(role IN ('beneficiary','contributor')),
  observation_revision integer NOT NULL CHECK(observation_revision>0),
  supersedes_observation_ref uuid REFERENCES work_benefit_observations,
  report jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK((role='beneficiary' AND work_claim_ref IS NULL) OR (role='contributor' AND work_claim_ref IS NOT NULL))
);
CREATE UNIQUE INDEX work_benefit_lineage_revision ON work_benefit_observations
  (community_id,work_item_ref,reporter_principal_ref,role,COALESCE(work_claim_ref,'00000000-0000-0000-0000-000000000000'::uuid),observation_revision);
CREATE INDEX work_benefit_by_work ON work_benefit_observations(community_id,work_item_ref,recorded_at);
