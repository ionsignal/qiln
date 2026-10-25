# Initializes Incus from the approved preseed. The preseed arrives as base64
# with its expected SHA-256 and is verified after decoding. Initialization is not
# an atomic transaction and merges into existing state, so the script refuses
# before any effect unless Incus is pristine: no server configuration, no extra
# project, profile content, storage pool, managed network, instance, or image,
# no TCP listener, no host route in the bridge subnet, and the recorded ZFS pool
# is still imported with the approved GUID and no datasets. These repeat the
# planning conditions just before the effect and cannot exclude a concurrent
# administrator. Any Incus failure is reported as 100 so it can never read as a
# refusal. Exit codes 20 to 99 mean nothing was changed.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin:/opt/incus/bin
export PATH
exec 2>/dev/null

test $# -eq 6 || exit 20
data=$1
sha=$2
pool=$3
guid=$4
bridge=$5
subnet=$6
case $sha in '' | *[!0-9a-f]*) exit 20 ;; esac
test ${#sha} -eq 64 || exit 20
case $pool in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $guid in '' | *[!0-9]*) exit 20 ;; esac
case $bridge in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $subnet in '' | *[!0-9./]*) exit 20 ;; esac
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

# The number of non-empty lines in a listing.
rows() {
  printf '%s\n' "$1" | awk 'NF > 0 { n++ } END { print n + 0 }'
}

# Every listing is captured first, so a failed command is never mistaken for an
# empty result.
systemctl is-active --quiet incus.socket || systemctl is-active --quiet incus.service || exit 23
server=$(incus --force-local query /1.0) || exit 27
config=$(incus --force-local config show) || exit 27
test "$config" = 'config: {}' || exit 29
printf '%s\n' "$server" | grep -q '"storage_zfs_export"' || exit 30
projects=$(incus --force-local project list --format csv) || exit 27
profiles=$(incus --force-local --project default profile list --format csv) || exit 27
devices=$(incus --force-local --project default profile device list default) || exit 27
test "$(rows "$projects")" -eq 1 && test "$(rows "$profiles")" -eq 1 && test -z "$devices" || exit 31
pools=$(incus --force-local --project default storage list --format csv) || exit 27
test -z "$pools" || exit 24
networks=$(incus --force-local --project default network list --format csv) || exit 27
printf '%s\n' "$networks" | awk -F, '$3 == "YES" { found = 1 } END { exit found }' || exit 32
ip link show "$bridge" >/dev/null && exit 32
instances=$(incus --force-local list --all-projects --format csv) || exit 27
test -z "$instances" || exit 25
images=$(incus --force-local --project default image list --format csv) || exit 27
test -z "$images" || exit 33

sockets=$(ss -H -ltnp) || exit 27
printf '%s\n' "$sockets" | awk '/"incusd"/ { found = 1 } END { exit found }' || exit 34
for query in root match; do
  routes=$(ip -4 route show table all "$query" "$subnet") || exit 27
  printf '%s\n' "$routes" | awk '$1 != "default" && NF > 0 { found = 1 } END { exit found }' || exit 36
done

# Checked last, so nothing can export the pool between this check and the effect.
imported=$(zpool list -H -o name,guid) || exit 28
printf '%s\n' "$imported" | awk -v pool="$pool" -v guid="$guid" '$1 == pool && $2 == guid { found = 1 } END { exit !found }' || exit 28
datasets=$(zfs list -H -r -o name "$pool") || exit 28
test "$datasets" = "$pool" || exit 35

incus --force-local admin init --preseed < "$tmp" || exit 100
exit 0
