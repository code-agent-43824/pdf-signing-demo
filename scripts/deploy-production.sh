#!/usr/bin/env bash
set -euo pipefail
umask 0077

revision="${1:-}"
staging_dir="${2:-$(pwd)}"
service_root="${SERVICE_ROOT:-/home/openclaw/services/pdf-signing-demo}"
service_name="${SERVICE_NAME:-pdf-signing-demo.service}"
public_url="${PUBLIC_URL:-https://mescheryakov.pro/pdf-signing/}"
node_bin="${NODE_BIN:-/home/openclaw/runtime/node/bin/node}"
npm_cli="${NPM_CLI:-/home/openclaw/runtime/npm-10.9.8/bin/npm-cli.js}"
user_unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
unit_path="${user_unit_dir}/${service_name}"

if [[ ! "${revision}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "revision must be a 40-character lowercase Git SHA" >&2
  exit 2
fi

service_root="$(realpath -m -- "${service_root}")"
staging_dir="$(realpath -m -- "${staging_dir}")"
storage_script="${staging_dir}/scripts/manage-deploy-storage.sh"
release_dir="${service_root}/releases/${revision}"
expected_staging="${service_root}/releases/.${revision}.staging"

if [[ "${staging_dir}" != "${expected_staging}" ]]; then
  echo "staging directory must be ${expected_staging}" >&2
  exit 2
fi

mkdir -p -- "${service_root}/backups" "${service_root}/releases" "${user_unit_dir}"
exec 9>"${service_root}/deploy.lock"
flock -n 9 || { echo "another deployment is running" >&2; exit 1; }

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${service_root}/backups/${timestamp}-cicd-${revision:0:12}"
previous_target=""
switched=0
unit_changed=0
canary_pid=""
canary_dir=""

cleanup_canary() {
  if [[ -n "${canary_pid}" ]] && kill -0 "${canary_pid}" 2>/dev/null; then
    kill "${canary_pid}" 2>/dev/null || true
    wait "${canary_pid}" 2>/dev/null || true
  fi
  if [[ -n "${canary_dir}" ]]; then
    rm -rf -- "${canary_dir}"
  fi
}

wait_for_ready() {
  local url="$1"
  local attempt
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error --max-time 3 "${url}health/ready" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

rollback() {
  local status=$?
  cleanup_canary
  if (( status == 0 || switched == 0 )); then
    exit "${status}"
  fi

  echo "deployment failed; rolling back to ${previous_target}" >&2
  ln -s -- "${previous_target}" "${service_root}/.current.rollback"
  mv -Tf -- "${service_root}/.current.rollback" "${service_root}/current"
  if (( unit_changed == 1 )); then
    install -m 0644 -- "${backup_dir}/pdf-signing-demo.service" "${unit_path}"
    systemctl --user daemon-reload
  fi
  systemctl --user restart "${service_name}"
  wait_for_ready "http://127.0.0.1:3010/pdf-signing/" || true
  echo "rollback completed" >&2
  exit "${status}"
}
trap rollback EXIT

if [[ "$("${node_bin}" "${npm_cli}" --version)" != 10.9.8 ]]; then
  echo "pinned npm 10.9.8 is unavailable" >&2
  exit 1
fi

"${storage_script}" preflight "${service_root}" "${staging_dir}"

if [[ -e "${release_dir}" ]]; then
  if [[ "$(cat "${release_dir}/.release-revision" 2>/dev/null || true)" != "${revision}" ]]; then
    echo "existing release has an invalid revision marker" >&2
    exit 1
  fi
  rm -rf -- "${staging_dir}"
else
  cd -- "${staging_dir}"
  python3 -m venv .venv
  .venv/bin/python -m pip install --require-hashes --requirement requirements.txt
  PATH="$(dirname -- "${node_bin}"):${staging_dir}/.venv/bin:${PATH}" \
    "${node_bin}" "${npm_cli}" ci --omit=dev
  PATH="$(dirname -- "${node_bin}"):${staging_dir}/.venv/bin:${PATH}" \
    NODE_BIN="${node_bin}" NPM_CLI="${npm_cli}" ./scripts/verify-release.sh
  .venv/bin/python -m pip check
  printf '%s\n' "${revision}" > .release-revision

  # Express sendFile rejects files below a dot-prefixed path by default.
  canary_dir="$(mktemp -d "${service_root}/canary-XXXXXX")"
  canary_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
  PATH="$(dirname -- "${node_bin}"):${staging_dir}/.venv/bin:${PATH}" \
    NODE_ENV=production \
    PORT="${canary_port}" \
    BASE_PATH=/pdf-signing/ \
    RESULTS_DIR="${canary_dir}/results" \
    "${node_bin}" src/server.js >"${canary_dir}/server.log" 2>&1 &
  canary_pid=$!
  wait_for_ready "http://127.0.0.1:${canary_port}/pdf-signing/"
  curl --fail --silent --show-error --max-time 3 \
    "http://127.0.0.1:${canary_port}/pdf-signing/health/metrics" \
    | grep -q '^pdf_signing_process_start_time_seconds '
  PATH="$(dirname -- "${node_bin}"):${staging_dir}/.venv/bin:${PATH}" \
    "${node_bin}" scripts/smoke-signing.js \
    "http://127.0.0.1:${canary_port}/pdf-signing/"
  cleanup_canary
  canary_pid=""
  canary_dir=""

  mv -- "${staging_dir}" "${release_dir}"
fi

mkdir -p -- "${backup_dir}"
if [[ -e "${service_root}/current" ]]; then
  tar --dereference -czf "${backup_dir}/current.tar.gz" \
    -C "${service_root}" current
fi
if [[ -f "${unit_path}" ]]; then
  install -m 0644 -- "${unit_path}" "${backup_dir}/pdf-signing-demo.service"
else
  install -m 0644 -- "${release_dir}/deploy/pdf-signing-demo.service" \
    "${backup_dir}/pdf-signing-demo.service"
fi

if [[ -L "${service_root}/current" ]]; then
  previous_target="$(readlink -f -- "${service_root}/current")"
elif [[ -d "${service_root}/current" ]]; then
  previous_target="${service_root}/releases/pre-cicd-${timestamp}"
  mv -- "${service_root}/current" "${previous_target}"
  ln -s -- "${previous_target}" "${service_root}/current"
else
  echo "current release is missing" >&2
  exit 1
fi

if ! cmp -s -- "${release_dir}/deploy/pdf-signing-demo.service" "${unit_path}"; then
  install -m 0644 -- "${release_dir}/deploy/pdf-signing-demo.service" "${unit_path}"
  systemctl --user daemon-reload
  unit_changed=1
fi

ln -s -- "${release_dir}" "${service_root}/.current.${revision}"
mv -Tf -- "${service_root}/.current.${revision}" "${service_root}/current"
switched=1
systemctl --user restart "${service_name}"

wait_for_ready "http://127.0.0.1:3010/pdf-signing/"
curl --fail --silent --show-error --max-time 10 \
  "${public_url}health/ready" >/dev/null
curl --fail --silent --show-error --max-time 3 \
  "http://127.0.0.1:3010/pdf-signing/health/metrics" \
  | grep -q '^pdf_signing_process_start_time_seconds '
[[ "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --max-time 10 "${public_url}health/metrics")" == 404 ]]
curl --fail --silent --show-error --max-time 10 "${public_url}" >/dev/null
[[ "$(readlink -f -- "${service_root}/current")" == "${release_dir}" ]]
[[ "$(systemctl --user show "${service_name}" -p ActiveState --value)" == active ]]
[[ "$(systemctl --user show "${service_name}" -p NRestarts --value)" == 0 ]]

switched=0
"${release_dir}/scripts/manage-deploy-storage.sh" \
  prune "${service_root}" "${release_dir}" "${previous_target}"
echo "deployed ${revision}"
echo "release=${release_dir}"
echo "backup=${backup_dir}"
