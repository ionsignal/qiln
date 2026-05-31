# install/bootstrap.sh
#!/bin/sh
set -eu

die() {
  printf '%s\n' "qiln bootstrap: error: $*" >&2
  exit 1
}

log() {
  printf '%s\n' "qiln bootstrap: $*" >&2
}

usage() {
  cat >&2 <<'EOF'
usage:
  sudo sh install/bootstrap.sh [options]

options:
  --channel <name>     Release channel to use. Default: alpha
  --local <path>       Install an already-built local qiln-bootstrap binary
  --no-exec            Install/check only; do not execute qiln-bootstrap
  --help               Show this help

examples:
  sudo sh install/bootstrap.sh --no-exec

  go build -o /tmp/qiln-bootstrap ./tools/qiln-bootstrap/cmd/qiln-bootstrap
  sudo sh install/bootstrap.sh --local /tmp/qiln-bootstrap --no-exec
EOF
}

qiln_channel="alpha"
qiln_local_binary=""
qiln_no_exec="0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel)
      [ "$#" -ge 2 ] || die "--channel requires a value"
      qiln_channel="$2"
      shift 2
      ;;
    --local)
      [ "$#" -ge 2 ] || die "--local requires a path"
      qiln_local_binary="$2"
      shift 2
      ;;
    --no-exec)
      qiln_no_exec="1"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root"

[ -r /etc/os-release ] || die "cannot read /etc/os-release"
. /etc/os-release

[ "${ID:-}" = "ubuntu" ] || die "Qiln bootstrap stub currently expects Ubuntu 24.04"
[ "${VERSION_ID:-}" = "24.04" ] || die "Qiln bootstrap stub currently expects Ubuntu 24.04"

qiln_machine="$(uname -m)"
case "$qiln_machine" in
  x86_64)
    qiln_arch="amd64"
    ;;
  *)
    die "unsupported architecture: $qiln_machine"
    ;;
esac

qiln_state_dir="/var/lib/qiln/bootstrap"
qiln_log_dir="/var/log/qiln"
qiln_bin_dir="/usr/local/sbin"
qiln_target="$qiln_bin_dir/qiln-bootstrap"
qiln_lock_dir="$qiln_state_dir/lock"

install -d -m 0755 /var/lib/qiln
install -d -m 0700 "$qiln_state_dir"
install -d -m 0755 "$qiln_log_dir"
install -d -m 0755 "$qiln_bin_dir"

if ! mkdir "$qiln_lock_dir" 2>/dev/null; then
  die "another Qiln bootstrap appears to be running"
fi

cleanup() {
  rmdir "$qiln_lock_dir" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

log "detected Ubuntu ${VERSION_ID} ${qiln_arch}"
log "channel: $qiln_channel"

cat > "$qiln_state_dir/stage0.env" <<EOF
QILN_STAGE0_STATUS=cleared
QILN_CHANNEL=$qiln_channel
QILN_ARCH=$qiln_arch
QILN_INSTALLER_PATH=$qiln_target
EOF

chmod 600 "$qiln_state_dir/stage0.env"

if [ -n "$qiln_local_binary" ]; then
  [ -f "$qiln_local_binary" ] || die "local binary does not exist: $qiln_local_binary"
  install -m 0755 "$qiln_local_binary" "$qiln_target"
  log "installed local qiln-bootstrap to $qiln_target"
elif [ -x "$qiln_target" ]; then
  log "reusing existing $qiln_target"
else
  log "no local binary supplied and no installed qiln-bootstrap found"
  log "future behavior: download, verify, and install qiln-bootstrap for channel '$qiln_channel'"
  exit 0
fi

if [ "$qiln_no_exec" = "1" ]; then
  log "Stage 0 cleared; --no-exec requested"
  exit 0
fi

log "handoff to qiln-bootstrap"
exec "$qiln_target" install --channel "$qiln_channel" --resume
