#!/usr/bin/env bash

set -euo pipefail

umask 077

readonly credentialDirectory="${HOME}/qiln/credentials"
readonly natsConfigPath="${credentialDirectory}/nats-server.conf"
readonly hostEnvironmentPath="${credentialDirectory}/qiln-host.env"
readonly gatewayHostKeyPath="${credentialDirectory}/qiln-ssh-gateway-host-key"
readonly orchestratorAuthorizedKeysPath="${credentialDirectory}/authorized_keys"

project=''
instance=''
assumeYes=false
temporaryDirectory=''

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  credentials.sh --project <project> --instance <instance> [--yes]

Options:
  --project   Incus project containing the Qiln development instance.
  --instance  Incus instance name for the Qiln development environment.
  --yes       Skip the interactive confirmation prompt.
EOF
}

ensureTargetInstanceStopped() {
  local instanceStatus=''

  if ! incus --project "${project}" info "${instance}" >/dev/null 2>&1; then
    fail "Unable to inspect Incus instance ${project}/${instance}."
  fi

  if ! instanceStatus="$(incus --project "${project}" list "${instance}" --format csv -c s)"; then
    fail "Unable to determine the state of Incus instance ${project}/${instance}."
  fi

  case "${instanceStatus}" in
    STOPPED)
      ;;
    *)
      fail "Incus instance ${project}/${instance} must be stopped before credentials are changed. Current state: ${instanceStatus:-unknown}."
      ;;
  esac
}

validateOrchestratorAuthorizedKeysRoster() {
  local rosterPath="$1"
  local line=''
  local trimmedLine=''
  local lineNumber=0
  local publicKeyCount=0
  local validationPath="${temporaryDirectory}/qiln-orchestrator-authorized-key"

  while IFS= read -r line || [[ -n "$line" ]]; do
    lineNumber=$((lineNumber + 1))

    if [[ "$line" == *$'\r'* ]]; then
      fail "Orchestrator SSH authorized-key roster contains a carriage return at line ${lineNumber}."
    fi

    trimmedLine="$(printf '%s' "${line}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [[ -z "${trimmedLine}" || "${trimmedLine}" == \#* ]]; then
      continue
    fi

    printf '%s\n' "$line" > "${validationPath}"
    if ! ssh-keygen -l -f "${validationPath}" >/dev/null 2>&1; then
      fail "Orchestrator SSH authorized-key roster contains an invalid public key at line ${lineNumber}."
    fi

    publicKeyCount=$((publicKeyCount + 1))
  done < "${rosterPath}"

  if ((publicKeyCount == 0)); then
    fail 'Orchestrator SSH authorized-key roster must contain at least one valid public key.'
  fi
}

while (($# > 0)); do
  case "$1" in
    --project)
      (($# >= 2)) || fail 'Missing value for --project.'
      project="$2"
      shift 2
      ;;
    --instance)
      (($# >= 2)) || fail 'Missing value for --instance.'
      instance="$2"
      shift 2
      ;;
    --yes)
      assumeYes=true
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ -n "${project}" ]] || fail '--project is required.'
[[ -n "${instance}" ]] || fail '--instance is required.'

if [[ "${assumeYes}" != true ]]; then
  [[ -t 0 ]] || fail 'Use --yes when running without an interactive terminal.'

  read -r -p "Provision or inject Qiln credentials on ${project}/${instance}? [y/N] " confirmation || true
  [[ "${confirmation}" == 'y' || "${confirmation}" == 'Y' ]] || fail 'Credential provisioning cancelled.'
fi

if [[ -L "${credentialDirectory}" ]]; then
  fail "Credential directory must not be a symbolic link: ${credentialDirectory}"
fi

install -d -m 0700 "${credentialDirectory}"
chmod 0700 "${credentialDirectory}"

if [[ -L "${orchestratorAuthorizedKeysPath}" ]]; then
  fail "Orchestrator SSH authorized-key roster must not be a symbolic link: ${orchestratorAuthorizedKeysPath}"
fi

if [[ ! -e "${orchestratorAuthorizedKeysPath}" ]]; then
  fail "Orchestrator SSH authorized-key roster is required: ${orchestratorAuthorizedKeysPath}"
fi

if [[ ! -f "${orchestratorAuthorizedKeysPath}" ]]; then
  fail "Orchestrator SSH authorized-key roster must be a regular file: ${orchestratorAuthorizedKeysPath}"
fi

if [[ ! -s "${orchestratorAuthorizedKeysPath}" ]]; then
  fail "Orchestrator SSH authorized-key roster must not be empty: ${orchestratorAuthorizedKeysPath}"
fi

localCredentialCount=0

for credentialPath in "${natsConfigPath}" "${hostEnvironmentPath}" "${gatewayHostKeyPath}"; do
  if [[ -L "${credentialPath}" ]]; then
    fail "Credential file must not be a symbolic link: ${credentialPath}"
  fi

  if [[ -e "${credentialPath}" ]]; then
    [[ -f "${credentialPath}" ]] || fail "Credential path must be a regular file: ${credentialPath}"
    [[ -s "${credentialPath}" ]] || fail "Credential file must not be empty: ${credentialPath}"
    localCredentialCount=$((localCredentialCount + 1))
  fi
done

# The local credential set is the development source of truth. Normal reruns
# republish these same values rather than rotate NATS, session, or gateway keys.
if ((localCredentialCount == 0)); then
  natsToken="$(openssl rand -hex 32)"
  cookieSecret="$(openssl rand -hex 32)"

  cat >"${natsConfigPath}" <<EOF
server_name: qiln-orchestrator-dev
host: 127.0.0.1
port: 4222

authorization {
  token: "${natsToken}"
}
EOF

  cat >"${hostEnvironmentPath}" <<EOF
NATS_TOKEN=${natsToken}
FASTIFY_COOKIE_SECRET=${cookieSecret}
EOF

  ssh-keygen \
    -q \
    -t ed25519 \
    -f "${gatewayHostKeyPath}" \
    -N '' \
    -C 'qiln-orchestrator-dev-gateway'

  rm -f "${gatewayHostKeyPath}.pub"
elif ((localCredentialCount != 3)); then
  fail 'Local Qiln credential files are incomplete. Restore the missing files or remove the complete set before rerunning.'
fi

chmod 0600 \
  "${natsConfigPath}" \
  "${hostEnvironmentPath}" \
  "${gatewayHostKeyPath}"

temporaryDirectory="$(mktemp -d "${credentialDirectory}/.provision.XXXXXX")"

cleanup() {
  rm -rf -- "${temporaryDirectory}"
}

trap cleanup EXIT

validateOrchestratorAuthorizedKeysRoster "${orchestratorAuthorizedKeysPath}"

# Each mutation is preflighted immediately before Incus receives credential
# material. The workflow intentionally never starts, executes in, or writes
# files directly to the guest.
ensureTargetInstanceStopped
incus --project "${project}" config set \
  "${instance}" \
  'systemd.credential.nats-server.conf=-' < "${natsConfigPath}"

ensureTargetInstanceStopped
incus --project "${project}" config set \
  "${instance}" \
  'systemd.credential.qiln-host.env=-' < "${hostEnvironmentPath}"

ensureTargetInstanceStopped
incus --project "${project}" config set \
  "${instance}" \
  'systemd.credential.qiln-orchestrator-authorized-keys=-' < "${orchestratorAuthorizedKeysPath}"

ensureTargetInstanceStopped
base64 -w0 < "${gatewayHostKeyPath}" |
  incus --project "${project}" config set \
    "${instance}" \
    'systemd.credential-binary.qiln-ssh-gateway-host-key=-'

printf '%s\n' 'Qiln systemd credentials are synchronized.'
printf '%s\n' "  Project: ${project}"
printf '%s\n' "  Instance: ${instance}"
printf '%s\n' '  Credentials: nats-server.conf, qiln-host.env, qiln-orchestrator-authorized-keys, qiln-ssh-gateway-host-key'
