# Guild workspace

The launchpad reads published guild configuration and computes a platform default when no usable revision exists. Leaders and delegates save immutable drafts, preview them, publish with pointer CAS, and revert by creating a new revision. Public configuration passes through `publicSafeConfig`; guild content authority grants no access to tenant Work.

`launchpad-profiles.ts` defines purpose profiles for `guild_commerce_sales` and `guild_commercial_production`; every other guild keeps the existing block order and empty recommendations. Default `application_refs` come from offered releases in the viewer's scope. `PLATFORM_DEFAULT_REVISION` pins default content at `3`, while `DEFAULT_POINTER_VERSION` keeps the initial pointer CAS at `1`. The primary application is the first application returned by `recommendedApplications` for the rendered configuration.

The commerce purpose profile recommends 「線上商店」 first, followed by the existing manual workspace; the production profile keeps manual workspace first.
