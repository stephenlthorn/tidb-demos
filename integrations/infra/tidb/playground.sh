#!/usr/bin/env bash
set -euo pipefail
exec tiup playground --tag lab --db 1 --pd 1 --kv 1 --tiflash 1 --ticdc 1 "$@"
