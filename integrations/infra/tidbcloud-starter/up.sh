#!/usr/bin/env bash
# Create (or reuse) one TiDB Cloud Starter cluster for <name>, e.g.:
#   ./up.sh lab-06
#   ./up.sh lab-06 databricks   # also writes demos/databricks/.env
set -euo pipefail

NAME="${1:?usage: up.sh <name> [demo-id]}"
DEMO_ID="${2:-}"

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
TF_VAR_name="$NAME"
export TF_VAR_name

terraform init -input=false

# 1. Create the cluster first. Its cluster_id/user_prefix are only known
#    after this applies, and the default root user must exist before it
#    can be imported in step 2.
terraform apply -input=false -auto-approve \
  -state="$STATE_FILE" \
  -target=tidbcloud_serverless_cluster.this

CLUSTER_ID="$(terraform output -state="$STATE_FILE" -raw cluster_id)"
FULL_USER="$(terraform output -state="$STATE_FILE" -raw user)"

# 2. Bring the cluster's built-in "<prefix>.root" user under Terraform
#    management (once), so step 3 can set its password.
if ! terraform state list -state="$STATE_FILE" 2>/dev/null | grep -qx "tidbcloud_sql_user.root"; then
  echo "Importing default root SQL user into state..."
  terraform import -input=false -state="$STATE_FILE" \
    tidbcloud_sql_user.root "${CLUSTER_ID},${FULL_USER}"
fi

# 3. Set the generated password (and anything else that drifted).
terraform apply -input=false -auto-approve -state="$STATE_FILE"

HOST="$(terraform output -state="$STATE_FILE" -raw host)"
PORT="$(terraform output -state="$STATE_FILE" -raw port)"
DB_USER="$(terraform output -state="$STATE_FILE" -raw user)"
PASSWORD="$(terraform output -state="$STATE_FILE" -raw password)"

echo "cluster_id=$CLUSTER_ID"
echo "host=$HOST"
echo "port=$PORT"
echo "user=$DB_USER"
echo "password=(sensitive, written to .env only)"

# 4. Create the "lab" database (idempotent). TLS is required for Starter.
echo "Creating database 'lab' if it does not exist..."
if command -v mysql >/dev/null 2>&1; then
  mysql --host="$HOST" --port="$PORT" --user="$DB_USER" --password="$PASSWORD" \
    --ssl-mode=REQUIRED --execute="CREATE DATABASE IF NOT EXISTS lab;"
else
  TIDB_HOST="$HOST" TIDB_PORT="$PORT" TIDB_USER="$DB_USER" TIDB_PASSWORD="$PASSWORD" \
    node -e '
      const mysql = require("mysql2/promise");
      (async () => {
        const conn = await mysql.createConnection({
          host: process.env.TIDB_HOST,
          port: Number(process.env.TIDB_PORT),
          user: process.env.TIDB_USER,
          password: process.env.TIDB_PASSWORD,
          ssl: { minVersion: "TLSv1.2" },
        });
        await conn.query("CREATE DATABASE IF NOT EXISTS lab");
        await conn.end();
      })().catch((err) => {
        console.error(err);
        process.exit(1);
      });
    '
fi

if [ -n "$DEMO_ID" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
  DEMO_DIR="$REPO_ROOT/demos/$DEMO_ID"
  if [ ! -d "$DEMO_DIR" ]; then
    echo "no such demo: $DEMO_DIR" >&2
    exit 1
  fi
  ENV_FILE="$DEMO_DIR/.env"
  if [ ! -f "$ENV_FILE" ] && [ -f "$DEMO_DIR/.env.example" ]; then
    cp "$DEMO_DIR/.env.example" "$ENV_FILE"
  fi
  touch "$ENV_FILE"

  TMP_ENV="$(mktemp)"
  grep -v -E '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS)=' "$ENV_FILE" > "$TMP_ENV" || true
  {
    cat "$TMP_ENV"
    echo "TIDB_HOST=$HOST"
    echo "TIDB_PORT=$PORT"
    echo "TIDB_USER=$DB_USER"
    echo "TIDB_PASSWORD=$PASSWORD"
    echo "TIDB_DATABASE=lab"
    echo "TIDB_TLS=true"
  } > "$ENV_FILE"
  rm -f "$TMP_ENV"

  echo "Wrote TiDB connection values into $ENV_FILE"
fi
