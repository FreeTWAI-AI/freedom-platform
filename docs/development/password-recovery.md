# Password recovery rollout

Password recovery uses the Worker `EMAIL` binding from Cloudflare Email Sending. The registered sender is `no-reply@mail.freetwai.com`; both deployed Worker environments restrict the binding to that address. The login page offers recovery only when the binding is present and `FREEDOM_PASSWORD_RESET_EMAIL_ENABLED=true`.

## Enable sending

1. On the Cloudflare account that owns `freetwai.com`, onboard `mail.freetwai.com` under **Compute → Email Service → Email Sending**. Confirm its DNS and sender status before switching on recovery. Cloudflare [documents the domain onboarding and DNS records](https://developers.cloudflare.com/email-service/configuration/domains/).
2. Include the repository's `send_email` binding in the private staging and production release overlays. Keep `allowed_sender_addresses` restricted to `no-reply@mail.freetwai.com`. The Worker [binding API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) sends a plain text message to the member's registered address.
3. Apply migration `046_password_reset_tokens.sql` to the target database. Set `FREEDOM_PASSWORD_RESET_EMAIL_ENABLED=true` in the target's private vars after the domain is ready, then deploy and verify a real end-to-end reset against a controlled mailbox. Start in Staging and only then enable Live.

Cloudflare's [pricing](https://developers.cloudflare.com/email-service/platform/pricing/) lists 3,000 outbound messages per account each month on Workers Paid, then US$0.35 per 1,000. Sending to arbitrary member addresses requires Workers Paid. Existing password recovery rate limits cap requests per address, source network, and globally.

## Behavior

The request endpoint returns the same response whether an address exists. Each link is random, stored only as a SHA-256 digest, expires after 30 minutes, and can be used once. A successful reset changes the password, proves the mailbox address, revokes every existing session, invalidates other reset links, resets that account's login-failure window, and creates a fresh thirty-day member session in the same transaction. The confirmation response includes `reset`, `expires_after_minutes`, `user` and `csrf_token`; its HttpOnly session cookie is set without exposing the raw session token in JSON. The portal enters the authenticated member area directly instead of retrying the locked password-login endpoint. Delivery failures log only a restricted provider error code and remove the associated link.

With TOTP enabled, reset still changes the password and revokes all sessions,
but does **not** create a new session or clear second-factor failures. It returns
`{reset:true,totp_required:true,expires_after_minutes:30}` without a cookie.
The portal returns to password login and requires the authenticator or one unused
backup code. Mailbox recovery never disables MFA or regenerates backup codes.
See [member MFA API and key prerequisites](member-api.md).

## Lockout recovery policy

Ordinary login still permits ten failures per account per fifteen-minute window,
with the existing persistent network and global limits. A reset request, invalid
link, expired link or inactive account never clears that budget. Only possession
of an unconsumed mailbox link authorizes recovery. Reset confirmation keeps its
own network/global limits; no challenge provider or email ownership is inferred
from a submitted address. Deployments without a configured sender return 503 and
cannot provide this mailbox recovery path.

Reset transactions lock the account's attempt row before the user and token,
matching login's lock order and serializing competing reset links. Failures roll
back the password, lockout reset and session together. After recovery, new failed
password attempts may lock ordinary login again, but cannot revoke the recovered
session; the verified member can continue using it without another login attempt.
