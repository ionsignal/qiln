# Fixed read-only inspection of the target host and, when a path is given, of
# its development checkout. Every section reports its own status. Nothing here
# installs, loads, or writes anything, and no privilege is used. The one
# argument is the checkout path, or an empty string for none.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

CHECKOUT=$1

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
}

# Parsed as data by the caller, never evaluated.
osrelease_info() {
  cat /etc/os-release
}

# Working-tree state is deliberately not inspected: `git status` can run
# repository- or user-configured hooks such as core.fsmonitor, which would
# execute code before any approval. A modified work tree is accepted anyway.
checkout_info() {
  test -n "$CHECKOUT" || return 0
  path=$(cd "$CHECKOUT" && pwd -P) || { echo 'present no'; return 0; }
  echo 'present yes'
  printf 'path %s\n' "$path"
  if top=$(git -C "$path" rev-parse --show-toplevel); then
    printf 'toplevel %s\n' "$top"
    printf 'commit %s\n' "$(git -C "$path" rev-parse --verify -q HEAD)"
  fi
  if test -f "$path/package.json" && ! test -L "$path/package.json"; then
    printf 'packageName %s\n' "$(sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$path/package.json" | head -n 1)"
  fi
  return 0
}

section system system_info
section osrelease osrelease_info
section checkout checkout_info
exit 0
