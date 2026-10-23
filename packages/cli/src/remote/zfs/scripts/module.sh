# Loads the Ubuntu-packaged ZFS kernel module. An already loaded module is a
# successful no-op. Exit code 20 means nothing was changed. A failed load is
# reported as 100, because it may have changed the host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test -d /sys/module/zfs && exit 0
modinfo -F filename zfs >/dev/null || exit 20
modprobe zfs || exit 100
exit 0
