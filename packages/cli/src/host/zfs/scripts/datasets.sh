# Creates the approved Incus datasets on a freshly created, bare pool. The state
# dataset gets an explicit mountpoint and canmount=noauto, so nothing mounts it
# automatically and only the separate mount step can. The storage dataset is
# left unmounted for Incus to manage. It refuses before any effect unless the
# pool is imported and holds no dataset besides its root. Exit codes 20 to 99
# mean nothing was changed. A failed create is reported as 100, because it may
# have changed the host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test $# -eq 4 || exit 20
pool=$1
state_leaf=$2
incus_leaf=$3
mountpoint=$4
case $pool in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $state_leaf in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $incus_leaf in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $mountpoint in /*) ;; *) exit 20 ;; esac

test -d /sys/module/zfs && command -v zfs >/dev/null || exit 21
zpool list -H -o name | grep -Fxq "$pool" || exit 22
datasets=$(zfs list -H -r -o name "$pool") || exit 23
test "$datasets" = "$pool" || exit 23

zfs create -o mountpoint="$mountpoint" -o canmount=noauto "$pool/$state_leaf" || exit 100
zfs create -o mountpoint=none "$pool/$incus_leaf" || exit 100
exit 0
