# Mounts or unmounts the approved Incus state dataset, never with force. Both
# modes refuse before any effect unless the pool is imported with the approved
# GUID and the dataset has the approved GUID, a local mountpoint, and a local
# canmount=noauto. Mounting also refuses when anything is already mounted at the
# state directory, and unmounting refuses when the dataset is not mounted or
# another filesystem is mounted beneath it. GUIDs are decimal strings that awk
# could otherwise compare as doubles, so the pool comparison concatenates an
# empty string to force an exact text comparison. Exit codes 20 to 99 mean
# nothing was changed. A failed mount or unmount is reported as 100, because it
# may have changed the host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test $# -eq 6 || exit 20
mode=$1
pool=$2
guid=$3
leaf=$4
dataset_guid=$5
mountpoint=$6
case $mode in mount | unmount) ;; *) exit 20 ;; esac
case $pool in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $guid in '' | *[!0-9]*) exit 20 ;; esac
case $leaf in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $dataset_guid in '' | *[!0-9]*) exit 20 ;; esac
case $mountpoint in /*) ;; *) exit 20 ;; esac
dataset=$pool/$leaf

test -d /sys/module/zfs && command -v zfs >/dev/null && command -v findmnt >/dev/null || exit 21
imported=$(zpool list -H -o name,guid) || exit 21
printf '%s\n' "$imported" | awk -v pool="$pool" -v guid="$guid" '($1 "") == (pool "") && ($2 "") == (guid "") { found = 1 } END { exit !found }' || exit 22

props=$(zfs get -H -p -o property,value,source guid,type,mountpoint,canmount,mounted "$dataset") || exit 23

value() {
  printf '%s\n' "$props" | awk -F'\t' -v property="$1" '$1 == property { print $2 }'
}

origin() {
  printf '%s\n' "$props" | awk -F'\t' -v property="$1" '$1 == property { print $3 }'
}

test "$(value guid)" = "$dataset_guid" || exit 23
test "$(value type)" = filesystem || exit 23
test "$(value mountpoint)" = "$mountpoint" && test "$(origin mountpoint)" = local || exit 24
test "$(value canmount)" = noauto && test "$(origin canmount)" = local || exit 24

if test "$mode" = mount; then
  test "$(value mounted)" = yes && exit 0
  findmnt --kernel --noheadings --mountpoint "$mountpoint" >/dev/null && exit 25
  zfs mount "$dataset" || exit 100
  exit 0
fi

test "$(value mounted)" = yes || exit 26
if awk -v state="$mountpoint" 'index($5, state "/") == 1 { found = 1 } END { exit !found }' /proc/self/mountinfo; then
  exit 27
fi
zfs unmount "$dataset" || exit 100
exit 0
