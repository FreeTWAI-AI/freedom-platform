# Member accounts, privacy and small teams

These APIs extend the current server; they are not yet in the pinned preview SDK.
Requests use the existing session cookie and same-origin JSON. All authenticated
POSTs require CSRF and Idempotency-Key; updates to an existing version require
`If-Match: "<aggregate_version>"`. Authentication/register is the exception and
uses persisted rate limits instead. IDs are UUIDs.

- `GET /api/v1/site`: brand, registration_enabled, demo_accounts_enabled, community.
- `POST /auth/register`: `{email,password,nickname,contacts?}`. Password 12–128
  characters, nickname 1–60. Returns the existing session JSON and cookie (201).
  Contacts are optional fields `discord`, `github`, `line`, `email`, each
  `{value,visibility}`. Visibility defaults private. Login email is copied to
  contact email privately on registration, but thereafter the two are separate.
- `POST /auth/login`: existing `{email,password}`. Email remains **unverified**;
  there is no mail sender/reset/automatic provider linking. Slugs confer no
  GitHub/Discord/LINE ownership or privileged action.
- `GET /me/account`: `{user_id,nickname,login_email,email_verified,contacts,
  aggregate_version}`. Each contact additionally has `verified:false`.
- `POST /me/account`: `{nickname,contacts}` (all four contact entries, **without**
  `verified`); returns current account, never another member's private settings.
- `GET /members?limit=20&offset=0`: `{items,next_offset}`. Limit 1–50. Each card:
  `{user_id,nickname,positioning_title,primary_guild,secondary_guilds,capabilities,
  equipment,contacts,is_self,friendship}`. Only visible nonempty contact values
  are present in `contacts` (a string map), not concealed values or settings.
- `GET /members/:id`: same card; inactive, incomplete and other-community users
  return 404. No authenticated access to people until onboarding is complete.
- `GET /friends`: `{items:[{user_id,nickname,state,requester_ref,aggregate_version}]}`.
- `POST /friends/:id/request|accept|remove`: `{}`. First request needs no version;
  accept/remove and renewed removed friendship need current version. Only the
  recipient can accept. Pending requests grant **no** contact access. Remove
  revokes access immediately. Repeat requests do not accept another's invitation.
- `GET /squads?limit=20&offset=0`: `{items,next_offset,kinds}`. Items include
  `squad_id,name,kind,purpose,owner_ref,owner_name,member_count,membership`.
  Membership is null or `{state,aggregate_version}` for the current user.
- `POST /squads`: `{name,kind,purpose}`. `kind=project|mutual_help` (專案小隊／共同
  目標互助小隊; provisional labels). Creator becomes its first active member.
- `GET /squads/:id`: squad plus `members` with `user_id,nickname,state,
  aggregate_version`. Pending members visible only to themselves and owner.
- `POST /squads/:id/request`: `{}` requests admission; no immediate group access.
- `POST /squads/:id/members/:userId/accept`: owner accepts an existing pending
  request with that membership's version. Cannot add an unconsenting member.
- `POST /squads/:id/leave`: member leaves with current membership version, revoking
  squad-scoped contact access. Owner transfer/deletion is not implemented; owner
  cannot leave. No three-person minimum or commercial eligibility is implied.

Contact visibility: `public|private|friends|squad|guild`. Public means all signed-in
members of the same community through this directory. There is no anonymous
people endpoint yet. Friends requires an accepted mutual friendship; squad and
guild require both members to have a currently active membership in the same
community. Every read rechecks relationships; contact values and audience predicates use one PostgreSQL statement snapshot, preventing a revoked relationship from being combined with newly changed contacts. Nothing exposes login email,
password hashes, private assessment answers or equipment secrets.

New accounts have a server-enforced onboarding gate. Only session/logout,
account settings, assessment definition/answers/evaluation/completion, current
guild catalog/join/leave/primary and own skill-books are available until completed.
Legacy demo accounts preserve prior behavior. Public deployments must use a new
DB with no demo seed and explicitly set `FREEDOM_REGISTRATION_COMMUNITY_ID`.
Public registration rejects the reserved `@local.test` demo domain so a public signup cannot trigger the startup demo-account guard. No password reset endpoint exists until a recovery mechanism is configured; a user-entered email or social slug is never sufficient proof for an administrator to reset credentials.
`FREEDOM_TRUST_CF=true` trusts CF-Connecting-IP **only** from a loopback socket;
root must bind the listener to loopback behind Tunnel. Other clients use their
real socket IP; in-process requests share one budget. Registration caps are 8 per
network / 15 min, 3 per email / 15 min and 100 global / min; login 60 per network /
15 min, 240 global / min plus 10 failures per account / 15 min. PostgreSQL persists
these limits across worker restarts. Password hashing uses async scrypt.
