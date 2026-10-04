# Closed execution decision kernel

This is EXEC-A **hypothetical decision logic only**, not an authenticated runtime,
durable Run store, dispatch adapter, execution permit or proof of provider health.
Every decision carries `assurance: hypothetical_decision_only` and
`operational_authority: false`. `executionActivationStatus()` always returns
`unavailable`. Caller-supplied assertions, including `true`, confer no authority.

`evaluateExecution(input)` accepts a JSON string or an ordinary in-process object
and returns a frozen admissible decision with a projected snapshot, or a sanitized
denial. `decodeExecutionInput(rawJSON)` performs bounded wire/shape decoding and
throws `ExecutionInputError` on failure. The object convenience API does not invoke
ordinary getters/toJSON or mutate its input; it is not a hostile JavaScript Proxy
sandbox. Transport integrations must use raw JSON, not untrusted executable objects.

There is one Run state projection. RunAttempt records are append-only, explicitly
binding actual identity references, model/provider references, processing/artifact/
credential custody, billing source, Grant revision and adapter/contract versions.
The package does not choose those values. Synthetic fixture values in `vectors.ts`
are not a supported operational model route. Task lease, control ACK, Grant,
policy and recovery generation are separate fences; none is an alias for another.

## Transition matrix

| Event | Required state/facts | Projection |
| --- | --- | --- |
| preflight | owner; created/blocked/preflighting; no unsettled effect | bind first immutable attempt, or retain exact current binding; preflighting |
| activate | preflighting; current runtime/Grant/policy/recovery; model/budget ready | renew independent task/control epochs; ready |
| advance_model | ready/running; current lease/fences; model/budget ready; no unsettled effect | proposed dispatch; running |
| record_dispatch | running/run; matching proposed dispatch and current ACK; fresh readiness | in-flight dispatch, unknown usage |
| record_outcome | running/run; current dispatch/fences/lease; no model-health requirement | known running outcome, or reconciling |
| wait | ready/running; current runtime/fences; no model-health requirement | waiting_human/waiting_engine, or reconciling |
| pause / stop / revoke | current owner; nonterminal; no model/Grant/online requirement | increment fences; cancel only proposals; paused/reconciling or cancelling |
| control_ack | bound online runtime; current recovery/task/control; nonterminal | ACK control; known stopped work may become cancelled |
| block | owner or bound runtime; nonterminal | fence, blocked or reconciling |
| resume | owner; paused/waiting/blocked; no unsettled effect | fence; preflighting (created if no attempt yet) |
| late_evidence | owner-mediated, or original bound runtime within evidence window | append bounded observation only; never change dispatch, control, Result or Run state |
| reconcile_dispatch | owner; nonterminal; original linked evidence | explicitly resolve known facts, or retain manual_unknown; never auto-resume |
| handoff | owner; nonterminal; no unsettled outcome/usage | append new binding, preserve history, fence; preflighting |
| publication_decision | running/run; fresh fences; successful current attempt; exact Work version; no unsettled effect | hypothetical decision only; does not attach Result or increment Run version |
| complete | running/run; fresh fences; successful current attempt; separately asserted matching durable model Result | completed |
| fail | owner or fresh runtime; nonterminal | fence; failed only when effects are settled, otherwise reconciling |

Ordinary outcomes cannot undo pause/Stop. Terminal ACKs are denied. Late evidence
can be retained after terminalization but cannot resume or publish. In-flight,
unknown, manual-unknown and unknown-charge records cannot be discarded by failure,
Stop, ACK or handoff. Reconciliation remains a hypothetical owner decision, not a
choice of recovery authority. No model Result can request human provenance.
`snapshot.work_version` is the original task input version. A separately asserted
durable Result may name the later committed Work version (for example input 7,
Result/current Work 8); completion compares that Result to asserted current Work,
without pretending that this pure kernel performed the domain CAS.

## Validation and prototype bounds

The authoring schema is `contracts/execution/v1/state.ts`; generated JSON Schema
is deterministic. `node --import tsx packages/execution-state/generate.ts --check`
checks its bytes. No preview contract or legacy digest/TaskLease format is changed.

Validation has three explicit layers: bounded JSON transport; strict structural
schema; relational/state semantics in `evaluateExecution`. JSON Schema alone does
not reject duplicate JSON keys, enforce signed-64-bit decimal version maxima or
prove references, current authority, leases or immutable history. The evaluator
enforces positive decimal versions through `9223372036854775807` without Number
coercion. Raw numeric tokens must be safe integer literals, not fractional/exponent
representations; JSON Schema operates on already parsed numeric values. Digest
references are exactly 64 lowercase hex characters; no hash computation, JCS,
signature, signing identity or authenticity is claimed.

The wire bound is 32 KiB UTF-8, depth 24 and 4096 nodes. A separate 24 KiB
control-reserved snapshot budget charges the maximum serialized widths of mutable
control/version/Result fields and dispatch status/usage before admitting growth.
It leaves 8 KiB for the bounded event/assertion envelope. Thus a newly admitted
snapshot still fits a compact owner Stop/ACK input even as epochs grow or proposals
are fenced. The next history-growing transition is denied before it creates an
unrepresentable successor; the previous snapshot remains usable. This is byte
budget accounting, not canonicalization or a hash. Attempt/dispatch/evidence
array bounds are 16/128/128; the byte bound can be reached earlier. These are
**prototype input bounds**, not product lifetime/history limits. Exceeding a bound
denies the operation; records are never evicted or truncated. Duplicate decoded
keys, unsafe/fractional numbers, lone surrogates, unknown fields, executable payloads,
sparse arrays and unsupported object values are rejected. Evidence carries only
identity, outcome/usage status and digest metadata, never prompts, tool payloads,
provider secrets, content or credentials.

## Not implemented / prerequisites

Durable Run/immutable Attempt storage, authenticated machine/connection/Grant
bindings, observed readiness, trusted time, control/recovery authority, atomic
dispatch bookkeeping, bounded evidence ingestion and provider/custody/billing
selection require separately reviewed adapters. Serialized decisions must never
be accepted as authorization. The existing member-session Asset pipeline cannot
impersonate a runtime. Migration 084 currently fixes Result provenance to human;
AI publication needs a future typed attempt/Grant/inference provenance migration
and domain adapter using the same Asset engine, current Work CAS and atomic facts.
No current code activates that path, changes SQL, calls a model/CLI/provider,
issues a token/permit, or exposes HTTP.

Run `node --import tsx --test tests/runtime/execution-state.test.ts` for declared
transitions, adversarial decoder cases, generated-schema parity and negative
fence/history/provenance vectors. No database is used.

## Shared bounded HTTP JSON reader

[http-body.ts](http-body.ts) exports `readBoundedHttpJson(request)` for the closed
bootstrap and member execution factories. It retains the existing strict JSON
grammar and actual byte/chunk/deadline bounds, rejects malformed UTF-8 and
decoded duplicate/prototype keys, checks Content-Length against actual bytes,
and releases failed readers without awaiting hostile cancellation. The helper
does not authenticate, authorize, issue permits or register any HTTP route.
Each transport verifies its credential purpose, origin and member/machine
boundary before calling it. Domain services separately revalidate current DB
authority after potentially delayed body reads.
