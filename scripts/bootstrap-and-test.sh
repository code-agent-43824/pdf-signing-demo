#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
venv_dir="${project_dir}/.venv"

cd "${project_dir}"

python3 -m venv "${venv_dir}"
"${venv_dir}/bin/python" -m pip install \
  --require-hashes \
  --requirement requirements.txt
npm ci

PATH="${venv_dir}/bin:${PATH}" npm run verify
