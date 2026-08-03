#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${EUID}" -eq 0 ]] || {
  printf 'This installer permission test must run as root.\n' >&2
  exit 1
}

SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=install-orcasynapse.sh
. "${SCRIPT_ROOT}/install-orcasynapse.sh"

test_root="$(mktemp -d /tmp/orcasynapse-secret-test.XXXXXX)"
trap 'rm -rf -- "${test_root}"' EXIT
ORCASYNAPSE_SECRET_DIR="${test_root}/secrets"
install -d -o root -g root -m 0700 "${ORCASYNAPSE_SECRET_DIR}"

for name in postgres_password orcasynapse_database_url orcasynapse_master_key orcasynapse_installation_key; do
  printf 'permission-test-value' > "${ORCASYNAPSE_SECRET_DIR}/${name}"
done

protect_secret_files

[[ "$(stat -c '%u:%g:%a' "${ORCASYNAPSE_SECRET_DIR}")" == "0:0:700" ]]
[[ "$(stat -c '%u:%g:%a' "${ORCASYNAPSE_SECRET_DIR}/postgres_password")" == "0:0:600" ]]

for name in orcasynapse_database_url orcasynapse_master_key orcasynapse_installation_key; do
  [[ "$(stat -c '%u:%g:%a' "${ORCASYNAPSE_SECRET_DIR}/${name}")" == "0:1000:640" ]]
done

docker run --rm --user 1000:1000 \
  --mount "type=bind,src=${ORCASYNAPSE_SECRET_DIR}/orcasynapse_database_url,dst=/run/secrets/orcasynapse_database_url,readonly" \
  alpine:3.22 sh -eu -c \
  'test "$(cat /run/secrets/orcasynapse_database_url)" = "permission-test-value"'

printf 'Linux container secret-permission boundary verified.\n'
