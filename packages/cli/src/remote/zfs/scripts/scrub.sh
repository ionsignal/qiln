# Enables the packaged monthly scrub timer for an imported pool. Exit codes 20
# to 99 mean nothing was changed. A failed enable is reported as 100, because it
# may have changed the host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test $# -eq 1 || exit 20
pool=$1
case $pool in '' | *[!a-z0-9_-]*) exit 20 ;; esac

systemctl list-unit-files --no-legend --no-pager 'zfs*' | grep -q '^zfs-scrub-monthly@\.timer ' || exit 21
zpool list -H -o name | grep -Fxq "$pool" || exit 22

systemctl enable --now "zfs-scrub-monthly@$pool.timer" || exit 100
exit 0
