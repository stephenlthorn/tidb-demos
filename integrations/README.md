# TiDB Integration Lab

Demos of TiDB working with the tools customers already run. Each demo shows the data flow as an animated diagram with live metrics, runs live against real systems, and records a replay that the static site plays back.

## Quick start

```bash
pnpm install
pnpm test
bash infra/tidb/playground.sh      # separate terminal
pnpm lab run example               # separate terminal
pnpm dev                           # open the printed URL
```

## Demos

See `docs/plans/README.md` for the full roadmap and one plan per demo.

## Rules

- No customer names or internal links anywhere (`pnpm lab check-public` enforces it).
- Every metric says how it was measured; every replay says where it was recorded.
