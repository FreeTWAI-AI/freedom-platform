# Native CLI isolation on the Ubuntu 24.04 CI runner

The failed `f7b47f9` run 37166738612 installed bubblewrap 0.9.0 but failed
before the runtime suite: `loopback: Failed RTM_NEWADDR: Operation not permitted`.
This is consistent with Ubuntu's restriction on capabilities in unprivileged
user namespaces; the original log did not record its loaded AppArmor profiles,
so it does not independently prove the exact missing-profile state.
[Ubuntu documents selective user-namespace policy and the purpose-built bwrap profile](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007).

The prerequisite installs `apparmor-profiles` and loads only its unchanged
`/usr/share/apparmor/extra-profiles/bwrap-userns-restrict` profile. That extra
profile is disabled by default. In the inspected official Noble package
`4.0.1really4.0.1-0ubuntu0.24.04.9`, it is present in `apparmor-profiles` and
absent from the main `apparmor` package. The shipped parent permits bwrap's
namespace setup and stacks the capability-denying `unpriv_bwrap` child;
it does not use an unrestricted application shell profile.
[Upstream profile source](https://gitlab.com/apparmor/apparmor/-/blob/v4.0.1/profiles/apparmor/profiles/extras/bwrap-userns-restrict).

The helper admits policy loading only on a non-root GitHub-hosted Ubuntu 24.04
runner with AppArmor enabled and userns restriction still 1. It checks package
ownership/checksum, exact parsed profile names, competing attachments and local
overrides, then requires both profiles loaded in enforcement mode. Only
`apparmor_parser` and reading kernel profile state use sudo. The actual
bubblewrap invocation remains the original user, retains `--unshare-all`, and
checks separate user/network/mount/PID/IPC/UTS namespaces, zero child effective
capabilities, `NoNewPrivs=1` and the capability-denying child label. Any failure
fails CI; no global sysctl/profile disable, root provider execution, host network,
model sandbox change, test skip or increased time budget is introduced.
[Bubblewrap explains that its arguments define the sandbox boundary](https://github.com/containers/bubblewrap/blob/main/README.md).
[GitHub documents the hosted-runner guard variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables).

`bash scripts/ci/verify-native-cli-prerequisites.sh --probe-only` performs only
unprivileged readback and never changes policy. Local evidence is Ubuntu 26.04
with its already installed AppArmor 5.0.2/bubblewrap 0.11.1 profile; it proves
that readback and the unchanged native probe cases there, not Noble CI. The
extracted official Noble AppArmor 4.0.1 parser also compiles its shipped extra
profile with `--skip-kernel-load --skip-cache`; this validates syntax without
loading it or changing local policy. Only a new real GitHub run can establish
that the prerequisite and complete zero-skip suite pass on the target runner.
