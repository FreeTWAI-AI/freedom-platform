-- Login email is the single authoritative email. Only its audience is stored
-- here; changing contact settings must never change authentication identity.
-- When an old independently editable email differed from login email, clear
-- its audience so migration cannot disclose a newly substituted address.
WITH fields AS (
  SELECT a.user_id,u.email,k.key,COALESCE(a.contacts->k.key,'{}'::jsonb) AS field
  FROM member_accounts a JOIN users u USING(user_id)
  CROSS JOIN (VALUES('discord'),('github'),('line'),('email')) k(key)
), audience_input AS (
  SELECT *,CASE
    WHEN key='email' AND field ? 'value' AND lower(COALESCE(field->>'value',''))<>lower(email) THEN '[]'::jsonb
    WHEN jsonb_typeof(field->'audiences')='array' THEN field->'audiences'
    WHEN field->>'visibility' IN ('public','friends','squad','guild') THEN jsonb_build_array(field->>'visibility')
    ELSE '[]'::jsonb END AS candidates
  FROM fields
), normalized AS (
  SELECT user_id,key,CASE WHEN key='email' THEN '{}'::jsonb
    ELSE jsonb_build_object('value',CASE WHEN jsonb_typeof(field->'value')='string' THEN field->>'value' ELSE '' END) END
    ||jsonb_build_object('audiences',CASE WHEN candidates ? 'public' THEN '["public"]'::jsonb ELSE
      COALESCE((SELECT jsonb_agg(audience ORDER BY audience) FROM (
        SELECT DISTINCT item AS audience FROM jsonb_array_elements_text(candidates) item
        WHERE item IN ('friends','squad','guild')
      ) known),'[]'::jsonb) END) AS field
  FROM audience_input
), rebuilt AS (
  SELECT user_id,jsonb_object_agg(key,field) AS contacts FROM normalized GROUP BY user_id
)
UPDATE member_accounts a SET contacts=r.contacts,aggregate_version=a.aggregate_version+1
FROM rebuilt r WHERE a.user_id=r.user_id AND a.contacts IS DISTINCT FROM r.contacts;

ALTER TABLE member_accounts ALTER COLUMN contacts SET DEFAULT
  '{"discord":{"value":"","audiences":[]},"github":{"value":"","audiences":[]},"line":{"value":"","audiences":[]},"email":{"audiences":[]}}';
