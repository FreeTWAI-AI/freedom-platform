# Positioning foundation and first module delivery

The user-owned legacy positioning reference is a useful content and discovery reference. Its private source, historical responses, images, analytics identifiers and implementation are not included in this public repository. This module is an original implementation of the canonical plan's self-declared route (`04` §2), not an imported assessment engine.

The working slice separates three concepts:

- Real-world occupations and strengths are the member's own words, saved privately with their background, goal and available time.
- Twenty-eight editable choices of career direction connect practical outcomes to the twelve canonical vertical Guild professions. Selecting a direction does not grant membership or authority.
- Joining a Guild creates a separate community-scoped Runner membership, after the member explicitly chooses to join. Members can leave, rejoin and belong to multiple Guilds without taking a test. No officeholder, paid entitlement, skill certification or historical work acting identity is assigned by this module.

The PostgreSQL migration owns global versioned catalogs and community-scoped profile revisions and membership facts. Commands reuse shared sessions, CSRF protection, request idempotency, version checks, transactions, journal and outbox. Confirmed profile revisions remain immutable; current views read the latest revision. The direction card is visible only to its owner. Private answers and free text are omitted from published event payloads.

Recommendations select at most three directions from the member's explicit choices or selected participation roles. Each explains its rule and suggests a small result. Zero available time is valid, and a profile is never required for other platform participation.

Next work: extract a separately licensed and reviewed immutable assessment definition with stable question IDs, server evaluation and golden fixtures; keep its historical rules reproducible. Add member-controlled sharing, catalog administration and operational Guild activities independently. The current Guild directory provides participation registration and introductory work suggestions; it does not claim staffed coaching, live Discord channels, officer appointments or rank progression.

Validation lives in `tests/runtime/positioning.test.ts` and `tests/e2e/positioning-modules.spec.ts`. Source inspection alone is not a report that tests passed; executed results are recorded in the release validation notes.
