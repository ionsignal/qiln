# Imports the recorded pool by GUID from the approved ZFS member partition,
# without mounting, forcing, or renaming. Whole-disk creation puts the pool
# labels on that partition, so discovery never looks at the parent disk. An
# already imported pool with the exact name and GUID is a successful no-op. The
# parent volume serial and the single-member partition are re-checked just
# before the effect. GUIDs are decimal strings that awk could otherwise compare
# as doubles, so every identity comparison concatenates an empty string to force
# an exact text comparison. Exit codes 20 to 99 mean nothing was changed. A
# failed import is reported as 100, because it may have changed the host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test $# -eq 5 || exit 20
pool=$1
guid=$2
dev=$3
volume=$4
member=$5
case $pool in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $guid in '' | *[!0-9]*) exit 20 ;; esac
case $dev in /dev/*) ;; *) exit 20 ;; esac
case $member in /dev/*) ;; *) exit 20 ;; esac
case $volume in vol-*) ;; *) exit 20 ;; esac

test -d /sys/module/zfs && command -v zpool >/dev/null || exit 21
imported=$(zpool list -H -o name,guid) || exit 21
if printf '%s\n' "$imported" | awk -v pool="$pool" -v guid="$guid" '($1 "") == (pool "") && ($2 "") == (guid "") { found = 1 } END { exit !found }'; then
  exit 0
fi
if printf '%s\n' "$imported" | awk -v pool="$pool" -v guid="$guid" '($1 "") == (pool "") || ($2 "") == (guid "") { found = 1 } END { exit !found }'; then
  exit 24
fi

test -b "$dev" || exit 25
serial=$(lsblk --nodeps --noheadings --output SERIAL "$dev") || exit 25
serial=$(printf '%s' "$serial" | tr -d '[:space:]')
serial=${serial#vol}
serial=${serial#-}
test -n "$serial" && test "$serial" = "${volume#vol-}" || exit 25

children=$(lsblk --noheadings --paths --list --output NAME,TYPE,FSTYPE "$dev") || exit 26
printf '%s\n' "$children" | awk -v member="$member" '$2 == "part" && $3 == "zfs_member" { total++; if ($1 == member) named++ } END { exit !(total == 1 && named == 1) }' || exit 26

listing=$(zpool import -d "$member") || exit 22
found=$(printf '%s\n' "$listing" | awk -v guid="$guid" '$1 == "pool:" { name = $2 } $1 == "id:" && ($2 "") == (guid "") { print name }')
test -n "$found" || exit 22
test "$found" = "$pool" || exit 23

zpool import -N -o cachefile=none -d "$member" "$guid" || exit 100
exit 0
