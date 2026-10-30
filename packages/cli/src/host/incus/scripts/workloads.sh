# Stops every Incus workload before the daemon is released. The approved
# inventory arrives as `project/name` words after the per-instance stop timeout
# in seconds. The script re-enumerates every project and refuses before any
# effect unless the instances are exactly the approved ones and none is
# ephemeral, because stopping an ephemeral instance deletes it. Then it
# persists boot.autostart=false on each instance with a single-key update, so a
# reopened daemon never resumes it, and stops each one gracefully: never forced
# and never stateful. These checks repeat the planning conditions just before
# the effect and cannot exclude a concurrent administrator. Exit codes 20 to 99
# mean nothing was changed. A failed effect is reported as 100, because it may
# have changed the host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin:/opt/incus/bin
export PATH
exec 2>/dev/null

test $# -ge 1 || exit 20
timeout=$1
shift
case $timeout in '' | *[!0-9]*) exit 20 ;; esac
for item in "$@"; do
  case $item in */*) ;; *) exit 20 ;; esac
  case ${item%%/*} in '' | *[!A-Za-z0-9-]*) exit 20 ;; esac
  case ${item#*/} in '' | *[!A-Za-z0-9-]*) exit 20 ;; esac
done
command -v incus >/dev/null || exit 21
conf=$(mktemp -d) || exit 21
trap 'rm -rf "$conf"' EXIT

# A fixed client environment, so no operator configuration or remote is used.
INCUS_DIR=/var/lib/incus
INCUS_CONF=$conf
export INCUS_DIR INCUS_CONF
unset INCUS_REMOTE INCUS_PROJECT INCUS_GLOBAL_CONF

# Only a running daemon service is read. A socket that is active while the
# service is not would start the daemon on the first query.
systemctl is-active --quiet incus.service || exit 22

# Captured first, so a failed listing is never mistaken for an empty one.
listing=$(incus --force-local list --all-projects --format csv --columns e,n,s) || exit 23
actual=$(printf '%s\n' "$listing" | awk -F, 'NF > 0 { print $1 "/" $2 }' | sort)
expected=$(printf '%s\n' "$@" | awk 'NF > 0' | sort)
test "$actual" = "$expected" || exit 24

for item in "$@"; do
  detail=$(incus --force-local query "/1.0/instances/${item#*/}?project=${item%%/*}") || exit 25
  if printf '%s\n' "$detail" | grep -Eq '"ephemeral":[[:space:]]*true'; then
    exit 26
  fi
done

for item in "$@"; do
  incus --force-local query --request PATCH --data '{"config":{"boot.autostart":"false"}}' --wait "/1.0/instances/${item#*/}?project=${item%%/*}" >/dev/null || exit 100
done

for item in "$@"; do
  project=${item%%/*}
  name=${item#*/}
  state=$(printf '%s\n' "$listing" | awk -F, -v project="$project" -v name="$name" '($1 "") == (project "") && ($2 "") == (name "") { print $3 }')
  test "$state" = STOPPED && continue
  incus --force-local stop "$name" --project "$project" --timeout "$timeout" || exit 100
done
exit 0
