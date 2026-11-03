# Closes the host to Incus activation before any package can start the daemon:
# masks every Incus unit persistently and installs the sysctl override that
# keeps the AppArmor restriction enabled, because the package's own sysctl file
# weakens it and its install script applies that file. The override arrives as
# base64 with its expected SHA-256, verified after decoding; an existing file
# must already hold exactly those bytes and is never overwritten. Needs neither
# the pool nor the state mount. A unit that is not positively inactive is
# refused, because a mask does not stop it and an unreadable state is not
# evidence of inactivity.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test $# -ge 4 || exit 20
file=$1
data=$2
sha=$3
shift 3
case $file in /*) ;; *) exit 20 ;; esac
case $sha in '' | *[!0-9a-f]*) exit 20 ;; esac
test ${#sha} -eq 64 || exit 20
for unit in "$@"; do
  case $unit in '' | *[!a-z0-9@._-]*) exit 20 ;; esac
done
for unit in "$@"; do
  test "$(systemctl is-active "$unit")" = inactive || exit 21
done

staged=
trap 'rm -f $staged' EXIT

if test -e "$file" || test -L "$file"; then
  test ! -L "$file" && test -f "$file" || exit 22
  actual=$(sha256sum "$file") || exit 22
  test "${actual%% *}" = "$sha" || exit 22
else
  test -d "$(dirname "$file")" || exit 23
  staged=$(mktemp "$file.XXXXXX") || exit 23
  printf '%s' "$data" | base64 -d > "$staged" || exit 24
  actual=$(sha256sum "$staged") || exit 24
  test "${actual%% *}" = "$sha" || exit 24
  chmod 644 "$staged" || exit 23
  ln "$staged" "$file" || exit 100
fi

systemctl mask "$@" || exit 100
exit 0
