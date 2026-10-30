# Opens a closed host to the Incus daemon. It verifies the installed startup
# check against its approved digest and runs it, then checks the state
# directory for the mode it was asked for, then checks the root rows of the
# subordinate-ID files, then unmasks and starts the given units. The `fresh`
# mode requires an empty state directory, so retained Incus state is never
# opened as a fresh installation, and a root range of the minimum size in each
# ID file. The `preserved` mode requires every retained metadata entry to be
# present as a real entry and every recorded root range to be listed exactly,
# and never falls back to a fresh installation. Starting the daemon opens or
# initializes its metadata in the state directory. The ID files are never
# edited. Arguments: the mode, the startup check, its digest, the expectation
# file, the state directory, the minimum root range size, the retained metadata
# entries, `--`, the recorded ranges as `uid|gid:start:count` words, `--`, then
# the units. Exit codes 20 to 99 mean nothing was changed. A failed unmask,
# reload, or start is reported as 100, because it may have changed the host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test $# -ge 10 || exit 20
mode=$1
check_file=$2
check_sha=$3
expectation=$4
mountpoint=$5
minimum=$6
shift 6
case $mode in fresh | preserved) ;; *) exit 20 ;; esac
for path in "$check_file" "$expectation" "$mountpoint"; do
  case $path in /*) ;; *) exit 20 ;; esac
done
case $check_sha in '' | *[!0-9a-f]*) exit 20 ;; esac
test ${#check_sha} -eq 64 || exit 20
case $minimum in '' | *[!0-9]*) exit 20 ;; esac
entries=
while test $# -gt 0 && test "$1" != --; do
  case $1 in '' | /* | *[!A-Za-z0-9._/-]*) exit 20 ;; esac
  entries="$entries $1"
  shift
done
test $# -gt 0 || exit 20
test -n "$entries" || exit 20
shift
ranges=
while test $# -gt 0 && test "$1" != --; do
  case $1 in uid:*:* | gid:*:*) ;; *) exit 20 ;; esac
  case ${1#*:} in '' | *[!0-9:]*) exit 20 ;; esac
  ranges="$ranges $1"
  shift
done
test $# -ge 2 || exit 20
if test "$mode" = preserved; then
  test -n "$ranges" || exit 20
fi
shift
for unit in "$@"; do
  case $unit in '' | *[!a-z0-9@._-]*) exit 20 ;; esac
done

# Succeeds when the ID file lists root with exactly this start and count. The
# values are decimal strings that awk could otherwise compare as numbers, so each
# comparison appends an empty string to force an exact text comparison.
allocated() {
  awk -F: -v start="$2" -v count="$3" '($1 == "root" || $1 == "0") && ($2 "") == (start "") && ($3 "") == (count "") { found = 1 } END { exit !found }' "/etc/sub$1"
}

# Succeeds when the ID file lists a root range of at least this many IDs.
sufficient() {
  awk -F: -v minimum="$2" '($1 == "root" || $1 == "0") && $3 ~ /^[0-9]+$/ && $3 + 0 >= minimum + 0 { found = 1 } END { exit !found }' "/etc/sub$1"
}

test -f "$check_file" && test ! -L "$check_file" && test -x "$check_file" || exit 21
actual=$(sha256sum "$check_file") || exit 22
test "${actual%% *}" = "$check_sha" || exit 22
"$check_file" "$expectation" || exit 23

listing=$(ls -A "$mountpoint") || exit 26
if test "$mode" = fresh; then
  test -z "$listing" || exit 24
  for kind in uid gid; do
    sufficient "$kind" "$minimum" || exit 27
  done
else
  for entry in $entries; do
    test -e "$mountpoint/$entry" && test ! -L "$mountpoint/$entry" || exit 25
  done
  for range in $ranges; do
    kind=${range%%:*}
    rest=${range#*:}
    allocated "$kind" "${rest%%:*}" "${rest#*:}" || exit 28
  done
fi

systemctl unmask "$@" || exit 100
systemctl daemon-reload || exit 100
systemctl start "$@" || exit 100
exit 0
