# Issue pipeline — 2026-09-28

This queue reflects the open [repository Issues](https://github.com/FreeTWAI-AI/freedom-platform/issues) and [pull requests](https://github.com/FreeTWAI-AI/freedom-platform/pulls) reviewed on 2026-09-28. An Issue is complete only after the relevant code is merged, deployed where applicable, and checked against its user-visible behavior.

| Order | Issue | Next delivery gate |
| --- | --- | --- |
| 1 | [#27 Console message history](https://github.com/FreeTWAI-AI/freedom-platform/issues/27) | Restore sent and received chat after a new login; verify a real send, logout, and login. |
| 1 | [#20 Actionable notifications](https://github.com/FreeTWAI-AI/freedom-platform/issues/20), [#22 Issue screenshots and GitHub connection](https://github.com/FreeTWAI-AI/freedom-platform/issues/22) | Complete [PR #29](https://github.com/FreeTWAI-AI/freedom-platform/pull/29), then verify Staging and Live. |
| 1 | Co-creation GitHub rate limits | Complete [PR #26](https://github.com/FreeTWAI-AI/freedom-platform/pull/26), then verify Staging and Live. |
| 2 | [#19 Password recovery](https://github.com/FreeTWAI-AI/freedom-platform/issues/19) | Complete [PR #28](https://github.com/FreeTWAI-AI/freedom-platform/pull/28); onboard and verify `mail.freetwai.com` in Cloudflare Email Sending, then test a controlled mailbox on Staging before Live. |
| 3 | [#23 Coaching squads](https://github.com/FreeTWAI-AI/freedom-platform/issues/23) | Add the third squad type through the existing squad model, permissions, creation, and search flows. |
| 3 | [#24 Squad LINE channel](https://github.com/FreeTWAI-AI/freedom-platform/issues/24) | Let squad managers set a plain-text LINE channel name, visible to squad members in the squad view. Review privacy before exposing it outside the squad. |
| Ongoing | [#12 Member experience proposal](https://github.com/FreeTWAI-AI/freedom-platform/issues/12) | Keep as the product umbrella for adoption measures and the separate contribution/XP policy decision; [PR #17](https://github.com/FreeTWAI-AI/freedom-platform/pull/17) delivered the approved entry, theme, activity, and task-board foundation. |

Issue #18's event details and review routing merged in [PR #25](https://github.com/FreeTWAI-AI/freedom-platform/pull/25). Its additive migrations 042–045 and Worker are already on Staging; Live release remains part of the next verified delivery.
