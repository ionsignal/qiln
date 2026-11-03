# Reports on the managed checkout without changing it: its HEAD commit, whether
# the approved repository is reachable, and whether that HEAD can be fetched
# from the approved repository into a throwaway repository. The fetch is the
# same operation that restores the commit on a replacement host, so it proves
# restorability. The checkout's own remotes, configuration, and refs are never
# consulted, and no working-tree state is read. Exit codes 20 to 99 mean nothing
# was changed.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
GIT_TERMINAL_PROMPT=0
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=/dev/null
GIT_ALLOW_PROTOCOL=https
export GIT_TERMINAL_PROMPT GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL GIT_ALLOW_PROTOCOL
exec 2>/dev/null

test $# -eq 2 || exit 20
path=$1
url=$2
case $path in /*) ;; *) exit 20 ;; esac
case $url in https://*) ;; *) exit 20 ;; esac
command -v git >/dev/null || exit 21

head=$(git -C "$path" rev-parse --verify -q 'HEAD^{commit}') || exit 22
case $head in '' | *[!0-9a-f]*) exit 22 ;; esac
test ${#head} -eq 40 || exit 22

probe=$(mktemp -d) || exit 23
trap 'rm -rf "$probe"' EXIT

echo "head $head"
if git ls-remote "$url" HEAD >/dev/null; then
  echo 'origin yes'
else
  echo 'origin no'
fi
if git init -q --template= "$probe" && git -C "$probe" fetch -q --depth 1 --no-tags --no-recurse-submodules "$url" "$head"; then
  echo 'fetchable yes'
else
  echo 'fetchable no'
fi
exit 0
