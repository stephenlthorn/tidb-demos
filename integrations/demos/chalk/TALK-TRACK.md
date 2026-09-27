# Talk track: chalk

## Phase 1: seed - "Seed data"

> "We start with a normal book of transactions in TiDB - this is the system of record,
> nothing Chalk-specific about it yet."

The runner creates `users` and `transactions` in TiDB and seeds a handful of users with an
ordinary transaction history. Nothing on screen belongs to Chalk yet: this is plain TiDB,
taking writes and holding data, the same as it would for any other application.

## Phase 2: steady-state - "Steady state"

> "Chalk is answering feature queries here by running SQL resolvers against TiDB. We're
> also running the exact same SQL ourselves, live, so you can see the two agree."

Every tick, the runner asks Chalk's online query API for one sampled user's
`txn_count_1h`, `amount_sum_24h`, and `distinct_merchants_24h`, and separately runs the
identical aggregate SQL directly against TiDB. The `feature-parity` check compares them
tick after tick.

## Phase 3: velocity-burst - "Velocity burst"

> "Watch one user's card get used sixty times in ninety seconds. That's TiDB taking the
> write load, and Chalk's feature flipping the moment the SQL resolver sees it."

The `velocity-burst` control fires sixty transactions for one designated user over about
ninety seconds, then polls Chalk's `velocity_flag` for that user until it flips to `true`.
The `fraud-flip` check reports the elapsed seconds.

## Phase 4: staleness-knob - "Staleness knob"

> "This is the caching knob that's entirely Chalk's job, not TiDB's. Loosen it and queries
> get cheaper and staler; tighten it and every query re-runs the SQL resolver against
> TiDB."

The `tighten-staleness` control toggles the query-time `max_staleness` override between a
cached window and an explicit `0s` (cache-busted) request, so the audience can watch
latency and `cache-hit-rate` move in opposite directions.

## Phase 5: wrapup - "Wrap-up"

> "TiDB was the source of truth and the aggregate engine the whole time. Chalk gave us
> naming, caching, and a serving API on top of it."

The runner stops the workload, prints a summary of the run's checks and metrics, and exits
cleanly.

## Discovery questions

1. What's computing your fraud features today, and where does the source data for them
   live?
2. How do you know a feature value Chalk served you five minutes ago is still correct?
3. What's your current write path for the raw events your features are built from, can it
   also run ad hoc SQL against that same data?
4. How do you decide `max_staleness` per feature today, and who owns that tradeoff?
5. If your feature platform's resolver SQL got slow, would you know whether the
   bottleneck is the database or the platform?

## Objections and honest answers

- **"Chalk already has an online store, why do we need TiDB underneath it?"** Chalk's
  online store caches computed feature values; it does not hold your raw transactional
  data or let you run ad hoc SQL against it, and it is not the system that gives you a
  durable, consistent copy of the events themselves.
- **"Isn't this just Postgres with extra steps?"** Chalk treats TiDB exactly like any
  other native SQL source in this demo; the case for TiDB over a single-node Postgres is
  horizontal write/read scale and built-in HTAP, which this demo's local playground does
  not itself prove at scale, say so plainly if asked.
- **"We don't want two places to look when a feature is wrong"** the direct-SQL baseline
  in this demo is a debugging aid, not a second system to run in production; the point is
  that when a resolver's SQL runs against TiDB, you can always drop into a SQL client and
  run the identical query to explain a value.
- **"What if Chalk's MySQL driver doesn't behave well against TiDB at scale?"** this demo
  confirms functional compatibility at demo scale, not a load-tested certification, say
  that plainly and offer to scope a load test with the account's own resolver SQL.
- **"Why not just use Redis/DynamoDB as the metric store and skip TiDB?"** a key-value
  store has nowhere to put the raw transactions or run new ad hoc aggregates you didn't
  pre-compute; TiDB is where the source-of-truth events live, which is what Chalk's SQL
  resolvers are reading in the first place.
