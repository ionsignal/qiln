# Closes the host to Incus activation before any package can start the daemon.
# It masks every Incus unit persistently, so package scripts that honor masks
# neither enable nor start them. It also installs the Qiln sysctl override that
# keeps the AppArmor restriction enabled, because the package's own sysctl file
# weakens it and the package script applies that file when it installs. The
# override arrives as base64 with its expected SHA-256 and is verified after
# decoding. An existing file must be a regular file holding exactly the approved
# bytes and is left alone, and nothing is ever overwritten. It needs neither the
# pool nor the state mount. A unit that is already active is refused, because a
# mask does not stop it. Exit codes 20 to 99 mean nothing was changed. A failed
# effect is reported as 100, because it may have changed the host.
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
  case $(systemctl is-active "$unit") in
  active | activating | reloading) exit 21 ;;
  esac
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
