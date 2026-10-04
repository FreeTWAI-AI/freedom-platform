# Event highlight pair adapter

`createEventHighlightAssetService` installs the existing photo/poster upload
writer through two finite common Asset profiles. Host composition must supply
both `eventHighlightAssets` and `eventHighlightAssetStore`; absent installation
fails closed when the canonical mode is not `legacy`. Migration 104 retains
legacy mode, prohibited persistence, and no guessed policy revision or quota.
Operator policy and server-installed policy must agree before every phase.

Original `modules/community/event-highlights.ts` remains the authority: any
current community member can upload to a published, ended, listed event.
Original per-member/per-event caps, raw 10 MiB input normalization, orientation,
main 1 MiB WebP, thumbnail 200 KiB WebP, URLs, DTOs, ordering, CSRF, and original
receipt body remain unchanged. Removal belongs to the uploader, organizer, or
current verified platform administrator. This is not the banner organizer ACL.

The facade prepares both intents before object I/O and reserves their combined
maximum plus retained legacy bytes. It verifies each immutable object in closed
transactions, then consumes both finalization callbacks on one original receipt
transaction with current member, event, policy, pair, and asset locks. Only the
thumbnail callback publishes the domain pair and one scoped publication fact;
the main component has no independent domain publication. Deferred constraints
require both ready, scope/owner/profile-bound pointers and both variant rows.
Interrupted or ambiguous PUTs resume the same immutable pair; no public item or
success receipt exists after partial failure. Removal clears and retires both
pointers in the original transaction. Object deletion remains maintenance work.

Public reads use the original ACL before and after verified object I/O. Asset
sources never read legacy bytes when a binding, pointer, or object is unavailable.
The highlight banner URL likewise preserves its original ended-event ACL while
reading an installed banner Asset. Original public cache remains 300 seconds;
server ACL changes cannot revoke already downloaded or browser-cached bytes.

This increment does not activate cloud storage, migrate historical highlight
pairs, purge legacy bytes, or approve cutover. The R2-only floor rejects retained
legacy highlight representations. Historical backfill still needs a resumable,
authorized pair migration and reconciliation before an operator can cut over.
