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
  # Noble's stock flags reject bwrap's unlinked readonly-data executable at
  # name lookup. Apply only the reviewed upstream deleted-mediation flags;
  # namespace permissions, px/pix transitions and child capability denial stay.
  compat_directory=$(mktemp -d "${RUNNER_TEMP:?}/fp-bwrap-compat.XXXXXX")
  trap 'rm -rf -- "$compat_directory"' EXIT
  python3 scripts/ci/render-bwrap-deleted-compat.py "$profile" > "$compat_directory/profile"
  [[ $(sha256sum "$compat_directory/profile" | cut -d ' ' -f 1) == a964037f6cf0df1099f14226b037eaedde6237c86e715188e93eb460b30be859 ]]
  [[ $(/usr/sbin/apparmor_parser --names "$compat_directory/profile") == $'bwrap\nunpriv_bwrap' ]]
  /usr/sbin/apparmor_parser --skip-kernel-load --skip-cache "$compat_directory/profile"
  printf '%s\n' 'native_cli_policy=reviewed_flag_only_deleted_mediation stock_source_unchanged=true'
  sudo /usr/sbin/apparmor_parser --replace --skip-cache "$compat_directory/profile"
  rm -rf -- "$compat_directory"
  trap - EXIT
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

# Exercise the real verified, inherited-FD snapshot path before the full suite.
# The fixed helper rejects zero/skipped/incomplete cases and limits time/output.
snapshot_started_epoch=$(date +%s)
if node scripts/ci/native-cli-snapshot-check.mjs; then
  :
else
  snapshot_status=$?
  # Audit only the fixed checkpoint's first 30 seconds. Probe-only never uses
  # sudo; metadata is not permission to change the shipped AppArmor profile.
  if [[ ${1:-} != --probe-only && ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && $(id -u) != 0 ]]; then
    source /etc/os-release
    if [[ $ID == ubuntu && $VERSION_ID == 24.04 && $(cat /sys/module/apparmor/parameters/enabled) == Y && $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns) == 1 ]]; then
      if ! /usr/bin/timeout 5s sudo -n journalctl -k --since "@$snapshot_started_epoch" --until "@$((snapshot_started_epoch+30))" --output=json --no-pager 2>/dev/null | node scripts/ci/native-cli-audit-readback.mjs; then
        printf '%s\n' 'native_cli_audit_readback=unavailable'
      fi
    fi
  fi
  exit "$snapshot_status"
fi
