#!/usr/bin/env bash
set -euo pipefail
CDC_VERSION="${CDC_VERSION:?set to the TiCDC version tiup playground printed at startup}"
tiup "ctl:${CDC_VERSION}" cdc cli changefeed remove \
  --server="http://127.0.0.1:8300" \
  --changefeed-id="redis-demo"
