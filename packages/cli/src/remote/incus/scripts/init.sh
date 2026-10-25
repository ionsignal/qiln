# Initializes Incus from the approved preseed. The preseed arrives as base64
# with its expected SHA-256 and is verified after decoding. Initialization is not
# an atomic transaction and merges into existing state, so the script refuses
# before any effect unless Incus has no storage pool and no instance, and the
# recorded ZFS pool is still imported with the approved GUID. Any Incus failure
# is reported as 100 so it can never read as a refusal. Exit codes 20 to 99 mean
# nothing was changed.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin:/opt/incus/bin
export PATH
exec 2>/dev/null

test $# -eq 4 || exit 20
data=$1
sha=$2
pool=$3
guid=$4
case $sha in '' | *[!0-9a-f]*) exit 20 ;; esac
test ${#sha} -eq 64 || exit 20
case $pool in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $guid in '' | *[!0-9]*) exit 20 ;; esac
command -v incus >/dev/null || exit 21

tmp=$(mktemp) || exit 26
conf=$(mktemp -d) || { rm -f "$tmp"; exit 26; }
trap 'rm -rf "$tmp" "$conf"' EXIT

printf '%s' "$data" | base64 -d > "$tmp" || exit 22
actual=$(sha256sum "$tmp") || exit 22
test "${actual%% *}" = "$sha" || exit 22

# A fixed client environment, so no operator configuration or remote is used.
INCUS_DIR=/var/lib/incus
INCUS_CONF=$conf
export INCUS_DIR INCUS_CONF
unset INCUS_REMOTE INCUS_PROJECT INCUS_GLOBAL_CONF

systemctl is-active --quiet incus.socket || systemctl is-active --quiet incus.service || exit 23
pools=$(incus --force-local --project default storage list --format csv) || exit 27
test -z "$pools" || exit 24
instances=$(incus --force-local list --all-projects --format csv) || exit 27
test -z "$instances" || exit 25

# Checked last, so nothing can export the pool between this check and the effect.
imported=$(zpool list -H -o name,guid) || exit 28
printf '%s\n' "$imported" | awk -v pool="$pool" -v guid="$guid" '$1 == pool && $2 == guid { found = 1 } END { exit !found }' || exit 28

incus --force-local admin init --preseed < "$tmp" || exit 100
exit 0
