# Moves the Incus package files between the host and the artifacts dataset
# inside one mount window. `capture` copies the staged files onto the dataset.
# `restore` installs the retained files from it. Before anything is mounted it
# refuses unless the recorded pool is imported with the approved GUID, the
# artifacts dataset has the approved GUID, a local mountpoint and a local
# canmount=noauto, and nothing is mounted at it yet. A capture also needs every
# staged file to be a regular file with its approved size and SHA-256, and
# hashes each copy again inside the window. A restore hashes every retained file
# inside the window and installs only from those files: APT runs with its
# package lists emptied and no source, so nothing can be fetched, and it refuses
# unless the simulated transaction installs only retained packages, upgrades
# nothing, removes nothing, and configures nothing outside it. The mountpoint
# directory is created just before the mount, because a missing one is not known
# to be created by the mount itself. The dataset is always unmounted again. From
# that creation on, a failed capture, a failed install, or a failed unmount is
# reported as 100, because it may have changed the host. A restore that fails
# its checks before the install exits with a refusal code, because the clean
# unmount leaves nothing changed. The files arrive as `sha256:size:filename`
# words, never as bytes, and the filenames contain no colon. GUIDs are decimal
# strings that awk could compare as doubles, so the pool comparison concatenates
# an empty string to force a text comparison. Exit codes 20 to 99 mean nothing
# was changed.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
DEBIAN_FRONTEND=noninteractive
export DEBIAN_FRONTEND
exec 2>/dev/null

test $# -ge 7 || exit 20
mode=$1
pool=$2
guid=$3
leaf=$4
dataset_guid=$5
mountpoint=$6
shift 6
case $mode in capture | restore) ;; *) exit 20 ;; esac
case $pool in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $guid in '' | *[!0-9]*) exit 20 ;; esac
case $leaf in '' | *[!a-z0-9_-]*) exit 20 ;; esac
case $dataset_guid in '' | *[!0-9]*) exit 20 ;; esac
case $mountpoint in /*) ;; *) exit 20 ;; esac
stage=
if test "$mode" = capture; then
  stage=$1
  shift
  case $stage in /*) ;; *) exit 20 ;; esac
  test $# -ge 1 || exit 20
fi

split() {
  sha=${1%%:*}
  rest=${1#*:}
  size=${rest%%:*}
  name=${rest#*:}
}

matches() {
  test -f "$1" && test ! -L "$1" || return 1
  test "$(stat -c %s "$1")" = "$2" || return 1
  actual=$(sha256sum "$1") || return 1
  test "${actual%% *}" = "$3"
}

for entry in "$@"; do
  case $entry in *:*:*) ;; *) exit 20 ;; esac
  split "$entry"
  case $sha in '' | *[!0-9a-f]*) exit 20 ;; esac
  test ${#sha} -eq 64 || exit 20
  case $size in '' | *[!0-9]*) exit 20 ;; esac
  case $name in '' | */* | *:* | *[!A-Za-z0-9._+~%-]*) exit 20 ;; esac
  case $name in *.deb) ;; *) exit 20 ;; esac
done

lists=
trap 'rm -rf "$lists"' EXIT

test -d /sys/module/zfs && command -v zpool >/dev/null && command -v zfs >/dev/null && command -v findmnt >/dev/null || exit 21
imported=$(zpool list -H -o name,guid) || exit 21
printf '%s\n' "$imported" | awk -v pool="$pool" -v guid="$guid" '($1 "") == (pool "") && ($2 "") == (guid "") { found = 1 } END { exit !found }' || exit 22

dataset=$pool/$leaf
props=$(zfs get -H -p -o property,value,source guid,type,mountpoint,canmount,mounted "$dataset") || exit 23

value() {
  printf '%s\n' "$props" | awk -F'\t' -v property="$1" '$1 == property { print $2 }'
}

origin() {
  printf '%s\n' "$props" | awk -F'\t' -v property="$1" '$1 == property { print $3 }'
}

test "$(value guid)" = "$dataset_guid" || exit 23
test "$(value type)" = filesystem || exit 23
test "$(value mountpoint)" = "$mountpoint" && test "$(origin mountpoint)" = local || exit 24
test "$(value canmount)" = noauto && test "$(origin canmount)" = local || exit 24
test "$(value mounted)" = no || exit 25
findmnt --kernel --noheadings --mountpoint "$mountpoint" >/dev/null && exit 25

if test "$mode" = capture; then
  for entry in "$@"; do
    split "$entry"
    matches "$stage/$name" "$size" "$sha" || exit 26
  done
else
  lists=$(mktemp -d) || exit 30
  mkdir "$lists/partial" || exit 30
fi

copy() {
  for entry in "$@"; do
    split "$entry"
    install -m 644 "$stage/$name" "$mountpoint/$name" || return 1
    matches "$mountpoint/$name" "$size" "$sha" || return 1
  done
}

# APT with no source, empty package lists, and no cache files written, so only
# the given local files and the installed packages can satisfy a dependency.
offline() {
  apt-get -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts=/dev/null -o "Dir::State::lists=$lists" -o Dir::Cache::pkgcache= -o Dir::Cache::srcpkgcache= --no-install-recommends "$@"
}

# `name=version` of a retained file, from the name that APT gave it: the epoch
# colon is quoted as %3a, and an architecture variant such as amd64v3 follows
# the last underscore and is ignored.
spec_of() {
  base=${1%.deb}
  package=${base%%_*}
  rest=${base#*_}
  version=$(printf '%s' "${rest%%_*}" | sed 's/%3a/:/')
  printf '%s=%s\n' "$package" "$version"
}

restore() {
  files=
  for entry in "$@"; do
    split "$entry"
    matches "$mountpoint/$name" "$size" "$sha" || return 27
    files="$files $mountpoint/$name"
  done
  expected=$(for entry in "$@"; do split "$entry"; spec_of "$name"; done | sort)
  plan=$(offline --simulate install $files) || return 28
  if printf '%s\n' "$plan" | grep -Eq '^(Remv|Purg) |^Inst [^ ]+ \['; then
    return 29
  fi
  planned=$(printf '%s\n' "$plan" | sed -n 's/^Inst \([^ ]*\) (\([^ ]*\) .*/\1=\2/p' | sort)
  for item in $planned; do
    printf '%s\n' "$expected" | grep -Fxq "$item" || return 29
  done
  names=$(printf '%s\n' "$planned" | sed 's/=.*//')
  for configured in $(printf '%s\n' "$plan" | sed -n 's/^Conf \([^ ]*\) .*/\1/p'); do
    printf '%s\n' "$names" | grep -Fxq "$configured" || return 29
  done
  offline -y -q -o DPkg::Lock::Timeout=300 --no-remove install $files >/dev/null || return 100
}

install -d -m 755 "$mountpoint" || exit 100
zfs mount "$dataset" || exit 100
status=0
if test "$mode" = capture; then
  copy "$@" || status=100
else
  restore "$@" || status=$?
fi
sync
zfs unmount "$dataset" || exit 100
exit $status
