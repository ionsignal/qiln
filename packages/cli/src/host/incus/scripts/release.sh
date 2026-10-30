# Closes and stops Incus so the pool can be exported. Every unit is masked
# persistently first, so nothing can reactivate it while it stops and it stays
# closed across a reboot. Running instances are shut down in order: the
# packaged startup unit does that when it stops, and a daemon that is still
# running is asked directly, because the startup unit only acts when it was
# active. Then the user and main units are stopped, sockets before services so
# nothing reactivates them. Exit codes 20 to 99 mean nothing was changed. Any
# failed mask or stop is reported as 100, because it may have changed the host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin:/opt/incus/bin
export PATH
exec 2>/dev/null

test $# -ge 1 || exit 20
for unit in "$@"; do
  case $unit in '' | *[!a-z0-9@._-]*) exit 20 ;; esac
done
systemctl cat incus.service >/dev/null || exit 21
command -v incus >/dev/null || exit 22
conf=$(mktemp -d) || exit 22
trap 'rm -rf "$conf"' EXIT

# A fixed client environment, so no operator configuration or remote is used.
INCUS_DIR=/var/lib/incus
INCUS_CONF=$conf
export INCUS_DIR INCUS_CONF
unset INCUS_REMOTE INCUS_PROJECT INCUS_GLOBAL_CONF

systemctl mask "$@" || exit 100
if systemctl cat incus-startup.service >/dev/null; then
  systemctl stop incus-startup.service || exit 100
fi
if systemctl is-active --quiet incus.service; then
  incus --force-local admin shutdown --timeout 120 || exit 100
fi
for unit in incus-user.socket incus-user.service incus.socket incus.service; do
  systemctl cat "$unit" >/dev/null || continue
  systemctl stop "$unit" || exit 100
done
exit 0
