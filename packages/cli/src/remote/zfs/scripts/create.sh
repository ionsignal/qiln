# Creates the approved single-disk pool on the approved device. The volume serial
# and blankness are re-checked just before the effect, and nothing is forced.
# Exit codes 20 to 99 mean nothing was changed. A failed create is reported as
# 100, because it may have changed the host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test $# -eq 11 || exit 20
pool=$1
dev=$2
volume=$3
ashift=$4
autotrim=$5
compression=$6
atime=$7
acltype=$8
xattr=$9
shift 9
mountpoint=$1
cachefile=$2
case $pool in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $ashift in '' | *[!0-9]*) exit 20 ;; esac
case $dev in /dev/*) ;; *) exit 20 ;; esac
case $volume in vol-*) ;; *) exit 20 ;; esac

test -b "$dev" || exit 21
test -d /sys/module/zfs && command -v zpool >/dev/null || exit 21

serial=$(lsblk --nodeps --noheadings --output SERIAL "$dev") || exit 22
serial=$(printf '%s' "$serial" | tr -d '[:space:]')
serial=${serial#vol}
serial=${serial#-}
test -n "$serial" && test "$serial" = "${volume#vol-}" || exit 22

test "$(lsblk --noheadings --output NAME "$dev" | wc -l)" -eq 1 || exit 23
if lsblk --noheadings --output MOUNTPOINTS "$dev" | grep -q '[^[:space:]]'; then
  exit 23
fi
blkid --probe --output export "$dev" >/dev/null
test $? -eq 2 || exit 23

if zpool list -H -o name | grep -Fxq "$pool"; then
  exit 24
fi

zpool create \
  -o ashift="$ashift" -o autotrim="$autotrim" -o cachefile="$cachefile" \
  -O compression="$compression" -O acltype="$acltype" -O xattr="$xattr" -O atime="$atime" \
  -m "$mountpoint" "$pool" "$dev" || exit 100
exit 0
