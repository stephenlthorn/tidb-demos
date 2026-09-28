#!/usr/bin/env bash
set -euo pipefail
CDC_VERSION="${CDC_VERSION:?set to the TiCDC version tiup playground printed at startup}"
CDC_BIN="${HOME}/.tiup/components/cdc/${CDC_VERSION}/cdc"
if [ ! -x "${CDC_BIN}" ]; then
  echo "cdc binary not found at ${CDC_BIN}; is infra/tidb/playground.sh running with this version?" >&2
  exit 1
fi
"${CDC_BIN}" cli changefeed create \
  --server="http://127.0.0.1:8300" \
  --sink-uri="kafka://127.0.0.1:9092/redis-demo.cache_rows?protocol=canal-json&kafka-version=3.6.0&enable-tidb-extension=true" \
  --changefeed-id="redis-demo" \
  --config /dev/stdin <<'CONF'
[filter]
rules = ["lab.cache_demo_rows"]
CONF
