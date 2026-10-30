# Installs the approved Zabbly signing key, APT source, and package preferences.
# The source and preferences arrive as base64 and the key is downloaded once
# over HTTPS, each with its expected SHA-256 verified before anything is
# installed. A file that already exists must be a regular file holding exactly
# the approved bytes and is left alone, and an approved key already in place is
# never downloaded again. New files are staged and verified first, then created
# exclusively and never overwrite anything. Exit codes 20 to 99 mean nothing
# was changed. A failed install is reported as 100, because it may have changed
# the host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test $# -eq 9 || exit 20
key_file=$1
key_url=$2
key_sha=$3
source_file=$4
source_data=$5
source_sha=$6
preferences_file=$7
preferences_data=$8
preferences_sha=$9
for path in "$key_file" "$source_file" "$preferences_file"; do
  case $path in /*) ;; *) exit 20 ;; esac
done
case $key_url in https://*) ;; *) exit 20 ;; esac
for sha in "$key_sha" "$source_sha" "$preferences_sha"; do
  case $sha in '' | *[!0-9a-f]*) exit 20 ;; esac
  test ${#sha} -eq 64 || exit 20
done

staged_files=
trap 'rm -f $staged_files' EXIT

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

# Sets STAGED to a new temporary file beside the destination.
stage() {
  test -d "$(dirname "$1")" || exit 21
  STAGED=$(mktemp "$1.XXXXXX") || exit 21
  staged_files="$staged_files $STAGED"
}

# One download with no retries and no alternate URL. The bytes that match the
# approved digest are the bytes that get installed.
download_key() {
  command -v curl >/dev/null || exit 24
  curl --disable --fail --show-error --silent --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --max-time 30 --max-filesize 65536 --output "$1" "$key_url" || exit 25
  actual=$(sha256sum "$1") || exit 25
  test "${actual%% *}" = "$key_sha" || exit 26
}

# Conflicts are refused before any network access.
key_present=no
present "$key_file" "$key_sha" && key_present=yes
source_present=no
present "$source_file" "$source_sha" && source_present=yes
preferences_present=no
present "$preferences_file" "$preferences_sha" && preferences_present=yes

key_staged=
if test "$key_present" = no; then
  stage "$key_file"
  key_staged=$STAGED
  download_key "$key_staged"
  chmod 644 "$key_staged" || exit 21
fi
source_staged=
if test "$source_present" = no; then
  stage "$source_file"
  source_staged=$STAGED
  printf '%s' "$source_data" | base64 -d > "$source_staged" || exit 22
  actual=$(sha256sum "$source_staged") || exit 22
  test "${actual%% *}" = "$source_sha" || exit 22
  chmod 644 "$source_staged" || exit 21
fi
preferences_staged=
if test "$preferences_present" = no; then
  stage "$preferences_file"
  preferences_staged=$STAGED
  printf '%s' "$preferences_data" | base64 -d > "$preferences_staged" || exit 22
  actual=$(sha256sum "$preferences_staged") || exit 22
  test "${actual%% *}" = "$preferences_sha" || exit 22
  chmod 644 "$preferences_staged" || exit 21
fi

install_staged() {
  test -n "$1" || return 0
  ln "$1" "$2" || exit 100
}

# The key and preferences land first, so adding the source never precedes them.
install_staged "$key_staged" "$key_file"
install_staged "$preferences_staged" "$preferences_file"
install_staged "$source_staged" "$source_file"
exit 0
