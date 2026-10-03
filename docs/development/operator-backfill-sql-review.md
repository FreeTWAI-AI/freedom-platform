# Operator backfill105 SQL source review

The migration scanner retains its general SECURITY DEFINER refusal. Its only
exception is the exact105 SQL ledger digest
`e27f74e859485c264cadfd48d5841f0a35e32df3e47e53d115c260a49370814e`
(SHA-256 over JSON.stringify(SQL), the canonical migration-ledger algorithm).
Changed bytes, unlisted migrations and all other privileged statement categories
remain rejected. The diagnostic reports this exception separately as
`reviewed_privileged`; it grants no migration, operator, recovery or deployment
authority.

The four finite routines lock the approved plan, original cover owner, storage
consent and publication. SQL-standard bodies bind source tables at creation;
search_path is pg_catalog, with only the trusted migration schema additionally
pinned for publication because original cover triggers use unqualified names.
There is no caller SQL, schema, routine name or dynamic authority input.
PUBLIC execution is revoked. Dedicated operator installation rejects elevated
roles, role memberships, schema CREATE and inherited/PUBLIC authority writes.
The application's broad legacy table/column/function/sequence grants are
removed by20-runtime-grants, and30-readonly verification exposes unsafe rights.
Run these grants/readbacks after migration or restore before starting consumers.

Approval defaults false, binds session_user, actual database and the physical
policy-table schema, and expires on the database clock. The publication port
requires the exact approved job policy/plan/fence/token, common intent, genuine
owner/personal scope, current source version/size/SHA/binding, canonical consent
and typed ready pointer. The installed host performs actual immutable-object
readback outside SQL locks. After all writes and deferred constraints, it checks
approval/job/intent clocks before commit. SQL alone cannot verify R2 bytes;
dedicated operator credentials belong only to the approved installed host.

Root independently reviewed the source and ran the19-case integrated operator /
runtime-privilege / domain-policy suites. The four app-role cases create the
migration with a non-superuser owner, show that old broad grants permit a real
approval INSERT, then prove the exclusions deny all four tables, four routines
and audit sequence. PUBLIC and inherited rights cause the installer to fail.
The author's11 operator cases use a dedicated non-superuser LOGIN and native
local R2; a genuine final-audit SQL lock crossing lease expiry rolls back all
publication metadata. These are local synthetic proofs, not remote provider
compatibility or formal security/publisher acceptance.

This review covers105 only. Historical sources remain retained; cover GC,
all-source backfill, cloud installation and release acceptance are incomplete.
