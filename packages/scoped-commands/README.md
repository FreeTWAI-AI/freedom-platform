# Scoped member commands

This server-only adapter composes the existing neutral command core with current
member principal/resource-scope resolution. Import `scopedMemberCommand`,
`scopedJournal` and their input types from [index.ts](index.ts).

The full [API, lock order, input bounds, schema and local evidence](../db/README.md#additive-scoped-member-commands)
remain documented alongside the legacy command compatibility boundary. The
separate module depends on `command-core` and `resource-scopes`; neither dependency
imports this adapter. Do not move it back under command-core ownership or add a
reverse descriptor dependency that creates a governance module cycle.

The adapter accepts only current member sessions. It has no HTTP route, machine
credentials, external I/O, publication/fanout or implicit target ACL. Migration
[078](../../migrations/078_scoped_member_commands.sql) is additive; the separate
scoped journal/outbox never writes legacy community events. Domain callbacks must
authorize the actual target and supply only bounded, explicit metadata.
