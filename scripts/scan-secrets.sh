#!/usr/bin/env bash
# Scans the whole git history for secrets with a pinned gitleaks release.
set -euo pipefail

gitleaks_version='8.30.1'
gitleaks_archive="gitleaks_${gitleaks_version}_linux_x64.tar.gz"
# SHA-256 of ${gitleaks_archive}, as listed in the release's checksums file.
gitleaks_sha256='551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cache_dir="${XDG_CACHE_HOME:-${HOME}/.cache}/pdf-signing-demo"

if [[ "$(uname -s)/$(uname -m)" != 'Linux/x86_64' ]]; then
  echo "scan-secrets: only the linux x86_64 build of gitleaks is pinned" >&2
  exit 1
fi
if [[ "$(git -C "${project_dir}" rev-parse --is-shallow-repository)" != 'false' ]]; then
  echo "scan-secrets: shallow clone; fetch the full history first" >&2
  exit 1
fi

mkdir -p -- "${cache_dir}"
archive="${cache_dir}/${gitleaks_archive}"
if [[ ! -f "${archive}" ]]; then
  curl --fail --silent --show-error --location --output "${archive}.part" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${gitleaks_version}/${gitleaks_archive}"
  mv -f -- "${archive}.part" "${archive}"
fi
# The cached archive is verified on every run, not only after download.
if ! printf '%s  %s\n' "${gitleaks_sha256}" "${archive}" | sha256sum --check --quiet -; then
  rm -f -- "${archive}"
  echo "scan-secrets: ${gitleaks_archive} does not match the pinned SHA-256" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
trap 'rm -rf -- "${work_dir}"' EXIT
tar -xzf "${archive}" -C "${work_dir}" gitleaks

"${work_dir}/gitleaks" git --no-banner --redact --verbose "${project_dir}"
