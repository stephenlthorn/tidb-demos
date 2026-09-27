# chalk: fraud features on TiDB behind a real-time feature platform

## What it proves

A fintech ML platform team asking where TiDB fits versus a real-time feature platform
(Chalk) and versus a key-value metric store. TiDB is the strongly consistent system of
record for raw transactions and the fresh-aggregate engine underneath Chalk's SQL
resolvers. The same fraud features (transaction velocity, spend, merchant diversity) are
computed two ways at once, through Chalk's online query API and through a direct SQL
baseline against TiDB, and the audience watches them agree, and watches a fraud flag flip
within seconds of a burst of transactions.

This demo does not claim TiDB replaces Chalk's online store, caching layer, point-in-time
training-data generation, or feature governance, and it does not claim official TiDB
support inside Chalk's product. Chalk's MySQL data source is being pointed at TiDB on the
strength of MySQL wire-protocol compatibility, confirmed empirically (see Prerequisites).

## Status

Everything through the pure-logic modules, the TiDB and Chalk I/O adapters, and the
runner's phase/control/metric wiring is written and unit-tested without any live system.
A featured trace has not yet been recorded: that step needs a running local TiDB
playground and a deployed Chalk branch (see Run and record below), and is out of scope
for a build performed with no live systems and no API keys.

## Prerequisites

- `tiup` (TiDB playground), no Docker required for this demo.
- Python 3.11+, with a virtualenv at `demos/chalk/.venv`:
  ```
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
  .venv/bin/pip install -e ../../packages/runner-kit-py
  ```
- The Chalk CLI (`curl -s -L https://api.chalk.ai/install.sh | sh`) and a Chalk project
  with a service token (`client_id`/`client_secret`) scoped to an environment. Chalk's
  primary access paths are "Login" (for an existing project) and "Book Demo"; see
  `https://chalk.ai` for current access and pricing, and the Chalk docs at
  `https://docs.chalk.ai` for setup. No price, quota, or plan name is hardcoded here.
- `pnpm`/Node 22, for the shared `@lab/contract` manifest test only.
- The installed Python client is `chalkpy==2.157.28` (`pip show chalkpy`). Its
  `ChalkClient.query` method takes `input=` and `output=` (not `inputs`/`outputs`),
  confirmed against the installed package's function signature. A query's per-feature
  cache status is read from `result.get_feature(<feature>).meta.cache_hit`, not from the
  top-level `result.meta` (which carries query-level execution metadata only); this was
  confirmed by reading the installed `chalk.client` model definitions and their own
  docstring example (`data.get_feature("user.name").meta.cache_hit`), not by an online
  query, since building this demo used no live systems or API keys.

## Run

1. Start local TiDB: `infra/tidb/playground.sh` (from `integrations/`). Wait for it to
   report ready, and record the printed version into `LAB_ENV_TIDB` in `.env`.
2. Copy `.env.example` to `.env` and fill in `CHALK_CLIENT_ID`/`CHALK_CLIENT_SECRET` and,
   if the Chalk dashboard's MySQL integration form uses different variable names than the
   `RISK_MYSQL_*` placeholders here, update them to match.
3. In the Chalk dashboard, add a MySQL data source named `RISK` pointed at the same
   host/port/user/password/database as the `TIDB_*` block above.
4. Deploy the Chalk project: `cd demos/chalk/chalk && chalk apply --branch chalk-tidb-demo`.
5. Smoke-test the SQL-source-against-TiDB path (the single most important check this demo
   depends on):
   ```
   chalk query --branch chalk-tidb-demo --in user.id=1 \
     --out user.txn_count_1h --out user.amount_sum_24h \
     --out user.distinct_merchants_24h --out user.velocity_flag
   ```
6. From `integrations/`: `pnpm lab run chalk --record --port 7070`.
7. Open the UI against the live relay (`pnpm dev` from `integrations/`, then the chalk
   demo page) to watch phases, metrics, and checks as they happen.
8. Fire controls from a second terminal as the demo narrates each phase:
   `curl -X POST http://127.0.0.1:7070/control/velocity-burst`,
   `curl -X POST http://127.0.0.1:7070/control/tighten-staleness`,
   `curl -X POST http://127.0.0.1:7070/control/burst-writes`.
9. Let `wrapup` occur naturally or stop the runner with Ctrl-C.

## Record

Copy the resulting `demos/chalk/traces/<timestamp>.json` to `demos/chalk/traces/featured.json`,
then run `pnpm lab validate chalk` and `pnpm lab check-public` from `integrations/` and
commit only `traces/featured.json`.

## Teardown

- `tiup clean lab` removes the local TiDB data directory.
- In the Chalk dashboard: revoke the service token used for this demo (Settings > Service
  Tokens) and remove the demo's environment or branch (Environments).

## Cost notes

TiDB via `tiup playground` is local and free. Chalk's pricing is not published with
numbers in its docs; see `https://chalk.ai` and the account team reached through "Book
Demo" for current pricing and trial-environment terms.
