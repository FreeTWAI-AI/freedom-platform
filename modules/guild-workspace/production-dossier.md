# 製作專案企劃與版本工作台 v0

`production-dossier.ts` defines the `freedom.production-dossier/v1` content profile.
One existing tenant `work_id` is the project identity. Work title, objective and progress
stay in Work; the typed brief, specifications, shots, material references, delivery
records and feedback are one immutable UTF-8 Markdown Result snapshot. The existing
tenant-work HTTP contract, module pins, quotas, grants and 262144-byte limit are unchanged.

The leading profile marker and strict JSON fence are normative. The filename is only
a display hint. Readers verify Result byte size/digest, scan newest-first across the
shared Result revision stream and continue bounded pages on demand. A newer unknown or
damaged profile blocks editing; it never silently falls back to an older dossier.
No dossier means this Work has not saved structured production data yet.
Verification uses original bytes, including any UTF-8 BOM, before decoding. Each page,
continuation and final adoption is fenced to the same Work `source_version`; a changed
snapshot requires a fresh read and cannot advance the editor's save CAS silently.

Material references identify either an authorized Result of the same Work (exact ID,
revision and digest) or an HTTPS external location with a declared version. External
media bytes are not uploaded, fetched, embedded or preserved by this feature. Delivery
records freeze copies of exact references; feedback names a specific delivery ID/version.
Names, handoff details and reported feedback are the writer's private records, not
authenticated customer approval, proof of receipt or new platform authority.

The existing upload state machine checkpoints prepare, PUT and finalize acknowledgments.
Unknown outcomes retry the same phase/key/bytes. Finalize matches the upload version and
passes the expected Work version separately. A 412 retains the draft for comparison.
Creating Work and saving its first dossier are separate operations; failure of the second
leaves the same Work available to continue. Saving a text attachment and then registering
it in the dossier are also separate operations. Earlier immutable Results remain in history.

Access remains tenant/instance scoped, not per-project customer access. Mark progress
`done` to keep reopening a finished project; archiving removes ordinary Work access.
Portable output is the actual Markdown Result and authorized text attachments, not a
tenant export/import mechanism. No original image/video upload, client acceptance,
public publication, outbound message or new commerce/project core is included.

The production UI combines deployment/instance health with the existing owner/admin
Work template or an explicit grant on the addressed instance. Create, metadata,
archive and Result write are separate capabilities. Read-only members retain the
saved fields/history/downloads; a Result-only operator is not granted Work editing.
See [SP-03](../../docs/platform-plan/execution/guild-launchpad/SP-03-all-guild-launchpad.md#24-非商務製作企劃與版本工作台-v0)
and the existing [tenant Work implementation](../opportunity-project-work/README.md#tenant-manual-work).
