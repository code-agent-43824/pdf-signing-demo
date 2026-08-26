#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
service_root="$(realpath -m -- "${2:-.}")"
releases_dir="${service_root}/releases"
backups_dir="${service_root}/backups"

require_uint() {
  local name="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "${name} must be a non-negative integer" >&2
    exit 2
  fi
}

validate_release_path() {
  local release_path
  release_path="$(realpath -m -- "$1")"
  if [[ "$(dirname -- "${release_path}")" != "${releases_dir}" ]]; then
    echo "release must be a direct child of ${releases_dir}" >&2
    exit 2
  fi
  printf '%s\n' "${release_path}"
}

remove_path() {
  local target="$1"
  if [[ "${RETENTION_DRY_RUN:-0}" == 1 ]]; then
    echo "would remove ${target}"
  else
    rm -rf -- "${target}"
    echo "removed ${target}"
  fi
}

preflight() {
  local active_staging current_release available_bytes current_bytes
  local reserve_bytes required_bytes transient_age dry_run now candidate name modified
  active_staging="$(validate_release_path "${3:-}")"
  name="$(basename -- "${active_staging}")"
  if [[ ! "${name}" =~ ^\.[0-9a-f]{40}\.staging$ ]]; then
    echo "active staging directory has an invalid name" >&2
    exit 2
  fi
  if [[ ! -d "${active_staging}" || -L "${active_staging}" ]]; then
    echo "active staging directory must be a real directory" >&2
    exit 2
  fi

  reserve_bytes="${DEPLOY_DISK_RESERVE_BYTES:-536870912}"
  transient_age="${STALE_DEPLOY_ARTIFACT_AGE_SECONDS:-3600}"
  dry_run="${RETENTION_DRY_RUN:-0}"
  require_uint DEPLOY_DISK_RESERVE_BYTES "${reserve_bytes}"
  require_uint STALE_DEPLOY_ARTIFACT_AGE_SECONDS "${transient_age}"
  if [[ "${dry_run}" != 0 && "${dry_run}" != 1 ]]; then
    echo "RETENTION_DRY_RUN must be 0 or 1" >&2
    exit 2
  fi

  shopt -s nullglob
  for candidate in "${releases_dir}"/.*.staging; do
    [[ ! -L "${candidate}" ]] || continue
    candidate="$(realpath -m -- "${candidate}")"
    [[ "$(dirname -- "${candidate}")" == "${releases_dir}" ]] || continue
    name="$(basename -- "${candidate}")"
    if [[ "${candidate}" != "${active_staging}" && "${name}" =~ ^\.[0-9a-f]{40}\.staging$ ]]; then
      remove_path "${candidate}"
    fi
  done

  now="$(date +%s)"
  for candidate in "${service_root}"/incoming/release-*.tar.gz; do
    [[ ! -L "${candidate}" ]] || continue
    name="$(basename -- "${candidate}")"
    [[ "${name}" =~ ^release-[0-9a-f]{40}\.tar\.gz$ ]] || continue
    modified="$(stat -c %Y -- "${candidate}")"
    if (( now - modified >= transient_age )); then
      remove_path "${candidate}"
    fi
  done

  current_release="$(validate_release_path "$(readlink -f -- "${service_root}/current")")"
  available_bytes="$(df -PB1 -- "${service_root}" | awk 'NR == 2 { print $4 }')"
  current_bytes="$(du -s -B1 -- "${current_release}" | awk '{ print $1 }')"
  require_uint available_bytes "${available_bytes}"
  require_uint current_release_bytes "${current_bytes}"
  required_bytes=$((reserve_bytes + (current_bytes * 2)))
  if (( available_bytes < required_bytes )); then
    echo "insufficient disk for deployment: available=${available_bytes} required=${required_bytes}" >&2
    exit 1
  fi
  echo "disk preflight passed: available=${available_bytes} required=${required_bytes}"
}

prune() {
  local current_release previous_release keep_backups dry_run
  local candidate name marker regular_seen
  local -a backup_names=()
  current_release="$(validate_release_path "${3:-}")"
  previous_release="$(validate_release_path "${4:-}")"
  keep_backups="${DEPLOY_BACKUP_RETENTION_COUNT:-2}"
  dry_run="${RETENTION_DRY_RUN:-0}"
  require_uint DEPLOY_BACKUP_RETENTION_COUNT "${keep_backups}"
  if (( keep_backups < 1 )); then
    echo "DEPLOY_BACKUP_RETENTION_COUNT must be at least 1" >&2
    exit 2
  fi
  if [[ "${dry_run}" != 0 && "${dry_run}" != 1 ]]; then
    echo "RETENTION_DRY_RUN must be 0 or 1" >&2
    exit 2
  fi
  if [[ "$(readlink -f -- "${service_root}/current")" != "${current_release}" ]]; then
    echo "current symlink does not point to the retained release" >&2
    exit 1
  fi
  [[ -d "${current_release}" && -d "${previous_release}" ]]

  shopt -s nullglob
  for candidate in "${releases_dir}"/*; do
    [[ -d "${candidate}" && ! -L "${candidate}" ]] || continue
    candidate="$(realpath -m -- "${candidate}")"
    [[ "$(dirname -- "${candidate}")" == "${releases_dir}" ]] || continue
    [[ "${candidate}" != "${current_release}" && "${candidate}" != "${previous_release}" ]] || continue
    name="$(basename -- "${candidate}")"
    if [[ "${name}" =~ ^[0-9a-f]{40}$ ]]; then
      marker="$(cat "${candidate}/.release-revision" 2>/dev/null || true)"
      [[ "${marker}" == "${name}" ]] || continue
      remove_path "${candidate}"
    elif [[ "${name}" =~ ^pre-cicd-[0-9]{8}T[0-9]{6}Z$ ]]; then
      remove_path "${candidate}"
    fi
  done

  for candidate in "${backups_dir}"/*; do
    [[ -d "${candidate}" && ! -L "${candidate}" ]] || continue
    name="$(basename -- "${candidate}")"
    [[ "${name}" =~ ^[0-9]{8}T[0-9]{6}Z-cicd-[0-9a-f]{12}$ ]] || continue
    backup_names+=("${name}")
  done
  if (( ${#backup_names[@]} > 0 )); then
    mapfile -t backup_names < <(printf '%s\n' "${backup_names[@]}" | sort -r)
  fi

  regular_seen=0
  for name in "${backup_names[@]}"; do
    candidate="${backups_dir}/${name}"
    if [[ -e "${candidate}/.retain" || -e "${candidate}/rollback-drill.log" ]]; then
      echo "retained evidence backup ${candidate}"
      continue
    fi
    regular_seen=$((regular_seen + 1))
    if (( regular_seen > keep_backups )); then
      remove_path "${candidate}"
    fi
  done
}

case "${mode}" in
  preflight) preflight "$@" ;;
  prune) prune "$@" ;;
  *) echo "usage: $0 preflight SERVICE_ROOT ACTIVE_STAGING | prune SERVICE_ROOT CURRENT PREVIOUS" >&2; exit 2 ;;
esac
