# Week 2 - Cloud vs Self-Hosted (tutor lesson)

Objective: the trainee can lay out the real tradeoffs between TiDB Cloud and self-managed TiDB
without turning it into a cloud pitch, and can use the existence of the self-hosted option as a
competitive weapon rather than an embarrassment.

Read `lessons/week-02-planes-and-tiers.md` first. This lesson assumes the control plane / data
plane boundary is already solid.

---

## The core framing (~4 sentences)

TiDB is open source (Apache 2.0) and can be run by anyone on their own hardware or cloud
account. TiDB Cloud is PingCAP running it for you. The choice is not "which is better" - it is
**who you want holding the pager, and what you are willing to give up in exchange.**

The commercially important part: almost every competitor in a TiDB deal has no self-hosted
option at all. Aurora, Spanner, and Snowflake cannot be run on a customer's own metal. That
makes "you could take this in-house if you ever needed to" a real answer to lock-in fear, and
lock-in fear is what kills deals late.

---

## What the customer takes on by self-hosting

Be specific here. Vague hand-waving about "ops burden" does not survive contact with a customer
who already runs Kubernetes and thinks you are being condescending.

- **Deployment and topology**: sizing and placing PD, TiKV, TiDB, and TiFlash nodes. Deployed
  via TiUP, or TiDB Operator on Kubernetes.
- **Upgrades**: version planning, rolling upgrades, rollback plans, testing against their own
  workload.
- **Backup and restore**: configuring it, and the part everyone skips - regularly proving a
  restore actually works.
- **Monitoring**: standing up and running the Prometheus / Grafana / TiDB Dashboard stack.
- **Capacity and hotspots**: watching for hot regions, rebalancing, planning headroom.
- **Security patching** of the OS and the database.
- **No SLA.** They are their own SLA.

The honest version: a customer with a real platform team and existing Kubernetes practice can do
all of this competently. Do not tell them they cannot. Ask what else that team could be doing.

## What the customer gives up by going to Cloud

This is the half trainees skip, and it is the half that builds credibility.

- **Operator-level privileges.** No full SUPER-equivalent privilege set, no OS access, no
  shell on the nodes.
- **Config-file-only settings.** Some TiDB behavior is set in the instance config file, not by
  a SQL variable. `enable-table-lock` is the clean example: it is a config file parameter, so on
  a managed tier the customer simply cannot turn it on. See
  `lessons/week-06-ddl-dml-cdc.md`.
- **Cluster-level observability on shared tiers.** On Starter, operator views into physical
  nodes are not available, because the nodes are not exclusively theirs.
- **Version pinning and timing.** They do not choose an arbitrary patch version or defer an
  upgrade indefinitely.
- **Custom plugins or patched builds.** A shop that maintains its own MySQL fork is going to
  notice this.

**Do not present this list defensively.** Present it as the tradeoff it is. An SE who
volunteers the limits is trusted on everything else they say.

---

## Task 1 - Feel the privilege boundary

**Framing:** the fastest way to understand a managed tier is to look at what you are not
allowed to do.

**Assign:** "On your Starter cluster, read your own privileges, then find a TiDB setting that
exists only in the instance config file and confirm you cannot change it from SQL."

Hint ladder:
1. "Start with your grants, then look for a variable that is documented as config-file-only."
2. "Table locks are gated by a config file parameter, not a system variable."
3. Worked fragment: `SHOW GRANTS FOR CURRENT_USER()` then try `SHOW VARIABLES LIKE '%table_lock%'`

**Check (run these):**
```
python verify.py "SHOW GRANTS FOR CURRENT_USER()"
python verify.py "SHOW VARIABLES LIKE '%table_lock%'"
```

Report what actually comes back. The teaching point holds either way: table locks are enabled by
the `enable-table-lock` **config file** parameter, so there is no SQL switch for the trainee to
flip on a managed cluster. If nothing matching returns, that absence *is* the demonstration.

**Socratic:** "You cannot set that parameter. Name a customer for whom that is a dealbreaker,
and a customer for whom it is a selling point." (Dealbreaker: a shop with a legacy app that
issues `LOCK TABLES`. Selling point: anyone who does not want a junior engineer able to
cluster-wide lock a table in production.)

**SE drill:** "Prospect's DBA says 'we need root on our database.' Two sentences." Grade for:
does not panic, does not promise root, asks what they actually need root *for* (usually backups,
monitoring, or a config change that the managed tier already handles), and names self-hosted or
BYOC as the real escape hatch.

---

## Task 2 - The cost conversation, honestly

**Framing:** self-hosted looks cheaper on a spreadsheet because the spreadsheet omits people.
Cloud looks cheaper in a business case because the business case omits nothing. Both framings
are manipulable, so an SE should reach for the comparison the customer can verify themselves.

**Assign:** "Run a query on your cluster, then find what it cost in RUs. Then explain how you
would build the equivalent number for a self-hosted cluster."

**Check:**
```
python ru_collector.py --reset
python verify.py "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES"
python ru_collector.py
```

**The SE point to land:** on Starter and Essential, consumption is metered in RUs (read bytes +
write bytes + SQL CPU time), so a slow query and an expensive query are the *same* query. On
self-hosted there is no such signal - the cost of an inefficient query is diffuse, absorbed into
hardware you already bought, and it shows up months later as a capacity request.

**Socratic:** "On self-hosted, who notices a badly written query, and how long does it take?"

**SE drill:** "Prospect: 'we ran the numbers, self-hosting is 40% cheaper.' Two sentences."
Grade for: does not dispute their arithmetic, asks whether the number includes the engineers and
the on-call rotation, and does not claim cloud is always cheaper. Sometimes self-hosting genuinely
is cheaper, and saying so is what makes the rest credible.

---

## Task 3 - Turn the self-hosted option into a competitive weapon

**Framing:** this is the highest-leverage two minutes in the lesson. Lock-in fear is the quiet
objection behind a lot of stalled deals, and TiDB has a structural answer that the hyperscaler
databases do not.

**The argument:** TiDB is open source under Apache 2.0. The same engine runs on the customer's
own hardware. So the exit ramp is real: if the commercial relationship ever fails, the customer's
data and workload move to a cluster they control, and their SQL does not change. Aurora, Spanner,
and Snowflake offer no such path - leaving means a migration project.

**Assign (no cluster needed):** "A prospect's CTO says the real objection out loud: 'I don't want
to be trapped by another vendor.' Give the two-sentence answer, then give the follow-up that
turns it into a reason to buy the *cloud* product."

Grade the second half especially. The move is: the exit ramp is what makes it safe to start on
Cloud. You are not asking them to bet the company on a vendor relationship, because the floor
under them is an open source database they could run themselves.

**Socratic:** "If self-hosted is always available, why would anyone pay for Cloud?" Make them
answer in their own words. (They are buying operational capacity and time-to-value, not access
to the engine.)

**SE drill:** "Prospect: 'if we start on TiDB Cloud, what does leaving look like?' Two
sentences." Grade for: honest that a migration is still work, clear that the engine and the SQL
are the same, does not pretend it is a button.

---

## Where each one actually fits

| Situation | Recommend |
|---|---|
| Dev, POC, agent workloads, spiky/idle traffic | Starter (scales to zero) |
| Production app, wants managed, no special isolation need | Essential / Dedicated - verify current fit |
| Regulated data, data residency, "must be in our VPC" | BYOC |
| Strong platform team, existing k8s, air-gapped or on-prem mandate | Self-managed |
| Customer explicitly wants no vendor in the path at all | Self-managed, and say so without flinching |

Verify the middle row against current docs before recommending a tier by name. Tier positioning
changes and Essential and Premium have been in public preview.

---

## Week 2 (cloud vs self-hosted) done when

The trainee can: name at least four concrete things a self-hosting customer takes on, name at
least three concrete things a Cloud customer gives up, explain the RU insight that ties cost to
performance, and deliver the lock-in / exit-ramp argument without overclaiming. The pass bar is
that they volunteer the Cloud limitations rather than being pushed into admitting them.

Most common failure: pitching Cloud as strictly better and getting caught by a competent
platform engineer. Record it in `progress.json` and re-drill next session.

---

## Sources used for this lesson

- `knowledge/tidb-expert.md` - RU composition, tiers, architecture
- `docs.pingcap.com/tidb/stable/sql-statement-lock-tables-and-unlock-tables/` -
  `enable-table-lock` is a config file parameter, disabled by default, experimental
- `docs.pingcap.com/tidbcloud/tidb-cloud-intro/` - tier list and preview status

Re-verify tier names and preview status before teaching.
