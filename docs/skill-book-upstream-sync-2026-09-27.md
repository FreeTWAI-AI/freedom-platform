# Skill-book upstream sync — 2026-09-27

The next review is [2026-09-30](./skill-book-upstream-sync-2026-09-30.md). This page records the 2026-09-27 pins only.

## Source of the catalog

The production-facing official catalog is `communityCatalog.skill_books` in `modules/community/catalog.ts`. Its effective `source_commit` is either declared there or inherited from `modules/community/skill-book-guides.ts`. Two community-authored entries are pinned in `modules/community/community-author-skills.ts`. `repositories.lock.json` pins cross-repository test consumers, not the 37 skill books. The `freedom-skill-registry` package declaration list is empty and does not hold these pins.

This review compares each book’s `upstream_url` default branch with its effective `source_commit`. Several FreeTWAI-AI forks have newer commits than their original sources; fork-only commits do not advance these source pins.

## Reviewed updates

All 18 pinned commits were ancestors of their new upstream default-branch heads. Their pinned reading and evidence files exist at the new SHA. The notes below describe changes relevant to the catalog format and guide claims; they do not certify the upstream applications.

| Book | Pinned → upstream head | Format review |
| --- | --- | --- |
| `aiwff-runtime` | [`8d3eabf0cb → 95c5234aca`](https://github.com/zaxardery8011-design/aiwff-runtime/compare/8d3eabf0cb614f74b6c1d3a0b9316e5c9f2fcc19...95c5234aca4e12f33812b60b2bf26e9095185909) | Optional OpenAI-compatible worker added; task/result Markdown path remains, no catalog format change. Guide now states the no-tools limit. |
| `line-persona` | [`8b44f432a8 → ed445cfd62`](https://github.com/zaxardery8011-design/line-persona/compare/8b44f432a8b8e847c7164290f656bcca9164aaec...ed445cfd62a7e38b3d05233a40c1c773d4aadcbb) | Optional xAI endpoint example added; Markdown persona and setup format unchanged. |
| `career-guide` | [`22b1ff3fb3 → 4f7f7fafec`](https://github.com/FreeTWAI-AI/freedom-skill-career-guide/compare/22b1ff3fb3051ff98c330024f7507f5e9da13574...4f7f7fafec4237ba8c63986ec2c07f026e4e34a8) | Repository guidance added; SKILL.md and skill-book.json unchanged. |
| `supplier-client` | [`6f5f905aa2 → 53fd5b0ac4`](https://github.com/FreeTWAI-AI/freedom-supplier-client/compare/6f5f905aa20f89a33dbcf9053421a1dbaf70e97a...53fd5b0ac4a1b67ccd71a8cc4ba092ea15bb3534) | Repository guidance added; client API and package files unchanged. |
| `storefront` | [`39aeff383b → 9823df79f8`](https://github.com/FreeTWAI-AI/freedom-storefront/compare/39aeff383bb4fa58b57dcf9ed3bf7e1023535d3f...9823df79f8eee86008c269437880ed2e49bdc394) | Repository guidance added; template and SDK files unchanged. |
| `community-ops` | [`716f668a88 → 44e14e9303`](https://github.com/FreeTWAI-AI/freedom-skill-community-ops/compare/716f668a883c2333d4b7d6a8bd79e809d1c740a6...44e14e93038caa640ce4ccc4ca22e6326757c24b) | Repository guidance added; SKILL.md and skill-book.json unchanged. |
| `partnership` | [`7117120a63 → 40bde2433e`](https://github.com/FreeTWAI-AI/freedom-skill-partnership/compare/7117120a635a0782f170de9448ef85314a16be5d...40bde2433e7779dd402797104a09aec72f112810) | Repository guidance added; SKILL.md and skill-book.json unchanged. |
| `reconciliation` | [`c43eac1fa3 → 0cb216a37f`](https://github.com/FreeTWAI-AI/freedom-skill-reconciliation/compare/c43eac1fa37418a6b7d7569bddf54e2eb4822815...0cb216a37f1ba5a00cfe467053130f31b710d9cf) | Repository guidance added; SKILL.md and skill-book.json unchanged. |
| `project-delivery` | [`ae381bcc77 → 8fef03e153`](https://github.com/FreeTWAI-AI/freedom-skill-project-delivery/compare/ae381bcc77e82b4d646e5c3d7f7b63db2a0c0dd2...8fef03e153463a91e9253705becef6d3a744207e) | Repository guidance added; SKILL.md and skill-book.json unchanged. |
| `agent-kit` | [`df41da1599 → 201fdab801`](https://github.com/FreeTWAI-AI/freedom-agent-kit/compare/df41da159920fb520d962402f2a98dcc9d36c5d1...201fdab8017e2850bafc7b2f1e8dec7e4c0d6233) | Repository guidance added; client and package files unchanged. |
| `project-template` | [`0f58bd087a → 9bc7cee3f9`](https://github.com/FreeTWAI-AI/freedom-project-template/compare/0f58bd087a38e9a1dec98b7038ad9840d20f2cdc...9bc7cee3f98d21da3156e5a67bfa63dc63a4615e) | Repository guidance updated; project code and package files unchanged. |
| `video-autopilot` | [`74041fcb29 → eebd50eb87`](https://github.com/Hao0321/video-autopilot-kit/compare/74041fcb292788f4c24e3d06f39fe2c9dee7a8cb...eebd50eb878c29163d6848fcd0d15e8f2124a9d8) | Runtime workflow contract and implementation changed substantially. Catalog links only to README and unchanged example paths; it does not parse or execute that contract. Existing v0.23.0 guide remains bounded to the introductory example. |
| `security-scanner` | [`9fae58fbf0 → b993a6b421`](https://github.com/teddashh/ai-security-scanner/compare/9fae58fbf0e78f25fad5b1e9f70104ac5ab73153...b993a6b421e4280a1d4ddbb160943a558394b366) | Scan UI and engine catalog evolved, including a non-runnable experimental ZAP entry. Public release remains HOLD; catalog reading and report guidance still apply. |
| `ai-sister` | [`02100bf2e8 → 5e03e2bb10`](https://github.com/teddashh/AI-Sister/compare/02100bf2e83d3a77bce5dc14c256f4dd4bb5e270...5e03e2bb10b2ff3f843cb029334a0e338c88cfed) | Local recall/capture implementation and release notes evolved; no catalog link format changed. Guide alpha label updated to 168. |
| `multi-ai-desktop` | [`dd22b21178 → 0f0d044daf`](https://github.com/teddashh/multi-ai-chat-desktop/compare/dd22b21178212cd9b717aafd9cca82d25b85f681...0f0d044daf6785d0485e8fec8d1c8c579ecd57ab) | ChatGPT adapter selectors updated to v8; adapter schema and v1.9.5 guide path unchanged. |
| `multi-ai-chat` | [`cd96e66de6 → c7162a69e8`](https://github.com/teddashh/multi-ai-chat/compare/cd96e66de6c0a5b2ff6b5f95e09963c66cd0bf7f...c7162a69e80094671541d894d068e4ac39b6cc5a) | Chrome Web Store listing advanced to v0.3.0; guide status corrected. Extension installation path unchanged. |
| `music-mv` | [`c189cbcbde → 1355605306`](https://github.com/FreeTWAI-AI/freedom-skill-music-mv/compare/c189cbcbde61d2a4b109ba6e72f2ee8882f9ee07...135560530626c13ccf5d13c299e683d7bd8f132a) | Repository guidance added; SKILL.md and skill-book.json unchanged. |
| `commercial-production` | [`815b0a2f2b → 7c25e5e5db`](https://github.com/FreeTWAI-AI/freedom-skill-commercial-production/compare/815b0a2f2bff90f9c9624d35a144d8bb70477667...7c25e5e5db060950b846ac48bfe44bc5cf32f117) | Repository guidance added; SKILL.md and skill-book.json unchanged. |

## Repeat the check

Run `npm run check:skill-book-upstreams`. It queries the latest default-branch commit of each of the 37 original upstream repositories, prints a Markdown drift report with compare links, and exits with a nonzero status for drift or API errors. It only reads public GitHub data. Set `GITHUB_TOKEN` or `GH_TOKEN` in the environment for repeated checks beyond GitHub's anonymous rate limit; in GitHub Actions the report is also appended to `GITHUB_STEP_SUMMARY`.

Before changing a pin, review the compare diff for source-format changes, verify the guide’s reading and evidence paths at the new commit, update any claims affected by the diff, and run `npx tsx --test tests/runtime/skill-book-upstreams.test.ts`, `npm run typecheck`, and the live drift check again. This process does not deploy or publish.
