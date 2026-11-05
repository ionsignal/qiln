# Writes the APT preferences that pin the selected Incus packages to one exact
# version and exclude every other version. The file arrives as base64 with its
# expected SHA-256, verified after decoding. It is staged first and created
# exclusively; an existing file must already hold exactly the approved bytes and
# is never overwritten, which makes a repeat a successful no-op.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test $# -eq 3 || exit 20
file=$1
data=$2
sha=$3
case $file in /*) ;; *) exit 20 ;; esac
case $sha in '' | *[!0-9a-f]*) exit 20 ;; esac
test ${#sha} -eq 64 || exit 20

staged=
trap 'rm -f $staged' EXIT

if test -e "$file" || test -L "$file"; then
  test ! -L "$file" && test -f "$file" || exit 23
  actual=$(sha256sum "$file") || exit 23
  test "${actual%% *}" = "$sha" || exit 23
  exit 0
fi

test -d "$(dirname "$file")" || exit 21
staged=$(mktemp "$file.XXXXXX") || exit 21
printf '%s' "$data" | base64 -d > "$staged" || exit 22
actual=$(sha256sum "$staged") || exit 22
test "${actual%% *}" = "$sha" || exit 22
chmod 644 "$staged" || exit 21
ln "$staged" "$file" || exit 100
exit 0
