#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "${project_dir}"
node_bin="${NODE_BIN:-node}"
npm_cli="${NPM_CLI:-}"

npm_run() {
  if [[ -n "${npm_cli}" ]]; then
    "${node_bin}" "${npm_cli}" "$@"
  else
    npm "$@"
  fi
}

snapshot() {
  find test/fixtures sbom -type f -print0 \
    | sort -z \
    | xargs -0 sha256sum
}

before="$(snapshot)"
npm_run run fixtures:generate
npm_run test
npm_run audit --omit=dev --audit-level=high
npm_run run sbom:generate
after="$(snapshot)"

if [[ "${before}" != "${after}" ]]; then
  echo "generated fixtures or SBOM differ from the release archive" >&2
  diff -u <(printf '%s\n' "${before}") <(printf '%s\n' "${after}") || true
  exit 1
fi
