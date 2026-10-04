# Operator backfill105 /107 SQL source review

The migration scanner retains its general SECURITY DEFINER refusal. The cover exception is the exact105 SQL ledger digest
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

The video extension107 has separately reviewed exact ledger digest
`7afd5fa17f62d1827337ef3ee833fa42ec8d750aa622868b5c22a091f9bbdd11`.
Its three additional ports lock the original active organizer/person/community
scope and canonical video consent, then publish only through the exact approved
video job, common intent and ready object/pointer. The binding includes original
state/version/MIME/size/SHA and current source bytes; publication requires the
same approval policy identity, live leases and current domain owner. Historical
organizer read authority permits byte-preserving migration without granting
future upload authority. Dependencies bind in SQL-standard bodies; PUBLIC
execution is revoked and only the trusted migration schema is additionally
pinned for original attachment triggers. The runtime exclusions/readback now
cover seven functions; the exact scanner exception still grants no installation
or deployment authority. The integrated cover/video/runtime-privilege regression is27/27 with zero skipped, including real denial of all seven ports, table/column grants and PUBLIC/inherited access. Release/scanner checks are354/354. These remain local synthetic results.

This source review covers105 and107 only. Historical sources remain retained; cover GC,
all-source backfill, cloud installation and release acceptance are incomplete.


Migration108 adds immutable coverage and a durable common-intent PUT-effect
ledger to the new domain writers and the two operator profiles. It adds no
SECURITY DEFINER routine and receives no new scanner exception. Existing assets
retain coverage=false permanently. Domain deletion remains explicitly disabled
and cannot rely on coverage alone: every possible active/retained writer must
support `media.write-effects.v1`, with old consumers fenced before enabling
`media.domain-gc.v1`. The release diagnostic requires both capabilities and108
in current and historical schema evidence. This is a release prerequisite, not
an installed publisher or proof that an old process was actually stopped.
