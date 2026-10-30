# Installs the storage-identity guard: the expectation file that names the
# recorded pool and state dataset, the startup check, and the service drop-in
# that runs that check before the daemon service starts. Each file arrives as
# base64 with its expected SHA-256 and is verified after decoding. A file that
# already exists must be a regular file holding exactly the approved bytes and
# is left alone, and nothing is ever overwritten. Masking is a separate step.
# Exit codes 20 to 99 mean nothing was changed. A failed effect is reported as
# 100, because it may have changed the host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test $# -eq 9 || exit 20
expect_file=$1
expect_data=$2
expect_sha=$3
check_file=$4
check_data=$5
check_sha=$6
dropin_file=$7
dropin_data=$8
dropin_sha=$9
for path in "$expect_file" "$check_file" "$dropin_file"; do
  case $path in /*) ;; *) exit 20 ;; esac
done
for sha in "$expect_sha" "$check_sha" "$dropin_sha"; do
  case $sha in '' | *[!0-9a-f]*) exit 20 ;; esac
  test ${#sha} -eq 64 || exit 20
done

stage_dir=$(mktemp -d) || exit 21
trap 'rm -rf "$stage_dir"' EXIT

# Succeeds when the destination already holds the approved bytes, fails when it
# is absent, and refuses when anything else occupies it.
present() {
  if test -e "$1" || test -L "$1"; then
    test ! -L "$1" && test -f "$1" || exit 23
    actual=$(sha256sum "$1") || exit 23
    test "${actual%% *}" = "$2" || exit 23
    return 0
  fi
  return 1
}

# Decodes one file into the private stage and checks it against its digest.
stage() {
  printf '%s' "$2" | base64 -d > "$stage_dir/$1" || exit 22
  actual=$(sha256sum "$stage_dir/$1") || exit 22
  test "${actual%% *}" = "$3" || exit 22
}

# Installs one staged file. The destination was observed absent just before.
place() {
  install -d -m 755 "$(dirname "$3")" || exit 100
  install -m "$2" "$stage_dir/$1" "$3" || exit 100
}

expect_present=no
check_present=no
dropin_present=no
present "$expect_file" "$expect_sha" && expect_present=yes
present "$check_file" "$check_sha" && check_present=yes
present "$dropin_file" "$dropin_sha" && dropin_present=yes

test "$expect_present" = yes || stage expect "$expect_data" "$expect_sha"
test "$check_present" = yes || stage check "$check_data" "$check_sha"
test "$dropin_present" = yes || stage dropin "$dropin_data" "$dropin_sha"

# The check lands first, so the drop-in never names a check that is missing.
test "$check_present" = yes || place check 755 "$check_file"
test "$expect_present" = yes || place expect 644 "$expect_file"
test "$dropin_present" = yes || place dropin 644 "$dropin_file"
systemctl daemon-reload || exit 100
exit 0
