# Adds the administrator account to the Incus administration group, which is
# root-equivalent authority over the Incus socket. It only appends the group to
# an existing non-root account (usermod -aG keeps other memberships) and never
# creates a group or edits socket permissions or SSH configuration. The change
# applies to new logins only.
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
