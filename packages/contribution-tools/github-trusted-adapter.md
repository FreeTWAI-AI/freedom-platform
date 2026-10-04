# Operator host adapter (installation pending)

The executable is an operator bootstrap component. Review and pin its bytes and its `io.mjs` / `errors.mjs` imports, then install them outside all candidate checkouts under a separate operating-system owner. Running a PR's copy does not establish trust. Launch the pinned bootstrap with an operator-controlled executable and clean environment; inherited `NODE_OPTIONS`, loader flags and candidate configuration are not permitted. This implementation makes no GitHub request and cannot publish a merge check. It reports `gate_enforced:false` and `publisher_trust:unverified`, including after authenticated inputs and a local verifier pass.

## Concrete host commands

Use absolute paths owned by the operator. The host configuration must never come from candidate arguments, repository variables controlled by the PR, or candidate artifacts.

```sh
node /opt/freedom-bootstrap/packages/contribution-tools/github-trusted-adapter.mjs --dry-run /etc/freedom-host/config.json
node /opt/freedom-bootstrap/packages/contribution-tools/github-trusted-adapter.mjs --install /etc/freedom-host/config.json
node /opt/freedom-bootstrap/packages/contribution-tools/github-trusted-adapter.mjs --verify /etc/freedom-host/config.json /var/lib/freedom-host/job.proof.json /var/lib/freedom-host/observations.proof.json
```

The dry run emits a reviewable `PATCH /repos/{repository}/branches/main/protection/required_status_checks` request, with `strict:true` and the check's positive `app_id`. It does not send it. Review and preserve existing required checks when composing the final request; replacing that list with this one-check proposal would remove other checks. See [GitHub's branch protection API](https://docs.github.com/en/rest/branches/branch-protection#update-status-check-protection).

`config.json` contains `repository`, `app_id`, `check_name`, `host_root`, `distribution_root`, nonempty `candidate_roots`, `object_repository`, `policy_root`, `verifier_commit`, `verifier_sha256`, `expected_policy:{revision,sha256}`, and operator `trust:{publisher,keys}`. No private key is accepted. The positive App id must identify the separate publisher, not GitHub Actions or a candidate-controlled App. Install, distribution, policy and bare-object repository paths must resolve outside candidate roots. Protect the host, policy and distribution against concurrent untrusted writers; mode bits alone do not authenticate an operator. The adapter copies only the approved static verifier closure into a fresh digest-named directory, validates copied bytes again, and only then imports the fixed verifier entry. A preexisting installation must match all authenticated bytes.

The verifier pin is the ordered `[path,sha256]` closure fingerprint from `installedVerifierDigest()`, independently approved by the operator. `distribution_root/installation.proof.json` wraps exact manifest bytes in `{kid,payload,signature}`, where payload and signature use canonical base64url. Manifest fields are `format:freedom.github-verifier-installation/v1`, `publisher`, `commit`, `sha256`, and the sorted closure `files:[{path,sha256}]`. A candidate's vendor release, key or entrypoint cannot choose this installation.

## Authentication and candidate binding

Each operator trust key has `kid`, `purpose`, Ed25519 `public_jwk`, `not_before`, and `not_after`. Separate purposes are `verifier-installation`, `github-candidate`, and `runner-observations`; a release-signing key is insufficient. Exact payload bytes are signed with the domain `freedom.github-host/{purpose}/v1` followed by one NUL byte. Neither the bootstrap nor this repository generates or distributes operator private keys.

The independently authenticated event gateway signs a job payload with `format:freedom.github-candidate/v1`, `publisher`, `issued_at`, `expires_at` (maximum five-minute window), `event`, `repository`, `run_id`, `run_attempt`, `pull_request`, `base_commit`, `head_commit`, `candidate_commit`, and `candidate_tree`. It must obtain current identities from authenticated GitHub delivery/API state and reject superseded/replayed events before signing. The executable validates identity, freshness and graph binding; it does not implement webhook HMAC verification, API re-fetch, delivery replay storage or supersession storage.

For `pull_request`, the PR number is positive and the candidate is the exact head descended from base or the exact two-parent integration commit. For `merge_group`, PR number is null, candidate equals the authenticated queue head, and that head must descend from the authenticated queue base. Do not invent a single PR number for an aggregate candidate. Base equal to candidate is rejected. Actual Git object/tree/parent validation runs inside the pinned verifier using a complete host-owned bare repository with graph overrides prohibited.

The isolated runner signs `format:freedom.github-runner-observations/v1`, `publisher`, `repository`, `run_id`, `run_attempt`, and `observations`. Every observation is still checked against the full candidate/tree/base/run/policy/verifier binding, workflow publisher/revision, suite and harness digest by the existing verifier. These signatures must originate from a separate trusted supervisor; candidate JSON or candidate exit status cannot obtain a signing key. A successful signed envelope does not prove the supervisor's behavioral adequacy or source approval.

## Pending production boundary

An operator still must install and audit the fixed event gateway, isolated supervisor and harnesses, replay/supersession state, independently approved verifier/policy keys and revisions, and a separate authenticated GitHub App publisher. The publisher must recheck current candidate identity, publish only the exact verified candidate SHA, and create checks under its own App identity. Candidate workers must receive neither publisher credentials nor trusted observation signing keys. Check name alone is forgeable; bind the required check to that App. This executable deliberately has no token or network publishing mode.

The diagnostic candidate workflow runs on PRs and `merge_group:checks_requested`; only superseded PR workflow runs are cancelled. Those candidate-modifiable results do not satisfy the fixed-host trust boundary. Installing branch enforcement, preserving all existing requirements, confirming merge queue behavior, and observing a malicious PR actually blocked are pending. Local tests are developer evidence, not independent review or production enforcement. No gate-complete or deployment-ready claim follows from this increment.

## Separate publisher library (not installed)

`github-app-publisher.mjs` now provides `createGithubAppPublisher(config, ports)` and `createGithubAppTransport(config, privateKey, {fetchImpl})`. The operator must independently review/pin this module outside candidate checkouts. The transport takes an already-loaded RSA private `KeyObject` supplied by the operator; it does not read a key file or environment token. Do not expose either factory's ports to candidate workers. No production command, credential provisioning, host registration or branch protection installation is supplied by this increment.

Publisher configuration is exactly `{repository,repository_id,app_id,installation_id,check_name}`. Transport configuration omits `check_name`. The publisher copies/freezes its supplied port registration at construction. Its private closure creates RS256 App JWTs, obtains installation tokens scoped to the pinned repository ID and five required permissions, and only exposes two request closures. Requests use the fixed `https://api.github.com` origin, reject redirects, have a five-second timeout and a one-MiB response limit. No credential, upstream exception or response body is included in publisher reports. See GitHub's [JWT requirements](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) and [installation token API](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app).

Operator host composition is a library call, not a candidate CLI:

```js
const requests = createGithubAppTransport(transportConfig, operatorLoadedKey);
const publisher = createGithubAppPublisher(publisherConfig, {
  ...requests,
  verify: installedHostVerifyWithAuthenticatedObservations
});
const result = await publisher.publish(authenticatedCandidateBinding);
```

`verify` must be a fixed operator-owned callback invoking the installed host verifier with independently authenticated observations and policy. It must never deserialize a candidate-supplied report or return `runHostVerification`'s outer unavailable adapter report as an accepted verdict. The publisher admits only the existing `freedom.host-verifier-report/v1` passed result, no blockers, complete distinct selected-suite evidence and identical candidate binding. Those structural checks do not authenticate the callback: installation and protected host composition remain prerequisites. Candidate input has only the seven existing identity fields; extra conclusion, report or token fields are rejected.

This increment supports PR exact-head candidates only. It re-fetches authenticated App identity, repository installation/permissions, repository ID, run/PR association, open PR base/head and exact commit tree before verification, immediately before POST and after an independent authenticated check readback. POST and GET check responses must both match check ID, App, exact SHA, name, completed success and the host-derived external attempt ID. Integration commits and merge groups remain unavailable until an authenticated current integration/queue identity source is implemented. The [workflow run API](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run), [PR API](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) and [Checks API](https://docs.github.com/en/rest/checks/runs#create-a-check-run) provide the identities used here. The payload's SHA, name, success conclusion and summary are host-derived; no candidate output, annotations, URLs or actions are copied.

The publisher serializes calls and remembers at most 1,024 attempted run/SHA publications within its process. It consumes an attempt before POST, so unknown acknowledgement cannot automatically retry. This is **not durable replay/supersession storage**; cross-process restart recovery, run-attempt authorization and reconciliation of ambiguous POST acknowledgements still need an operator-owned transactional store. A PR may change between GitHub reads and POST; a check remains pinned to the old exact SHA, and the final recheck returns unavailable. GitHub provides no atomic PR-head predicate for creating a check. Never interpret that unavailable return as proof that no old-SHA check was created.

All results retain `gate_enforced:false` and `merge_authorized:false`. Successful mocked publication is developer evidence only. Existing required security checks are not replaced. Operator install, independently trusted gateway/supervisor, durable state, merge-queue support, app-bound branch enforcement and an actual malicious PR rejected remain pending. Tests use injected fetch and newly generated ephemeral RSA keys; no live GitHub request, publisher POST or production credential was used.

The closed candidate and observation bindings require a positive safe-integer
`run_attempt`. Local synthetic harnesses explicitly use attempt1; they do not
infer a remote attempt. The publisher reads both the current run and GitHub's
[exact attempt endpoint](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt),
checking run ID, attempt, repository, event, head and PR before verification,
before POST and after independent check readback. Stale attempts or reruns
remain unavailable. Replay keys and check external IDs include the attempt.
An unknown POST acknowledgement blocks automatic retry of that same attempt;
a new authenticated attempt must obtain fresh matching verifier evidence.
This replay guard remains process-local, not restart-durable. Installed callback
composition, durable delivery/decision storage, queue publishing, baseline
approval and external required-check enforcement remain uninstalled.

Publisher `run_id` is a canonical positive decimal string representing a safe
integer (no leading zero, exponent, sign or fraction). Authenticated GitHub run
IDs remain positive numeric values and must stringify exactly to this binding.
This composes with the real host evidence validator's string identity contract;
neutral local harness run IDs remain unchanged. This does not install a callback.

`createSignedSupervisorPublisher` in `github-supervisor-publisher.mjs` composes
the existing publisher with `runHostVerification`. The operator supplies
`{adapterConfig,publisherConfig}` and fixed authenticated request closures plus
`supervisor(binding)`. The supervisor returns only `{jobEnvelope,observationsEnvelope}`
purpose-signed bytes (at most2MiB each), never a verdict/report. Configuration
is copied before asynchronous work and repository/App/check identity must match.
The real adapter authenticates envelopes, installs the externally pinned verifier
and validates actual Git graph/policy/suite evidence. Its report passes unchanged
to the existing publisher, which independently checks exact binding and current
GitHub state. Missing or mismatched evidence cannot publish.

Focused synthetic acceptance uses real signatures, a pinned copied verifier and
actual bare Git objects, with mocked GitHub requests; it is not installed host
authority. No webhook receiver, supervisor execution service, App provisioning,
approved baseline delivery, durable replay or required-check enforcement is
installed by this library. Gate and merge authority remain false.
