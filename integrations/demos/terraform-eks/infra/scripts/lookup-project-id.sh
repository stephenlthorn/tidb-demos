#!/usr/bin/env bash
# Look up the TiDB Cloud project id(s) this API key pair can see, so
# TIDBCLOUD_PROJECT_ID / TF_VAR_tidbcloud_project_id can be set before
# `terraform apply`. Endpoint, auth scheme, and path confirmed directly from
# the tidbcloud/tidbcloud Terraform provider's own HTTP client
# (tidbcloud/api_client.go: DefaultApiUrl = "https://api.tidbcloud.com", HTTP
# Digest auth with the public key as username and the private key as
# password) and the go-tidbcloud-sdk-v1 client
# (client/project/project_client.go: PathPattern "/api/v1beta/projects").
#
# Usage:
#   set -a; source ~/.config/tidb-lab/secrets.env; set +a
#   ./lookup-project-id.sh
set -euo pipefail

: "${TIDBCLOUD_PUBLIC_KEY:?set TIDBCLOUD_PUBLIC_KEY (see ~/.config/tidb-lab/secrets.env)}"
: "${TIDBCLOUD_PRIVATE_KEY:?set TIDBCLOUD_PRIVATE_KEY (see ~/.config/tidb-lab/secrets.env)}"

response=$(curl -sS --fail --digest \
  -u "${TIDBCLOUD_PUBLIC_KEY}:${TIDBCLOUD_PRIVATE_KEY}" \
  "https://api.tidbcloud.com/api/v1beta/projects?page=1&page_size=50")

echo "$response" | jq -r '
  ["id", "name", "cluster_count"],
  (.items[] | [.id, .name, (.cluster_count | tostring)])
  | @tsv
' | column -t
