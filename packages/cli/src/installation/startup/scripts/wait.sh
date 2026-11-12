# Bounded polling inside the orchestrator guest. It only reads: nothing here
# starts, stops, or changes anything. Each unit is checked on its own, because
# systemctl is-active exits 0 when any listed unit is active. The unit names and
# the health URL must match catalog/images/qiln-orchestrator-dev.yaml and the
# installer specification. Exit 0 means every check passed, 1 means the deadline
# passed first, and 20 means bad arguments.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
exec 2>/dev/null

test $# -eq 2 || exit 20
check=$1
seconds=$2
case $seconds in '' | *[!0-9]*) exit 20 ;; esac

active() {
  for unit in "$@"; do
    systemctl is-active --quiet "$unit" || return 1
  done
}

prerequisites() {
  active qiln-instance-bootstrap qiln-postgres-bootstrap postgresql@18-main nats-server caddy &&
    pg_isready --quiet --host=/var/run/postgresql
}

ready() {
  active qiln-ssh-dev qiln-dev &&
    curl --fail --silent --max-time 5 --output /dev/null http://127.0.0.1:3002/health
}

case $check in prerequisites | ready) ;; *) exit 20 ;; esac

deadline=$(($(date +%s) + seconds))
until "$check"; do
  test "$(date +%s)" -lt "$deadline" || exit 1
  sleep 2
done
exit 0
