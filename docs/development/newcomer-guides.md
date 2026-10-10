# Opt-in newcomer guides

## Scope and source

This redesign adapts [mars-tw's PR #106](https://github.com/FreeTWAI-AI/freedom-platform/pull/106), exact source `46a40342509a9278c3a7b8a940bce27b7f464227`, onto main `d269a8d7605630cab1da605d7cac4d0c254e3258`. The author's character names, 26 page question packs, 364 WebP assets, dialogue and animation behavior, and original art/prompt/copy provenance are preserved. Generic behavior and the tests explicitly credit that source. AI-assisted work here restructures activation, assets, anchors and validation; it does not claim authorship of the original illustrations or independently generated art. Original author: `mars-tw <97515456+mars-tw@users.noreply.github.com>`.

The original PR/fork is unchanged. This branch is an independent integration proposal. No merge, remote resource creation, credential creation, R2 upload, deployment or production acceptance is implied.

The inline interface also adapts Mars's follow-up `99b90451b1b047a34d443318a21e4aad973ae226` onto main `89f64ace3b9c24e493fc367b1b489dc8749ee20e`. That increment changes layout and interaction, not art or question-bank bytes. Its authored layout, entry actions, disclosure structure and browser coverage are preserved within this module; the original asset manifest/source pin remains unchanged.

## One saved choice, separate responsibilities

`freedom-theme` retains the exact `light`, `dark`, and `versefolk` values. Its fourth value `guide-dragon` selects **新手導覽－龍娘**, with dark as the base, an additive dragon skin, and the versioned dragon guide pack. There is no separate persistent `guideEnabled` bit. Unknown/removed values return to light/off. Blocked storage leaves the current visit usable. Existing accessibility motion preferences are separate presentation settings, never an activation authority.

The fifth value `guide-ai-sister` selects **新手導覽－AI Sister**, based on light. The member chooses one of 17 characters; that character follows them across supported pages, wearing the page's assigned outfit. See [AI Sister wardrobe integration](ai-sister-guides.md) for the source snapshot, full library, explicit outfit mapping, local preference and independent OFF release gate. Its artwork attribution is separate from mars-tw's original engine, Dragon artwork and shared reviewed page copy.

The original three themes have no guide engine/content/art or guide-release requests. General page help, security notices, original forms, branding, authorization, and the Game Console retain their existing behavior. The fourth skin uses existing semantic CSS variables and does not request remote fonts or art by itself.

`GuideHost` is the only mount point, inside the existing fully admitted member workspace. It checks profile, account scope, current access, explicit page support, then the server's release version and exact manifest SHA before any character lookup or lazy engine/pack import. A changed profile/page/account removes the old engine immediately; scoped identity and abort/generation guards discard late release/content responses. Engine teardown cancels animation frames, image preload references, observers/listeners, temporary focus markers/tabindex and local conversation state.

The reusable engine receives `GuidePage`, character metadata and a content loader. It knows no page catalog and executes no remotely supplied JavaScript/CSS/HTML/action. All question answers are reviewed local data, not model output. Its only page interaction is scroll/focus/highlight, with one unambiguous visible named anchor. Missing, hidden, disabled, inert, busy, dialog-owned or duplicate targets fail closed; no action is clicked or submitted.

## Companion layout and interaction

The gated companion owns document space instead of a body portal or fixed dialogue overlay. At widths of at least 1280px it has a 264px right column; below that it becomes a row before the page content. The original three profiles, unsupported pages and disabled releases reserve no companion column. The shared page component stays mounted across profile changes, so an unsent business form is not reset by switching appearance. The single page heading and existing tools stay together above the content, while the main landmark keeps its heading association and navigation focus.

The current page hero and **問本頁／帶我看** actions are visible first. Questions, reviewed history and motion preferences are disclosures, and the guide directory requires an explicit choice before focusing any original control. A guide collapses its inline explanation before locating/focusing the target in the next animation frame, then rechecks identity, eligibility and anchor uniqueness. Page/account/profile changes, another dialog, the Console or invalidated targets cancel pending work. Returning from an interrupted surface never reopens a stale gallery or resumes an old guide automatically. The gallery remains a separately opened native modal with focus return.

## Explicit page contract

`DRAGON_PAGE_SUPPORT` is a typed record covering every navigation page plus registration, onboarding, admin and skill-book dialogs. Runtime CI cross-checks the actual `developmentPages` and `TAB_TITLES`; a new page without an explicit decision fails. Supported entries reference a character, content ID, nonempty guide IDs and anchor contract v1. Disabled entries require a specific nonempty reason. `private-ai` is deliberately disabled until its content and targeting are reviewed. Unknown runtime pages are off, never a home-character fallback.

All 47 steps use `data-guide-anchor="page:purpose"` on real owning components; the engine does not support arbitrary selector grammar. The retired notification-tab step is removed after notifications moved to the bell; the compatibility messages pack describes the four chat tabs and scoped notification read-all. The floating chat panel still suppresses guidance and remains outside eligible guide targets. Literal anchor uniqueness tests complement browser cases but do not prove visibility or role-dependent behavior. Browsers must still test those using eligible synthetic accounts.

For another pack, add a profile and a versioned pack implementing the same engine contract, declare all page decisions, pin its asset manifest/release, and add its host loader/gate and coverage. Do not copy the engine or extend the closed preview SDK.

## Assets and rollout

The 364 authored source images live under `assets/guide-packs/dragon-v1-20261004/`, outside Vite public/dist. They are never served as unrestricted files. The reviewed source manifest is `contracts/guide-packs/dragon-v1-20261004.json`; all source bytes/dimensions were independently hashed/read for this proposal. Its exact-byte SHA-256 is `506d5fe7eb653874286baeb58b3bc47f44e243279104fae2d9a8ada2a65723ee`.

See [public asset delivery](public-guide-assets.md) for the dedicated private-origin `GUIDE_STATIC` binding, bounded WebP digest verification, GET/HEAD allowlist and purpose-aware deployment checks. This public platform asset purpose does not use MEDIA, member-avatar authority, private share tokens, backfill or GC. All operator-approved MEDIA domains and lifecycle policies remain untouched; do not copy historical all-OFF or partial-rollout deployment overlays over the current installation.

The separate activation change pins [actual publisher receipts](guide-publisher-2026-10-05.md) for both private origins. The host remains **OFF** without its explicit flag and native binding. Deploy only after the activation change passes CI, review and merge; accept the enabled staging browser flows before production. Selecting the profile can show its skin while that deployment gate is off; ordinary page help remains available. No live asset/caching claim is made by local tests. Approved public immutable bytes cannot be clawed back from browsers that already downloaded them.

Only the selected character's current page outfit/hero loads before interaction. Opening questions or the guide directory loads that page's content and needed reactions (or Dragon's six animation frames). A hero may share the frame-0 digest; that static request is not animation preloading. The gallery is part of the gated module; only its selected character/outfit/view image loads. Art failures never grant business authority or reveal private media.

## Local development and checks

After starting the existing isolated local PostgreSQL workflow:

```sh
FREEDOM_ENV=local FREEDOM_GUIDE_FIXTURE_ENABLED=true npm start
npm run dev
```

The local Node adapter reads the same allowlisted manifest and verifies the same full image bytes as the Worker route. That fixture switch is rejected outside local. The Playwright test server installs it only under its explicit `FREEDOM_E2E_GUIDE_FIXTURE=1` flag; it is never a production bypass.

```sh
npm run typecheck
npm run build
node --import tsx --test tests/runtime/newcomer-guides.test.ts tests/runtime/newcomer-guide-dialogue.test.ts tests/runtime/guide-anchors.test.ts tests/runtime/guide-pack-assets.test.ts
npm run test:e2e -- tests/e2e/newcomer-guides.spec.ts
npm run test:governance
npm run test:contracts
npm run test:repos
```

Run the full runtime/Worker/CI suites against the final combined tree. Build before browser tests. Record actual passed/failed/not-run results separately. Required browser coverage includes legacy zero requests, opt-in/reload, page/account/theme switch and late callbacks, gallery Escape/focus return, named-anchor focus/cleanup, absent/ambiguous targets, IME, reduced-motion, low-height/mobile, dialogs/Console and Back/Forward. A compiled browser suite is not a passed browser run, and this descriptor is not trusted runtime-registration/production authorization evidence.
