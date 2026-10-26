# Applies the approved ZFS ARC limit. `write <file> <line>` replaces the
# Qiln-owned modprobe file atomically, and `apply <bytes>` sets the running
# limit. Exit codes 20 to 99 mean nothing was changed. A failed effect is
# reported as 100, because it may have changed the host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

mode=$1
case $mode in
write)
  file=$2
  line=$3
  test -n "$file" && test -n "$line" || exit 20
  test -d "$(dirname "$file")" || exit 21
  if test -e "$file" || test -L "$file"; then
    test ! -L "$file" && test -f "$file" || exit 22
  fi
  umask 022
  tmp=$(mktemp "$file.XXXXXX") || exit 23
  printf '%s\n%s\n' '# Managed by Qiln. Do not edit.' "$line" > "$tmp" || { rm -f "$tmp"; exit 100; }
  chmod 644 "$tmp" || { rm -f "$tmp"; exit 100; }
  mv -f "$tmp" "$file" || { rm -f "$tmp"; exit 100; }
  exit 0
  ;;
apply)
  bytes=$2
  case $bytes in
  '' | *[!0-9]*) exit 20 ;;
  esac
  test -w /sys/module/zfs/parameters/zfs_arc_max || exit 21
  printf '%s\n' "$bytes" > /sys/module/zfs/parameters/zfs_arc_max || exit 100
  exit 0
  ;;
*)
  exit 20
  ;;
esac
