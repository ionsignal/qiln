# Clones the approved commit of the approved repository to the managed path. The
# clone is built in a staging directory beside its destination and renamed into
# place last, so every failure before the rename leaves nothing at the
# destination. An existing path is never overwritten. The repository is reached
# over HTTPS only, with no hooks, templates, prompts, or configuration files
# outside the repository. Exit codes 20 to 99 mean nothing was changed. A failed
# rename is reported as 100, because it may have changed the host.
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

test $# -eq 3 || exit 20
url=$1
commit=$2
path=$3
case $url in https://*) ;; *) exit 20 ;; esac
case $commit in '' | *[!0-9a-f]*) exit 20 ;; esac
test ${#commit} -eq 40 || exit 20
case $path in /*) ;; *) exit 20 ;; esac
command -v git >/dev/null || exit 21

parent=$(dirname "$path")
test -d "$parent" && test -w "$parent" || exit 22
if test -e "$path" || test -L "$path"; then
  exit 23
fi

stage=$(mktemp -d "$path.XXXXXX") || exit 22
trap 'rm -rf "$stage"' EXIT

git init -q --template= "$stage" || exit 24
git -C "$stage" remote add origin "$url" || exit 24
git -C "$stage" fetch -q --depth 1 --no-tags --no-recurse-submodules origin "$commit" || exit 25
git -C "$stage" checkout -q --detach FETCH_HEAD || exit 25
head=$(git -C "$stage" rev-parse --verify -q 'HEAD^{commit}') || exit 25
test "$head" = "$commit" || exit 25
chmod 755 "$stage" || exit 24

mv -T "$stage" "$path" || exit 100
exit 0
