-- The 34 transferred repositories keep their GitHub IDs. Rewrite live coordinates
-- only. Applied SQL, claims/audit snapshots, receipts, credential AAD and pins are
-- immutable and are deliberately not rewritten.
-- The migration runner owns one transaction. Block writers while reparenting the
-- sync store so a concurrent old/new sync cannot insert between copy and delete.
LOCK TABLE github_sync_repositories, github_items, github_repository_metrics,
  skill_star_support, canonical_repositories, catalog_repo_observations,
  development_grants, maintainer_repositories, github_repository_events, oss_projects
  IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE freetwai_transfer (
  old_name text PRIMARY KEY, new_name text NOT NULL, github_id text NOT NULL UNIQUE
) ON COMMIT DROP;
INSERT INTO freetwai_transfer VALUES
  ('ai-media-generator', 'ai-media-generator', '1382968207'),
  ('ai-security-scanner', 'ai-security-scanner', '1382968296'),
  ('ai-short-drama', 'ai-short-drama', '1382968134'),
  ('AI-Sister', 'AI-Sister', '1382968338'),
  ('claude-skill-social-post', 'claude-skill-social-post', '1382967983'),
  ('freedom-agent-kit', 'freedom-agent-kit', '1378081390'),
  ('freedom-browser', 'freedom-browser', '1407511465'),
  ('freedom-browser-extension', 'freedom-browser-extension', '1407511348'),
  ('freedom-growth-automation', 'freedom-growth-automation', '1378081485'),
  ('freedom-platform', 'freedom-platform', '1378081342'),
  ('freedom-project-page', 'freedom-project-page', '1378081649'),
  ('freedom-project-template', 'freedom-project-template', '1378081612'),
  ('freedom-skill-career-guide', 'freedom-skill-career-guide', '1382981631'),
  ('freedom-skill-commercial-production', 'freedom-skill-commercial-production', '1383056436'),
  ('freedom-skill-community-ops', 'freedom-skill-community-ops', '1382981712'),
  ('freedom-skill-event-space', 'freedom-skill-event-space', '1383704144'),
  ('freedom-skill-human-design', 'freedom-skill-human-design', '1383704402'),
  ('freedom-skill-music-mv', 'freedom-skill-music-mv', '1383056329'),
  ('freedom-skill-partnership', 'freedom-skill-partnership', '1382981896'),
  ('freedom-skill-project-delivery', 'freedom-skill-project-delivery', '1382982206'),
  ('freedom-skill-projection-mapping', 'freedom-skill-projection-mapping', '1383704279'),
  ('freedom-skill-reconciliation', 'freedom-skill-reconciliation', '1382982092'),
  ('freedom-skill-registry', 'freedom-skill-registry', '1378081523'),
  ('freedom-storefront', 'freedom-storefront', '1378081447'),
  ('freedom-supplier-client', 'freedom-supplier-client', '1382994244'),
  ('FreeTWAI-AI.github.io', 'FreeTWAI.github.io', '1378081698'),
  ('.github', '.github', '1378081556'),
  ('Hao0321-Studio-WEB', 'Hao0321-Studio-WEB', '1382968172'),
  ('maintainer-sandbox', 'maintainer-sandbox', '1400257812'),
  ('multi-ai-chat', 'multi-ai-chat', '1382968424'),
  ('multi-ai-chat-desktop', 'multi-ai-chat-desktop', '1382968388'),
  ('pos-pro', 'pos-pro', '1382968255'),
  ('typo-studio', 'typo-studio', '1382968035'),
  ('video-autopilot-kit', 'video-autopilot-kit', '1382968090');

-- Union issue/PR history by repository + number. The newer provider update wins;
-- equal provider timestamps use synced_at, with an exact tie keeping the new key.
-- Restart full backfill: cursors/ETags are URL-dependent and may be incomplete on
-- either side of a key collision. Existing history remains available throughout.
INSERT INTO github_sync_repositories(repository_key, repository, next_sync_at, last_synced_at, last_error)
SELECT 'freetwai/' || lower(t.new_name), 'FreeTWAI/' || t.new_name, now(),
  r.last_synced_at, NULLIF(r.last_error,'github_moved')
FROM github_sync_repositories r JOIN freetwai_transfer t
  ON r.repository_key = 'freetwai-ai/' || lower(t.old_name)
ON CONFLICT (repository_key) DO NOTHING;
INSERT INTO github_items(repository_key, number, kind, title, author_login, state,
  state_reason, merged_at, created_at, updated_at, closed_at, synced_at,
  labels, assignees, page_ids, body_excerpt)
SELECT 'freetwai/' || lower(t.new_name), i.number, i.kind, i.title, i.author_login,
  i.state, i.state_reason, i.merged_at, i.created_at, i.updated_at, i.closed_at,
  i.synced_at, i.labels, i.assignees, i.page_ids, i.body_excerpt
FROM github_items i JOIN freetwai_transfer t
  ON i.repository_key = 'freetwai-ai/' || lower(t.old_name)
ON CONFLICT (repository_key, number) DO UPDATE SET
  kind=EXCLUDED.kind, title=EXCLUDED.title, author_login=EXCLUDED.author_login,
  state=EXCLUDED.state, state_reason=EXCLUDED.state_reason,
  merged_at=EXCLUDED.merged_at, created_at=EXCLUDED.created_at,
  updated_at=EXCLUDED.updated_at, closed_at=EXCLUDED.closed_at,
  synced_at=EXCLUDED.synced_at, labels=EXCLUDED.labels,
  assignees=EXCLUDED.assignees, page_ids=EXCLUDED.page_ids,
  body_excerpt=EXCLUDED.body_excerpt
WHERE (EXCLUDED.updated_at, EXCLUDED.synced_at) > (github_items.updated_at, github_items.synced_at);
UPDATE github_sync_repositories r SET since=NULL, etag=NULL, etag_query=NULL,
  backfilled=false, access_status='pending', next_sync_at=now(),
  last_synced_at=GREATEST(r.last_synced_at, (SELECT old.last_synced_at
    FROM github_sync_repositories old WHERE old.repository_key='freetwai-ai/' || lower(t.old_name))),
  last_error=CASE WHEN r.last_error='github_moved' THEN NULL ELSE r.last_error END
FROM freetwai_transfer t
WHERE r.repository_key='freetwai/' || lower(t.new_name)
  AND EXISTS (SELECT 1 FROM github_sync_repositories old
    WHERE old.repository_key='freetwai-ai/' || lower(t.old_name));
DELETE FROM github_items i USING freetwai_transfer t
WHERE i.repository_key='freetwai-ai/' || lower(t.old_name);
DELETE FROM github_sync_repositories r USING freetwai_transfer t
WHERE r.repository_key='freetwai-ai/' || lower(t.old_name);

-- Metrics are a replaceable snapshot, never an append-only history. Preserve the
-- latest valid snapshot (prefer non-NULL; exact timestamp ties keep new-key data).
INSERT INTO github_repository_metrics(repository_key,snapshot,checked_at,retry_after,last_error)
SELECT 'freetwai/' || lower(t.new_name), r.snapshot,r.checked_at,r.retry_after,r.last_error
FROM github_repository_metrics r JOIN freetwai_transfer t
  ON r.repository_key='freetwai-ai/' || lower(t.old_name)
ON CONFLICT (repository_key) DO UPDATE SET snapshot=EXCLUDED.snapshot,
  checked_at=EXCLUDED.checked_at,retry_after=EXCLUDED.retry_after,last_error=EXCLUDED.last_error
WHERE (github_repository_metrics.snapshot IS NULL AND EXCLUDED.snapshot IS NOT NULL)
  OR ((github_repository_metrics.snapshot IS NULL)=(EXCLUDED.snapshot IS NULL)
    AND COALESCE(EXCLUDED.checked_at,'-infinity'::timestamptz)
      > COALESCE(github_repository_metrics.checked_at,'-infinity'::timestamptz));
DELETE FROM github_repository_metrics r USING freetwai_transfer t
WHERE r.repository_key='freetwai-ai/' || lower(t.old_name);

-- Star support is one member/repo fact, not two counts after a transfer. Retain
-- earliest confirmation and latest active/inactive observation; new key wins ties.
INSERT INTO skill_star_support(github_user_id,repository_key,first_confirmed_at,active,last_confirmed_at)
SELECT s.github_user_id,'freetwai/' || lower(t.new_name),s.first_confirmed_at,s.active,s.last_confirmed_at
FROM skill_star_support s JOIN freetwai_transfer t
  ON s.repository_key='freetwai-ai/' || lower(t.old_name)
ON CONFLICT (github_user_id,repository_key) DO UPDATE SET
  first_confirmed_at=LEAST(skill_star_support.first_confirmed_at,EXCLUDED.first_confirmed_at),
  active=CASE WHEN EXCLUDED.last_confirmed_at>skill_star_support.last_confirmed_at
    THEN EXCLUDED.active ELSE skill_star_support.active END,
  last_confirmed_at=GREATEST(skill_star_support.last_confirmed_at,EXCLUDED.last_confirmed_at);
DELETE FROM skill_star_support s USING freetwai_transfer t
WHERE s.repository_key='freetwai-ai/' || lower(t.old_name);

-- ID-bound observations/grants retain authority, expiry, revocation and attribution.
-- A reused old name with a different GitHub ID is never migrated or acknowledged.
UPDATE canonical_repositories r SET full_name='FreeTWAI/' || t.new_name,
  current_url='https://github.com/FreeTWAI/' || t.new_name
FROM freetwai_transfer t WHERE r.provider='github' AND r.provider_repo_id=t.github_id
  AND lower(r.full_name)='freetwai-ai/' || lower(t.old_name);
UPDATE canonical_repositories r SET source_full_name='FreeTWAI/' || t.new_name
FROM freetwai_transfer t WHERE r.source_repo_id=t.github_id
  AND lower(r.source_full_name)='freetwai-ai/' || lower(t.old_name);
UPDATE catalog_repo_observations r SET requested_full_name='FreeTWAI/' || t.new_name
FROM freetwai_transfer t WHERE r.provider='github' AND r.provider_repo_id=t.github_id
  AND lower(r.requested_full_name)='freetwai-ai/' || lower(t.old_name);
UPDATE catalog_repo_observations r SET full_name='FreeTWAI/' || t.new_name,
  current_url='https://github.com/FreeTWAI/' || t.new_name
FROM freetwai_transfer t WHERE r.provider='github' AND r.provider_repo_id=t.github_id
  AND lower(r.full_name)='freetwai-ai/' || lower(t.old_name);
UPDATE development_grants r SET target_repository='FreeTWAI/' || t.new_name
FROM freetwai_transfer t WHERE r.target_repository_id=t.github_id
  AND lower(r.target_repository)='freetwai-ai/' || lower(t.old_name);
UPDATE development_grants r SET working_repository='FreeTWAI/' || t.new_name
FROM freetwai_transfer t WHERE r.working_repository_id=t.github_id
  AND lower(r.working_repository)='freetwai-ai/' || lower(t.old_name);
UPDATE maintainer_repositories r SET full_name='FreeTWAI/' || t.new_name
FROM freetwai_transfer t WHERE r.github_repository_id=t.github_id
  AND lower(r.full_name)='freetwai-ai/' || lower(t.old_name);
-- Current registered-project links are live coordinates. Version observations
-- and campaign source snapshots retain their original URLs and content hashes.
UPDATE oss_projects r SET repository_full_name='FreeTWAI/' || t.new_name,
  repository_url='https://github.com/FreeTWAI/' || t.new_name
FROM freetwai_transfer t WHERE r.repository_id=t.github_id
  AND lower(r.repository_full_name)='freetwai-ai/' || lower(t.old_name);
-- Public event feed is a mutable projection, not an audit journal.
UPDATE github_repository_events SET url=regexp_replace(url,
  '^https://github\.com/FreeTWAI-AI/freedom-platform/',
  'https://github.com/FreeTWAI/freedom-platform/')
WHERE url ~ '^https://github\.com/FreeTWAI-AI/freedom-platform/';
