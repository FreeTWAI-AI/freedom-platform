-- Keep existing answers and confirmed profile snapshots. NULL featured choices
-- identify legacy rows whose compact card falls back to the first three skills.
ALTER TABLE onboarding_assessments
  ADD COLUMN custom_capabilities text[] NOT NULL DEFAULT '{}',
  ADD COLUMN custom_equipment text[] NOT NULL DEFAULT '{}',
  ADD COLUMN featured_capabilities text[],
  ADD COLUMN question_notes jsonb NOT NULL DEFAULT '{}',
  ADD CONSTRAINT onboarding_custom_capabilities_limit CHECK(cardinality(custom_capabilities)<=10),
  ADD CONSTRAINT onboarding_custom_equipment_limit CHECK(cardinality(custom_equipment)<=10),
  ADD CONSTRAINT onboarding_featured_capabilities_limit CHECK(featured_capabilities IS NULL OR cardinality(featured_capabilities)<=3),
  ADD CONSTRAINT onboarding_question_notes_object CHECK(jsonb_typeof(question_notes)='object');
