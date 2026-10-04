#!/usr/bin/env bash
set -euo pipefail
trap 'printf "Native CLI prerequisites failed at line %s; no privilege or skip fallback is permitted.\n" "$LINENO" >&2' ERR

# Only policy installation is privileged. Every namespace/provider probe runs
# as the original non-root runner. --probe-only never changes system policy.
if [[ ${1:-} != --probe-only ]]; then
  [[ $# == 0 && ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
  [[ $(id -u) != 0 ]]
  source /etc/os-release
  [[ $ID == ubuntu && $VERSION_ID == 24.04 ]]
  [[ $(cat /sys/module/apparmor/parameters/enabled) == Y ]]
  [[ $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns) == 1 ]]
  profile=/usr/share/apparmor/extra-profiles/bwrap-userns-restrict
  [[ -f $profile && ! -L $profile ]]
  [[ $(stat -c '%u:%a' "$profile") == 0:644 ]]
  [[ $(dpkg-query -S "$profile") == "apparmor-profiles: $profile" ]]
  # Check this exact package file, not a caller-provided/custom profile.
  expected=$(awk '$2=="usr/share/apparmor/extra-profiles/bwrap-userns-restrict" {print $1}' /var/lib/dpkg/info/apparmor-profiles.md5sums)
  [[ -n $expected && $(md5sum "$profile" | cut -d ' ' -f 1) == "$expected" ]]
  [[ $(/usr/sbin/apparmor_parser --names "$profile") == $'bwrap\nunpriv_bwrap' ]]
  # Never replace a competing /usr/bin/bwrap attachment or local extensions.
  python3 - <<'PY'
from pathlib import Path
source=Path('/usr/share/apparmor/extra-profiles/bwrap-userns-restrict')
for path in Path('/etc/apparmor.d').iterdir():
    if path.is_file() and '/usr/bin/bwrap' in path.read_text(errors='replace'):
        if path.is_symlink() or path.read_bytes()!=source.read_bytes():
            raise SystemExit('Competing bwrap AppArmor attachment; refusing to override it.')
for name in ('bwrap-userns-restrict','unpriv_bwrap'):
    path=Path('/etc/apparmor.d/local')/name
    if path.exists() and any(line.strip() and not line.lstrip().startswith('#') for line in path.read_text().splitlines()):
        raise SystemExit('Local bwrap AppArmor overrides are not admitted by CI.')
PY
  printf '%s\n' 'runner=github-hosted ubuntu=24.04 apparmor_userns_restriction=1'
  dpkg-query -W -f='${Package} ${Version}\n' apparmor apparmor-profiles bubblewrap
  sha256sum "$profile"
  # Ubuntu's shipped profile permits namespace setup in bwrap, then stacks a
  # capability-denying child profile. No global profile/service/sysctl change.
  sudo /usr/sbin/apparmor_parser --replace --skip-cache "$profile"
  sudo cat /sys/kernel/security/apparmor/profiles | grep -Fx 'bwrap (enforce)'
  sudo cat /sys/kernel/security/apparmor/profiles | grep -Fx 'unpriv_bwrap (enforce)'
  [[ $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns) == 1 ]]
else
  [[ $# == 1 ]]
fi

[[ $(id -u) != 0 ]]
/usr/bin/cc --version
namespaces=()
for name in user net mnt pid ipc uts; do namespaces+=("$(readlink "/proc/self/ns/$name")"); done
# Retain --unshare-all, add a readback that proves every namespace is distinct
# and the launched child has zero effective capabilities. No shared network,
# sudo native execution, privilege fallback, or skip outcome is accepted.
env -i PATH=/usr/bin:/bin /usr/bin/bwrap --unshare-all --new-session --die-with-parent \
  --ro-bind /usr /usr --symlink usr/bin /bin \
  --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --proc /proc --dev /dev /usr/bin/sh -ec '
    for name in user net mnt pid ipc uts; do
      current=$(readlink "/proc/self/ns/$name")
      test "$current" != "$1"
      shift
    done
    grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status
    grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status
    label=$(cat /proc/self/attr/current)
    case "$label" in *unpriv_bwrap*) ;; *) exit 1;; esac
    printf "%s\n" "native_cli_namespace_readback=pass child_effective_capabilities=0"
  ' probe "${namespaces[@]}"
