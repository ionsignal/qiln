# Adds the recorded administrator account to the Incus administration group.
# Membership gives root-equivalent access to the Incus Unix socket, so the
# script only adds a group to an existing non-root account with usermod -aG,
# which keeps every other membership. It never creates a group, edits socket
# permissions, or changes SSH configuration. A membership change applies to
# new logins only. Exit codes 20 to 99 mean nothing was changed. A failed
# usermod is reported as 100, because it may have changed the host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test $# -eq 2 || exit 20
account=$1
group=$2
case $account in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $group in '' | *[!a-z0-9_-]*) exit 20 ;; esac
getent group "$group" >/dev/null || exit 21
uid=$(id -u "$account") || exit 22
test "$uid" -ne 0 || exit 23

usermod -aG "$group" "$account" || exit 100
exit 0
