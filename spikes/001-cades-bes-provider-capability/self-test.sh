#!/usr/bin/env bash
set -euo pipefail

# The runner, the page panel and the analyzer are checked together on
# ephemeral RSA material by test/cades-bes-spike.test.js, which npm test and
# CI run as well. Like every Python-backed test it needs .venv/bin on PATH.
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
exec node --test "$repo_dir/test/cades-bes-spike.test.js"
