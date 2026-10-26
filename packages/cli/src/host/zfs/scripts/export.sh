# Cleanly exports the recorded pool, without force. It refuses before any effect
# unless the pool is imported with the approved GUID, nothing is mounted, and no
# scrub or resilver is running. Exit codes 20 to 99 mean nothing was changed. A
# failed disable or export is reported as 100, because it may have changed the
# host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test $# -eq 2 || exit 20
pool=$1
guid=$2
case $pool in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $guid in '' | *[!0-9]*) exit 20 ;; esac

test -d /sys/module/zfs && command -v zpool >/dev/null || exit 21
imported=$(zpool list -H -o name,guid) || exit 21
printf '%s\n' "$imported" | awk -v pool="$pool" '$1 == pool { found = 1 } END { exit !found }' || exit 22
printf '%s\n' "$imported" | awk -v pool="$pool" -v guid="$guid" '$1 == pool && $2 == guid { found = 1 } END { exit !found }' || exit 23

mounted=$(zfs list -H -r -o mounted "$pool") || exit 24
if printf '%s\n' "$mounted" | grep -Fxq yes; then
  exit 24
fi

status=$(zpool status "$pool") || exit 25
if printf '%s\n' "$status" | grep -Eq 'scan:.*(scrub|resilver) in progress'; then
  exit 25
fi
if systemctl is-active --quiet "zfs-scrub@$pool.service"; then
  exit 25
fi

systemctl disable --now "zfs-scrub-monthly@$pool.timer" || exit 100
zpool export "$pool" || exit 100
exit 0
