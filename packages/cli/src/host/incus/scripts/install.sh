# Installs exactly the approved package set and keeps every downloaded package
# in the given staging directory. It re-simulates first and refuses unless APT
# still plans precisely those names and versions, so an approval is never
# widened. The simulation and the install are separate APT runs, so they are not
# atomic; `--no-remove` keeps the install from removing anything the simulation
# did not show. The staging directory is created only after the simulation
# agrees, and is never emptied or deleted.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
DEBIAN_FRONTEND=noninteractive
export DEBIAN_FRONTEND
exec 2>/dev/null

test $# -gt 1 || exit 20
stage=$1
shift
case $stage in /*) ;; *) exit 20 ;; esac
plan=$(apt-get --simulate --no-install-recommends install "$@") || exit 21
if printf '%s\n' "$plan" | grep -Eq '^(Remv|Purg) |^Inst [^ ]+ \['; then
  exit 23
fi
expected=$(printf '%s\n' "$@" | sort)
planned=$(printf '%s\n' "$plan" | sed -n 's/^Inst \([^ ]*\) (\([^ ]*\) .*/\1=\2/p' | sort)
test "$planned" = "$expected" || exit 22
names=$(printf '%s\n' "$planned" | sed 's/=.*//')
for name in $(printf '%s\n' "$plan" | sed -n 's/^Conf \([^ ]*\) .*/\1/p'); do
  printf '%s\n' "$names" | grep -Fxq "$name" || exit 24
done
install -d -m 755 "$stage" || exit 25
apt-get -y -q -o DPkg::Lock::Timeout=300 -o "Dir::Cache::archives=$stage" -o APT::Keep-Downloaded-Packages=true --no-install-recommends --no-remove install "$@" >/dev/null || exit 100
exit 0
