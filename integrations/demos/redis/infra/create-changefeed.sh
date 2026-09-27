#!/usr/bin/env bash
set -euo pipefail
CDC_VERSION="${CDC_VERSION:?set to the TiCDC version tiup playground printed at startup}"
tiup "ctl:${CDC_VERSION}" cdc cli changefeed create \
  --server="http://127.0.0.1:8300" \
  --sink-uri="kafka://127.0.0.1:9092/redis-demo.cache_rows?protocol=canal-json&kafka-version=3.6.0" \
  --changefeed-id="redis-demo" \
  --config /dev/stdin <<'CONF'
[filter]
rules = ["lab.cache_demo_rows"]
CONF
