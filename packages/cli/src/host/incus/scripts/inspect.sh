# Fixed inspection of repository files, packages, software versions, units,
# listeners, host network, Incus group access, subordinate-ID allocations, the
# sysctl override, the ZFS pool, the state mount, the state directory, the
# startup guard files, and the Incus API. Every section reports its own status,
# so a missing capability is distinguishable from an empty result. Nothing here
# installs, loads, or writes anything. Every section but the API ones is
# offline: it never touches an Incus socket. The API is read only while the
# daemon service itself is already active, because a query through an active
# socket alone would start the daemon by socket activation.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin:/opt/incus/bin
export PATH
DEBIAN_FRONTEND=noninteractive
export DEBIAN_FRONTEND
exec 2>/dev/null

# Arguments: the pool to report on, or an empty string for none, the key file,
# the source file, the bridge subnet, the administrator account, the Incus
# administration group, the state mountpoint, the guard expectation file,
# startup check, service drop-in, and package preferences file, the sysctl
# override file and the sysctl key it pins, then the direct
# packages, `--`, extra packages whose installed state is reported but never
# simulated, `--`, selected or retained `name=version` words whose exact
# versions are simulated, `--`, the retained metadata entries of the state
# directory, `--`, then the dpkg-query globs of the software to report.
POOL=$1
KEY_FILE=$2
SOURCE_FILE=$3
SUBNET=$4
ACCOUNT=$5
GROUP=$6
STATE=$7
EXPECT_FILE=$8
CHECK_FILE=$9
DROPIN_FILE=${10}
PREFERENCES_FILE=${11}
SYSCTL_FILE=${12}
SYSCTL_KEY=${13}
shift 13
PACKAGES=
while test $# -gt 0 && test "$1" != --; do
  PACKAGES="$PACKAGES $1"
  shift
done
test $# -eq 0 || shift
EXTRA=
while test $# -gt 0 && test "$1" != --; do
  EXTRA="$EXTRA $1"
  shift
done
test $# -eq 0 || shift
SELECTED=
while test $# -gt 0 && test "$1" != --; do
  SELECTED="$SELECTED $1"
  shift
done
test $# -eq 0 || shift
ENTRIES=
while test $# -gt 0 && test "$1" != --; do
  ENTRIES="$ENTRIES $1"
  shift
done
test $# -eq 0 || shift
PATTERNS=$*

# A fixed client environment, so no operator configuration or remote is used.
INCUS_DIR=/var/lib/incus
INCUS_CONF=$(mktemp -d) || exit 1
export INCUS_DIR INCUS_CONF
unset INCUS_REMOTE INCUS_PROJECT INCUS_GLOBAL_CONF
trap 'rm -rf "$INCUS_CONF"' EXIT

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
  if test "$(cat /proc/sys/net/ipv4/ip_forward)" = 1; then
    echo 'ipForward yes'
  else
    echo 'ipForward no'
  fi
}

# Each version is printed only when its tool could report it, so a missing tool
# is an absent line and never a guess. The LXC version is not probed here: it is
# read from the running daemon after the approved open.
runtime_info() {
  if out=$(zfs version); then
    printf 'zfs %s\n' "$(printf '%s\n' "$out" | sed -n 's/^zfs-\([0-9][^ ]*\)$/\1/p')"
  fi
  if version=$(modinfo -F version zfs); then
    printf 'zfsModule %s\n' "$version"
  fi
  return 0
}

file_state() {
  if test -L "$2" || { test -e "$2" && ! test -f "$2"; }; then
    echo "$1 other"
  elif test -f "$2"; then
    sum=$(sha256sum "$2") || return 1
    echo "$1 file ${sum%% *}"
  else
    echo "$1 absent"
  fi
}

repository_info() {
  file_state key "$KEY_FILE" || return 1
  file_state source "$SOURCE_FILE" || return 1
  file_state preferences "$PREFERENCES_FILE" || return 1
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/*; do
    test -f "$file" || continue
    test "$file" = "$SOURCE_FILE" && continue
    if grep -q 'pkgs.zabbly.com' "$file"; then
      printf 'conflict %s\n' "$file"
    fi
  done
  return 0
}

# The override file that pins the AppArmor restriction, reported by digest, and
# the running value of the key it pins. A key that cannot be read is an absent
# line and never a guess.
sysctl_info() {
  file_state override "$SYSCTL_FILE" || return 1
  if value=$(sysctl -n "$SYSCTL_KEY"); then
    printf 'apparmor %s\n' "$value"
  fi
  return 0
}

# The files that protect the state directory from daemon activation, reported by
# digest so the planner can tell approved bytes from anything else.
guard_info() {
  file_state expectation "$EXPECT_FILE" || return 1
  file_state check "$CHECK_FILE" || return 1
  file_state dropIn "$DROPIN_FILE" || return 1
}

# Rows are `package | version | source`. A failure reads as no candidates, which
# the planner answers with a refresh and never with an installation.
madison_info() {
  apt-cache madison $PACKAGES $EXTRA
  return 0
}

package_info() {
  dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n' $PACKAGES $EXTRA
  return 0
}

# The patterns are dpkg-query globs, so pathname expansion is switched off around
# the unquoted expansion. A pattern that matches nothing makes dpkg-query exit
# nonzero while the others still print, which is an empty result and not a
# failure.
software_info() {
  set -f
  dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n' $PATTERNS
  set +f
  return 0
}

# A simulation only: it resolves exact selected or retained versions against
# current package lists, never refreshes them, and never changes the host.
# Installed versions that differ are reported to the planner, which refuses
# rather than approving an upgrade or downgrade.
simulation_info() {
  need=
  for spec in $SELECTED; do
    name=${spec%%=*}
    version=${spec#*=}
    have=$(dpkg-query -W -f='${Version}' "$name")
    state=$(dpkg-query -W -f='${db:Status-Status}' "$name")
    test "$have" = "$version" && test "$state" = installed || need="$need $spec"
  done
  test -n "$need" || return 0
  apt-get --simulate --no-install-recommends install $need
}

# `show` succeeds for an absent unit and reports it as LoadState=not-found, so
# an absent unit is distinguishable from a failed query. A failed query fails
# the section. A masked unit reports LoadState=masked, and its unit-file state
# is `masked` for a persistent mask or `masked-runtime` for one that does not
# survive a reboot. Each line is `service <unit> <load> <unit-file> <activation>`.
service_info() {
  for unit in incus.socket incus.service incus-user.socket incus-user.service incus-startup.service; do
    state=$(systemctl show --property=LoadState,UnitFileState,ActiveState "$unit") || return 1
    load=$(printf '%s\n' "$state" | sed -n 's/^LoadState=//p')
    enabled=$(printf '%s\n' "$state" | sed -n 's/^UnitFileState=//p')
    active=$(printf '%s\n' "$state" | sed -n 's/^ActiveState=//p')
    printf 'service %s %s %s %s\n' "$unit" "${load:-unknown}" "${enabled:-none}" "${active:-unknown}"
  done
  return 0
}

listener_info() {
  out=$(ss -H -ltnp) || return 1
  printf '%s\n' "$out" | awk '/"incusd"/ { print "listener " $4 }'
}

# Routes and addresses inside or covering the bridge subnet, apart from the
# default route, and every link name.
network_info() {
  for query in root match; do
    out=$(ip -4 route show table all "$query" "$SUBNET") || return 1
    printf '%s\n' "$out" | awk '$1 != "default" && NF > 0 { print "route " $0 }'
  done
  out=$(ip -o link show) || return 1
  printf '%s\n' "$out" | awk '{ name = $2; sub(/:$/, "", name); sub(/@.*/, "", name); print "link " name }'
}

# Reads the account database, not a live session, so a membership granted
# earlier shows here even though an open SSH connection does not have it yet.
access_info() {
  if getent group "$GROUP" >/dev/null; then
    echo 'group yes'
  else
    echo 'group no'
  fi
  names=$(id -nG "$ACCOUNT") || return 1
  member=no
  for name in $names; do
    test "$name" = "$GROUP" && member=yes
  done
  echo "member $member"
  return 0
}

# Root's rows of each subordinate-ID file, as `uid <start> <count>` and
# `gid <start> <count>`. A file that cannot be read reports `no`, which is not
# the same as a readable file without a root row, because only the second is
# evidence. Only canonical numeric rows count, so text comparison stays exact.
idmap_info() {
  for kind in uid gid; do
    if out=$(cat "/etc/sub$kind"); then
      echo "${kind}File yes"
      printf '%s\n' "$out" | awk -F: -v kind="$kind" '($1 == "root" || $1 == "0") && $2 ~ /^(0|[1-9][0-9]*)$/ && $3 ~ /^[1-9][0-9]*$/ { print kind " " $2 " " $3 }'
    else
      echo "${kind}File no"
    fi
  done
  return 0
}

# The `properties` lines describe the pool dataset and its direct children only,
# as `properties <dataset> <property> <source> <value>`. The source is reduced
# to its first word, because `inherited from X` contains spaces. The value comes
# last, so it may. The `dataset` lines list every dataset of the pool. Without a
# pool name only availability is reported.
zfs_info() {
  if ! command -v zpool >/dev/null || ! test -d /sys/module/zfs; then
    echo 'available no'
    return 0
  fi
  echo 'available yes'
  test -n "$POOL" || return 0
  pools=$(zpool list -H -o name,guid) || return 1
  match=$(printf '%s\n' "$pools" | awk -v pool="$POOL" '$1 == pool { print $1 " " $2 }')
  test -n "$match" || return 0
  printf 'pool %s\n' "$match"
  datasets=$(zfs list -H -r -o name,mounted "$POOL") || return 1
  printf '%s\n' "$datasets" | awk -F'\t' '{ print "dataset " $1 " " $2 }'
  props=$(zfs get -H -p -d 1 -t filesystem,volume -o name,property,value,source guid,type,mountpoint,canmount,mounted "$POOL") || return 1
  printf '%s\n' "$props" | awk -F'\t' 'NF == 4 { source = $4; sub(/ .*/, "", source); print "properties " $1 " " $2 " " source " " $3 }'
}

# The kernel mount table entry at the state directory. --mountpoint matches only
# an exact mountpoint, because --target could return the containing root
# filesystem. findmnt exits 1 both when nothing is mounted there and on failure,
# so its status is ignored and an empty section is only a missing observation.
mount_info() {
  command -v findmnt >/dev/null || return 1
  findmnt --kernel --json --mountpoint "$STATE" --output SOURCE,FSTYPE,TARGET,FSROOT,OPTIONS
  return 0
}

# Whether the state directory holds nothing, and whether every retained metadata
# entry is present as a real entry and not a symbolic link. A directory that
# cannot be listed reports neither, which refuses both a fresh and a preserved
# open and never reads as agreement.
state_info() {
  if ! listing=$(ls -A "$STATE"); then
    echo 'empty no'
    echo 'metadata no'
    return 0
  fi
  if test -z "$listing"; then
    echo 'empty yes'
  else
    echo 'empty no'
  fi
  present=yes
  for entry in $ENTRIES; do
    test -e "$STATE/$entry" && test ! -L "$STATE/$entry" || present=no
  done
  echo "metadata $present"
  return 0
}

# Only a running daemon service is read. A socket that is active while the
# service is not would start the daemon on the first query.
api_reachable() {
  command -v incus >/dev/null && systemctl is-active --quiet incus.service
}

api_info() {
  if api_reachable; then
    echo 'reachable yes'
  else
    echo 'reachable no'
  fi
}

query() {
  incus --force-local query --raw "$1"
}

server_info() { query /1.0; }
projects_info() { query '/1.0/projects?recursion=1'; }
storage_info() { query '/1.0/storage-pools?recursion=1'; }
networks_info() { query '/1.0/networks?project=default&recursion=1'; }
profiles_info() { query '/1.0/profiles?project=default&recursion=1'; }
instances_info() { query '/1.0/instances?all-projects=true&recursion=1'; }
images_info() { query '/1.0/images?project=default&recursion=1'; }

section system system_info
section runtime runtime_info
section repository repository_info
section sysctl sysctl_info
section guard guard_info
section candidates madison_info
section packages package_info
section software software_info
section simulation simulation_info
section services service_info
section listeners listener_info
section network network_info
section access access_info
section idmap idmap_info
section zfs zfs_info
section mount mount_info
section state state_info
section api api_info
if api_reachable; then
  section server server_info
  section projects projects_info
  section storage storage_info
  section networks networks_info
  section profiles profiles_info
  section instances instances_info
  section images images_info
fi
exit 0
