# Tenant workspaces

Tenant authority for one community member session. A tenant is not a user, a community, or a guild. Guild office and intern/full tier do not grant tenant access.

`authorization.ts` is the role matrix. `service.ts` performs the commands on the caller's transaction through the existing scoped command core. Tenant resource scopes are created inside `tenant.create` only.

Closed commands `tenant.create`, `tenant.invite.accept`, and `tenant.invite.decline` keep their receipts on the caller's personal scope. Create writes `freedom.tenant.created.v1` and the owner `freedom.tenant.membership.changed.v1` on that personal scope. Accept, `tenant.member.change`, and `tenant.member.leave` write `freedom.tenant.membership.changed.v1` (accept on the personal scope; change and leave on the tenant scope). Edit, workspace create, invite, decline, and revoke write the audit row and the receipt without a new outbox event. Workspace create does not bump `authorization_revision`.

Quotas in this slice: 5 active memberships in active tenants per person, 10 workspaces per tenant, 20 pending invitations per tenant, invitation expiry at most 7 days. `recovery_required` is allowed by the schema. The platform recovery workflow is not in this slice.

`GET /api/v1/tenants/invite-candidates?user_id=` resolves a visible same-community member to a person principal and may insert that person principal if mapping is missing. It never creates a tenant scope and never returns an email address.
