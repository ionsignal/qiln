#!/usr/bin/env bash

set -euo pipefail

umask 077

readonly credentialDirectory="${HOME}/qiln/credentials"
readonly natsConfigPath="${credentialDirectory}/nats-server.conf"
readonly hostEnvironmentPath="${credentialDirectory}/qiln-host.env"
readonly gatewayHostKeyPath="${credentialDirectory}/qiln-ssh-gateway-host-key"
readonly orchestratorAuthorizedKeysPath="${credentialDirectory}/authorized_keys"

readonly remoteRuntimeEnvironmentPath='/etc/qiln/runtime.env'
readonly remoteManualDotenvPath='/opt/qiln/.env'
readonly remoteOrchestratorAuthorizedKeysPath='/home/qiln/.ssh/authorized_keys'
readonly remoteOrchestratorSshDirectory="${remoteOrchestratorAuthorizedKeysPath%/*}"

project=''
instance=''
assumeYes=false

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

validateOrchestratorAuthorizedKeysRoster() {
  local rosterPath="$1"
  local line=''
  local lineNumber=0
  local publicKeyCount=0
  local validationPath="${temporaryDirectory}/qiln-orchestrator-authorized-key"
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineNumber=$((lineNumber + 1))
    if [[ "$line" == *$'\r'* ]]; then
      fail "Orchestrator SSH authorized-key roster contains a carriage return at line ${lineNumber}."
    fi
    if [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]]; then
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

ensureRemoteOrchestratorSshDirectory() {
  local targetDirectory="$1"
  incus --project "${project}" exec "${instance}" -- /bin/sh -eu -c '
    target_directory=$1

    if [ -L /home/qiln ] || [ ! -d /home/qiln ]; then
      echo "Orchestrator home directory must be a non-symlink directory." >&2
      exit 1
    fi

    if [ "$(stat --format="%u:%g" /home/qiln)" != "1000:1000" ]; then
      echo "Orchestrator home directory must be owned by qiln:qiln." >&2
      exit 1
    fi

    if [ -L "${target_directory}" ]; then
      echo "Orchestrator SSH directory must not be a symbolic link." >&2
      exit 1
    fi

    if [ ! -e "${target_directory}" ]; then
      install -d -o qiln -g qiln -m 0700 -- "${target_directory}"
    fi

    if [ -L "${target_directory}" ] || [ ! -d "${target_directory}" ]; then
      echo "Orchestrator SSH directory must be a non-symlink directory." >&2
      exit 1
    fi

    if [ "$(stat --format="%u:%g:%a" "${target_directory}")" != "1000:1000:700" ]; then
      echo "Orchestrator SSH directory must be owned by qiln:qiln with mode 0700." >&2
      exit 1
    fi
  ' qiln-orchestrator-ssh-directory "${targetDirectory}"
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
remoteOrchestratorAuthorizedKeysTemporaryFilePending=false

readonly stagedOrchestratorAuthorizedKeysPath="${temporaryDirectory}/qiln-orchestrator-authorized_keys"
readonly remoteOrchestratorAuthorizedKeysTemporaryPath="${remoteOrchestratorAuthorizedKeysPath}.qiln-${temporaryDirectory##*/}"

cleanup() {
  if [[ "${remoteOrchestratorAuthorizedKeysTemporaryFilePending}" == true ]]; then
    incus --project "${project}" exec "${instance}" -- \
      /bin/rm -f -- "${remoteOrchestratorAuthorizedKeysTemporaryPath}" >/dev/null 2>&1 || true
  fi
  rm -rf -- "${temporaryDirectory}"
}

trap cleanup EXIT

if ! cp --no-dereference -- "${orchestratorAuthorizedKeysPath}" "${stagedOrchestratorAuthorizedKeysPath}"; then
  fail "Failed to stage the orchestrator SSH authorized-key roster: ${orchestratorAuthorizedKeysPath}"
fi

if [[ -L "${stagedOrchestratorAuthorizedKeysPath}" || ! -f "${stagedOrchestratorAuthorizedKeysPath}" ]]; then
  fail 'Staged orchestrator SSH authorized-key roster must be a regular non-symlink file.'
fi

chmod 0600 "${stagedOrchestratorAuthorizedKeysPath}"
validateOrchestratorAuthorizedKeysRoster "${stagedOrchestratorAuthorizedKeysPath}"
ensureRemoteOrchestratorSshDirectory "${remoteOrchestratorSshDirectory}"

readonly runtimeEnvironmentPath="${temporaryDirectory}/runtime.env"
readonly manualDotenvPath="${temporaryDirectory}/qiln-manual.env"

# The manual dotenv intentionally contains only textual Host credentials. The
# SSH gateway private host key remains a binary systemd credential.
incus --project "${project}" file pull \
  "${instance}${remoteRuntimeEnvironmentPath}" \
  "${runtimeEnvironmentPath}"

{
  cat "${runtimeEnvironmentPath}"
  printf '\n'
  cat "${hostEnvironmentPath}"
} >"${manualDotenvPath}"

chmod 0600 "${manualDotenvPath}"

# Read credentials from standard input so their contents never become command
# arguments, process listings, or normal script output.
incus --project "${project}" config set \
  "${instance}" \
  'systemd.credential.nats-server.conf=-' < "${natsConfigPath}"

incus --project "${project}" config set \
  "${instance}" \
  'systemd.credential.qiln-host.env=-' < "${hostEnvironmentPath}"

base64 -w0 < "${gatewayHostKeyPath}" |
  incus --project "${project}" config set \
    "${instance}" \
    'systemd.credential-binary.qiln-ssh-gateway-host-key=-'

# Manual commands run from /opt/qiln load this file through c12. The systemd
# service explicitly disables dotenv loading and continues to use credentials.
incus --project "${project}" file push \
  --uid=1000 \
  --gid=1000 \
  --mode=0600 \
  "${manualDotenvPath}" \
  "${instance}${remoteManualDotenvPath}"

# The orchestrator Linux account consumes this normal filesystem file through
# sshd. It is intentionally not a systemd credential and never targets branch
# authorized-key files managed by the Host-to-Worker synchronization flow.
remoteOrchestratorAuthorizedKeysTemporaryFilePending=true

incus --project "${project}" file push \
  --uid=1000 \
  --gid=1000 \
  --mode=0600 \
  "${stagedOrchestratorAuthorizedKeysPath}" \
  "${instance}${remoteOrchestratorAuthorizedKeysTemporaryPath}"

incus --project "${project}" exec "${instance}" -- /bin/sh -eu -c '
  temporary_path=$1
  target_path=$2
  target_directory=${target_path%/*}

  if [ "${temporary_path%/*}" != "${target_directory}" ]; then
    echo "Temporary SSH authorized-key roster must be in the target directory." >&2
    exit 1
  fi

  if [ -L "${target_directory}" ] || [ ! -d "${target_directory}" ]; then
    echo "Orchestrator SSH directory must be a non-symlink directory." >&2
    exit 1
  fi
 
  if [ "$(stat --format="%u:%g:%a" "${target_directory}")" != "1000:1000:700" ]; then
    echo "Orchestrator SSH directory must be owned by qiln:qiln with mode 0700." >&2
    exit 1
  fi

  if [ -L "${temporary_path}" ] || [ ! -f "${temporary_path}" ]; then
    echo "Temporary orchestrator SSH authorized-key roster must be a regular non-symlink file." >&2
    exit 1
  fi

  if [ "$(stat --format="%u:%g:%a" "${temporary_path}")" != "1000:1000:600" ]; then
    echo "Temporary orchestrator SSH authorized-key roster has incorrect ownership or permissions." >&2
    exit 1
  fi

  mv -f -- "${temporary_path}" "${target_path}"
' qiln-orchestrator-authorized-keys \
  "${remoteOrchestratorAuthorizedKeysTemporaryPath}" \
  "${remoteOrchestratorAuthorizedKeysPath}"

remoteOrchestratorAuthorizedKeysTemporaryFilePending=false

printf '%s\n' 'Qiln systemd credentials, manual dotenv configuration, and orchestrator SSH access roster are synchronized.'
printf '%s\n' "  Project: ${project}"
printf '%s\n' "  Instance: ${instance}"
printf '%s\n' '  Manual dotenv: /opt/qiln/.env'
printf '%s\n' '  Orchestrator SSH roster: /home/qiln/.ssh/authorized_keys'
