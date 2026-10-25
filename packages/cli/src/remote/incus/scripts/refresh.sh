# Refreshes the APT package lists. This updates every configured source, not
# only the approved repository, and the preview discloses that. APT's own fetch
# retries are the only retry logic. Exit codes 20 to 99 mean nothing was
# changed. A failed refresh is reported as 100, because it may have changed the
# host.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
DEBIAN_FRONTEND=noninteractive
export DEBIAN_FRONTEND
exec 2>/dev/null

test $# -eq 1 || exit 20
source_file=$1
case $source_file in /*) ;; *) exit 20 ;; esac
test -f "$source_file" || exit 21

apt-get -q -o DPkg::Lock::Timeout=300 -o Acquire::Retries=3 update >/dev/null || exit 100
exit 0
