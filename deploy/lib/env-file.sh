#!/usr/bin/env bash

# Load a systemd-style KEY=VALUE file as data. Values are never evaluated.
load_env_file_data() {
  local file="${1:?env file path is required}"
  local required="${2:-required}"
  local line key value line_number=0
  local seen_keys=$'\n'

  if [ ! -r "${file}" ]; then
    if [ "${required}" = "optional" ]; then
      return 0
    fi
    echo "env file is not readable: ${file}" >&2
    return 1
  fi

  while IFS= read -r line || [ -n "${line}" ]; do
    line_number=$((line_number + 1))
    line="${line%$'\r'}"
    if [[ "${line}" =~ ^[[:space:]]*$ || "${line}" =~ ^[[:space:]]*# ]]; then
      continue
    fi
    if [[ ! "${line}" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      echo "invalid env assignment at ${file}:${line_number}" >&2
      return 1
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "${seen_keys}" == *$'\n'"${key}"$'\n'* ]]; then
      echo "duplicate env key ${key} at ${file}:${line_number}" >&2
      return 1
    fi
    seen_keys+="${key}"$'\n'
    case "${key}" in
      BASH_ENV|ENV|SHELLOPTS|BASHOPTS|BASH_LOADABLES_PATH|BASH_XTRACEFD|CDPATH|GLOBIGNORE|IFS|PATH|HOME|SHELL|PWD|OLDPWD|PROMPT_COMMAND|PS0|PS1|PS2|PS4|LD_PRELOAD|LD_LIBRARY_PATH|NODE_OPTIONS|NODE_PATH|PYTHONPATH|RUBYOPT|PERL5OPT)
        echo "forbidden runtime env key ${key} at ${file}:${line_number}" >&2
        return 1
        ;;
    esac
    if [[ "${value}" =~ ^\"(.*)\"$ ]]; then
      value="${BASH_REMATCH[1]}"
    elif [[ "${value}" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    if [[ "${value}" =~ [[:cntrl:]] ]]; then
      echo "control character in env value ${key} at ${file}:${line_number}" >&2
      return 1
    fi
    printf -v "${key}" '%s' "${value}"
    export "${key}"
  done < "${file}"
}

write_selected_env_file() {
  local output="${1:?output env file path is required}"
  shift
  local key value
  umask 077
  : > "${output}"
  for key in "$@"; do
    if ! [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "invalid selected env key: ${key}" >&2
      return 1
    fi
    if ! declare -p "${key}" >/dev/null 2>&1; then
      continue
    fi
    value="${!key}"
    if [[ "${value}" =~ [[:cntrl:]] ]]; then
      echo "control character in selected env value ${key}" >&2
      return 1
    fi
    printf '%s=%s\n' "${key}" "${value}" >> "${output}"
  done
}
