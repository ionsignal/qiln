# Fixed inspection of repository files, packages, units, listeners, host
# network, Incus group access, the ZFS pool, and the Incus API. Every section
# reports its own status, so a missing capability is distinguishable from an
# empty result. Nothing here installs, loads, or writes anything. The API is
# read only when a daemon socket is already active, and that read can start the
# daemon through socket activation.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin:/opt/incus/bin
export PATH
DEBIAN_FRONTEND=noninteractive
export DEBIAN_FRONTEND
exec 2>/dev/null

# Arguments: the pool to report on, the key file, the source file, the bridge
# subnet, the administrator account, the Incus administration group, the direct
# packages, `--`, then extra packages whose installed state is reported but
# never simulated.
POOL=$1
KEY_FILE=$2
SOURCE_FILE=$3
SUBNET=$4
ACCOUNT=$5
GROUP=$6
shift 6
PACKAGES=
while test $# -gt 0 && test "$1" != --; do
  PACKAGES="$PACKAGES $1"
  shift
done
test $# -eq 0 || shift
EXTRA=$*

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
  printf 'packageArchitecture %s\n' "$(dpkg --print-architecture)"
  if test "$(cat /proc/sys/net/ipv4/ip_forward)" = 1; then
    echo 'ipForward yes'
  else
    echo 'ipForward no'
  fi
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
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/*; do
    test -f "$file" || continue
    test "$file" = "$SOURCE_FILE" && continue
    if grep -q 'pkgs.zabbly.com' "$file"; then
      printf 'conflict %s\n' "$file"
    fi
  done
  return 0
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

# A simulation only: it resolves against the current package lists, never
# refreshes them, and never changes the host.
simulation_info() {
  need=
  for name in $PACKAGES; do
    state=$(dpkg-query -W -f='${db:Status-Status}' "$name")
    test "$state" = installed || need="$need $name"
  done
  test -n "$need" || return 0
  apt-get --simulate --no-install-recommends install $need
}

# `show` succeeds for an absent unit and reports it as LoadState=not-found, so
# an absent unit is distinguishable from a failed query. A failed query fails
# the section. Each line is `service <unit> <load> <unit-file> <activation>`.
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

zfs_info() {
  if ! command -v zpool >/dev/null || ! test -d /sys/module/zfs; then
    echo 'available no'
    return 0
  fi
  echo 'available yes'
  pools=$(zpool list -H -o name,guid) || return 1
  match=$(printf '%s\n' "$pools" | awk -v pool="$POOL" '$1 == pool { print $1 " " $2 }')
  test -n "$match" || return 0
  printf 'pool %s\n' "$match"
  datasets=$(zfs list -H -r -o name,mounted "$POOL") || return 1
  printf '%s\n' "$datasets" | awk -F'\t' '{ print "dataset " $1 " " $2 }'
}

api_reachable() {
  command -v incus >/dev/null && { systemctl is-active --quiet incus.socket || systemctl is-active --quiet incus.service; }
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
section repository repository_info
section candidates madison_info
section packages package_info
section simulation simulation_info
section services service_info
section listeners listener_info
section network network_info
section access access_info
section zfs zfs_info
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
