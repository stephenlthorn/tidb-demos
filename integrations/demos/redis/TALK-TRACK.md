# Talk track: Redis Cache Invalidation with TiCDC

## Phase 1 - Cache-aside with TTL

"This is the pattern most of you already run: Redis in front of the database, TTL-based
expiry, cache-aside reads. Every row in this demo carries a version number, so instead of me
telling you the cache is stale, a sampler is checking it every second and reporting the real
percentage. Watch that number - it's not zero, and it can't be zero, because nothing tells the
cache a write happened until the TTL runs out."

## Phase 2 - CDC-driven invalidation

"Now I'm turning on a TiCDC changefeed. Every committed row change streams to Kafka as it
happens, and a small invalidator service deletes the corresponding Redis key the moment it sees
it. No second write in the application code, no TTL tuning. Watch the stale read rate - and watch
the invalidation lag number next to it, because that's the honest cost of this approach: it's not
instant, it's this many milliseconds, measured live."

## Phase 3 - Do you still need Redis?

"Here's the question I actually get asked: if TiCDC keeps the cache correct, do you still need
the cache? I'm going to run the identical read pattern straight against TiDB by primary key,
side by side with the cached path. TiDB is not going to win a latency race against an in-memory
store - it's not built to - but look at how close it is. For a lot of read paths, that gap is
worth paying to delete an entire cache layer and its failure modes. Now watch what happens when
I hammer one single key over and over." *(fire hot-key-storm)* "That's where Redis is still the
right tool. This isn't about replacing Redis everywhere - it's about knowing which reads still
need it."

## Discovery questions

1. Where in your read path do you currently accept staleness, and who decided how long that
   window could be?
2. How many places in your codebase write to both the cache and the database today, and what
   happens when one of those writes fails and the other succeeds?
3. Do you know your actual stale read rate right now, or is "the TTL is short enough" the honest
   answer?
4. Which of your cached endpoints are read-heavy on a small number of hot keys versus a wide,
   even spread of keys?
5. If invalidation lag were a number on a dashboard instead of an assumption, what would you want
   it to be, and what would you do differently if it were higher than that?

## Objections and honest answers

1. **"CDC adds a Kafka broker and an invalidator service - that's more infrastructure, not
   less."** True. This trades application-level dual-write complexity (spread across every
   service that writes) for one centralized, testable invalidation path. If you don't already
   run Kafka, weigh that against the number of places you'd otherwise have to remember to
   invalidate a cache correctly.
2. **"Redis is still faster - why would I ever read TiDB directly?"** It is, and this demo
   shows that gap on screen rather than hiding it. The pitch in phase 3 isn't "TiDB is faster,"
   it's "for some read paths, the latency difference is smaller than the cost of a second system
   you have to keep consistent."
3. **"What about the invalidation lag window - can't I still serve a stale read during it?"**
   Yes. This demo measures that window (`invalidation-lag-p50`/`p99`) instead of pretending it's
   zero. If your correctness requirement is stricter than that window, this pattern alone isn't
   enough - you'd need read-your-writes routing on top of it.
4. **"TiCDC only guarantees at-least-once delivery - won't I get duplicate invalidations?"**
   Yes, duplicates can happen on failure and retry. That's fine here: the invalidator's action is
   a `DEL`, which is naturally idempotent - deleting an already-deleted key is a no-op, so
   at-least-once delivery is exactly the guarantee this pattern needs.
5. **"This is a toy table with one row size - what happens at real scale?"** This demo is
   intentionally small so the whole pipeline is visible in a few minutes. It measures real
   lag and real staleness on real infrastructure, but it does not claim to have load-tested this
   pattern at production row counts or write rates; that's a follow-up exercise with your own
   schema and workload.
