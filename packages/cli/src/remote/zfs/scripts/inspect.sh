# Fixed read-only inspection. Every section reports its own status, so a
# missing capability is distinguishable from an empty result. Nothing here
# installs, loads, imports, or writes anything.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
DEBIAN_FRONTEND=noninteractive
export DEBIAN_FRONTEND
exec 2>/dev/null

# Arguments: the pool name to report on, the owned ARC file, the direct
# packages, `--`, then extra packages whose installed state is reported but
# never simulated.
POOL=$1
ARC_FILE=$2
shift 2
PACKAGES=
while test $# -gt 0 && test "$1" != --; do
  PACKAGES="$PACKAGES $1"
  shift
done
test $# -eq 0 || shift
EXTRA=$*

section() {
  printf '#qiln:begin %s\n' "$1"
  "$2"
  code=$?
  printf '#qiln:end %s %s\n' "$1" "$code"
}

system_info() {
  printf 'kernel %s\n' "$(uname -r)"
  printf 'machine %s\n' "$(uname -m)"
  printf 'packageArchitecture %s\n' "$(dpkg --print-architecture)"
  awk '$1 == "MemTotal:" { print "memTotalKiB " $2 }' /proc/meminfo
  if test -e /run/reboot-required; then
    echo 'rebootRequired yes'
  else
    echo 'rebootRequired no'
  fi
}

module_info() {
  filename=$(modinfo -F filename zfs) || return 1
  version=$(modinfo -F version zfs) || return 1
  vermagic=$(modinfo -F vermagic zfs) || return 1
  owner=$(dpkg-query -S "$(readlink -f "$filename")" | head -n 1)
  printf 'filename %s\n' "$filename"
  printf 'version %s\n' "$version"
  printf 'vermagic %s\n' "$vermagic"
  printf 'package %s\n' "${owner%%:*}"
  if test -d /sys/module/zfs; then
    echo 'loaded yes'
  else
    echo 'loaded no'
  fi
}

package_info() {
  dpkg-query -W -f='${Package} ${Version} ${Architecture} ${db:Status-Status}\n' $PACKAGES $EXTRA
  return 0
}

# A simulation only: it resolves against the current package lists, never
# refreshes them, and never changes the host.
simulation_info() {
  need=
  for name in $PACKAGES; do
    state=$(dpkg-query -W -f='${db:Status-Status}' "$name")
    test "$state" = installed || need="$need $name"
  done
  test -n "$need" || return 0
  apt-get --simulate --no-install-recommends install $need
}

disk_info() {
  lsblk --json --bytes --paths --exclude 7 --output NAME,TYPE,SIZE,SERIAL,MODEL,LOG-SEC,PHY-SEC,FSTYPE,MOUNTPOINTS
}

# The disk listing is captured first, so a failed lsblk fails the section
# instead of vanishing inside the pipeline.
signature_info() {
  disks=$(lsblk --nodeps --noheadings --paths --exclude 7 --output NAME,TYPE) || return 1
  printf '%s\n' "$disks" | while read -r name type; do
    test "$type" = disk || continue
    out=$(blkid --probe --output export "$name")
    code=$?
    printf '%s\n' "$out" | while IFS= read -r line; do
      test -n "$line" && printf '%s %s\n' "$name" "$line"
    done
    printf '%s #exit %s\n' "$name" "$code"
  done
  return 0
}

arc_info() {
  if test -f "$ARC_FILE"; then
    echo 'owned-present yes'
    while IFS= read -r line || test -n "$line"; do
      printf 'owned-line %s\n' "$line"
    done < "$ARC_FILE"
  else
    echo 'owned-present no'
  fi
  for file in /etc/modprobe.d/*.conf /usr/lib/modprobe.d/*.conf /run/modprobe.d/*.conf; do
    test -f "$file" || continue
    test "$file" = "$ARC_FILE" && continue
    grep -E -H '^[[:space:]]*(options[[:space:]]+zfs[[:space:]].*zfs_arc_(max|min)|install[[:space:]]+(zfs|spl)([[:space:]]|$))' "$file" | while IFS= read -r line; do
      printf 'conflict %s\n' "$line"
    done
  done
  tr ' ' '\n' < /proc/cmdline | grep -E '^zfs\.zfs_arc_(max|min)=' | while IFS= read -r token; do
    printf 'cmdline %s\n' "$token"
  done
  if test -r /sys/module/zfs/parameters/zfs_arc_max; then
    printf 'running-max %s\n' "$(cat /sys/module/zfs/parameters/zfs_arc_max)"
    printf 'running-min %s\n' "$(cat /sys/module/zfs/parameters/zfs_arc_min)"
  fi
  return 0
}

pool_info() {
  if ! command -v zpool >/dev/null; then
    echo 'tools no'
    return 0
  fi
  echo 'tools yes'
  if ! test -d /sys/module/zfs; then
    echo 'loaded no'
    return 0
  fi
  echo 'loaded yes'
  pools=$(zpool list -H -o name,guid) || return 1
  printf '%s\n' "$pools" | awk 'NF == 2 { print "pool " $1 " " $2 }'
}

# Whether the pool named by the first argument is imported. Detail sections are
# empty when it is not, and fail when it is imported but cannot be read.
pool_imported() {
  test -n "$POOL" && command -v zpool >/dev/null && test -d /sys/module/zfs && zpool list -H -o name "$POOL" >/dev/null
}

status_info() {
  pool_imported || return 0
  zpool status -j -L -P -p "$POOL"
}

property_info() {
  pool_imported || return 0
  out=$(zpool get -H -p -o property,value autotrim,cachefile,health "$POOL") || return 1
  printf '%s\n' "$out" | awk -F'\t' 'NF == 2 { print "pool " $1 " " $2 }'
  out=$(zfs get -H -p -o property,value compression,acltype,xattr,atime,mountpoint "$POOL") || return 1
  printf '%s\n' "$out" | awk -F'\t' 'NF == 2 { print "dataset " $1 " " $2 }'
  out=$(zpool get -H -p -o name,property,value ashift "$POOL" all-vdevs) || return 1
  printf '%s\n' "$out" | awk -F'\t' '$2 == "ashift" { print "ashift " $3 }'
}

timer_info() {
  test -n "$POOL" || return 0
  state=$(systemctl is-enabled "zfs-scrub-monthly@$POOL.timer")
  printf 'state %s\n' "${state:-unknown}"
  return 0
}

unit_info() {
  unit_files=$(systemctl list-unit-files --no-legend --no-pager) || return 1
  printf '%s\n' "$unit_files" | awk '$1 ~ /^zfs/'
}

section system system_info
section module module_info
section packages package_info
section simulation simulation_info
section disks disk_info
section signatures signature_info
section arc arc_info
section pools pool_info
section poolstatus status_info
section poolprops property_info
section timer timer_info
section units unit_info
exit 0
