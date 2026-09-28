#!/usr/bin/env bash
# Destroy the TiDB Cloud Starter cluster created by up.sh for <name>.
#   ./down.sh lab-06
set -euo pipefail

NAME="${1:?usage: down.sh <name>}"

SECRETS_FILE="$HOME/.config/tidb-lab/secrets.env"
if [ ! -f "$SECRETS_FILE" ]; then
  echo "missing $SECRETS_FILE (needs TIDBCLOUD_PUBLIC_KEY / TIDBCLOUD_PRIVATE_KEY)" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$SECRETS_FILE"
set +a

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

STATE_FILE="terraform.${NAME}.tfstate"
if [ ! -f "$STATE_FILE" ]; then
  echo "no state file $STATE_FILE, nothing to destroy" >&2
  exit 0
fi

export TF_VAR_name="$NAME"

terraform init -input=false

# TiDB Cloud rejects deleting the cluster's built-in "<prefix>.root" user
# directly; it only goes away when the cluster itself is deleted. Drop it
# from Terraform's state (not the cloud) before destroying, so the cluster
# destroy is not blocked by that provider-side restriction.
if terraform state list -state="$STATE_FILE" 2>/dev/null | grep -qx "tidbcloud_sql_user.root"; then
  terraform state rm -state="$STATE_FILE" tidbcloud_sql_user.root
fi

terraform destroy -input=false -auto-approve -state="$STATE_FILE"

rm -f "$STATE_FILE" "${STATE_FILE}.backup"
echo "Destroyed cluster for $NAME"
