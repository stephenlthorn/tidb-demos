# Week 2 - Control Plane vs Data Plane (tutor lesson)

Objective: the trainee can draw the control plane / data plane boundary on a whiteboard, say
exactly where a customer's bytes live in each deployment form, and answer "who can see our
data?" without hedging or overclaiming.

This is the lesson that makes the security and compliance conversation answerable. An SE who
cannot draw this boundary will lose a regulated deal to a competitor who can.

Teach one task per sitting. Run every check yourself with `verify.py`.

---

## The core framing (use this, keep it to ~4 sentences)

Every managed database service splits into two halves. The **control plane** is the part that
manages clusters: the console you log into, billing and metering, alerting, and the metadata
about which clusters exist. The **data plane** is the part that holds the customer's actual
data and answers their queries: the TiDB, TiKV, and TiFlash nodes.

The commercial point is this: **the interesting question is never "is it managed?" It is
"where does the data plane run, and who has a key to it?"** Every tier answer below is a
different answer to that one question.

---

## What is actually in each plane

**Control plane** (TiDB Cloud calls these Central Services, deployed independently of any
customer cluster, reachable over the internet):
- The console / dashboard UI
- Billing and metering
- Alerting
- Metadata storage: which orgs, projects, and clusters exist

**Data plane** (per TiDB Cloud resource):
- TiDB nodes (stateless SQL layer)
- TiKV nodes (row storage, Raft)
- TiFlash nodes (columnar, plus vector and full-text search)
- Auxiliary nodes: TiDB Operator, logging
- All of the above deployed in the **same VPC** for a given resource

The sentence to memorize: *control plane orchestrates, data plane stores and computes.*

---

## Where the data plane lives, by tier

| Tier | Data plane location | Isolation |
|---|---|---|
| Starter | PingCAP's cloud account | Multi-tenant, shared infrastructure |
| Essential | PingCAP's cloud account | See note below - verify current isolation model |
| Premium | PingCAP's cloud account | See note below - verify current isolation model |
| Dedicated | PingCAP's cloud account | Isolated VPC, VMs, managed Kubernetes, storage |
| BYOC | **The customer's own cloud account** | Customer's VPC, customer's IAM |

**Accuracy warning for the tutor:** tier names and their isolation models change. As of this
writing the docs list Starter, Essential, Premium, and Dedicated, with Essential and Premium in
public preview. Do not state a tier's isolation guarantee or preview status from memory. Pull it
live from `docs.pingcap.com/tidbcloud/tidb-cloud-intro/` at the start of this lesson and correct
this table if it has drifted.

**Starter is multi-tenant.** Say this plainly to trainees. It is a fully managed multi-tenant
offering, which is exactly why it can scale to zero and cost nothing idle. That is a feature for
dev and agent workloads and a non-starter for a bank's core ledger. Both statements are true and
an SE needs to be able to say both in the same breath.

**Dedicated is isolated cloud resources**: its own VPC, VMs, managed Kubernetes, and cloud
storage. This is the answer to "we need our own infrastructure" short of BYOC.

**BYOC moves the data plane, not the control plane.** This is the single most misunderstood
point in the whole lesson, and the one trainees get wrong most often. In BYOC the TiDB nodes run
inside the customer's own cloud account and VPC, so the data never leaves their account. The
control plane stays with PingCAP: they still use the PingCAP console, still get metering, still
get alerts. Customers who hear "BYOC" and picture an airgapped install are wrong, and an SE who
lets them stay wrong is setting up a bad surprise in the security review.

---

## Task 1 - Find the boundary from the inside

**Framing:** you can feel the plane boundary from a SQL prompt. On a shared data plane you are
a tenant, not an operator, and the database will tell you so.

**Assign:** "Connect to your Starter cluster and try to list the physical nodes in your cluster.
Then try to read the cluster-level system tables an operator would use."

Let them find the statements. Hint ladder:
1. "There is an `INFORMATION_SCHEMA` table whose name is about cluster topology."
2. "Try `INFORMATION_SCHEMA.CLUSTER_INFO`. There are sibling tables prefixed `CLUSTER_`."
3. Worked fragment: `SELECT * FROM INFORMATION_SCHEMA.CLUSTER_INFO`

**Check (run these):**
```
python verify.py "SELECT * FROM INFORMATION_SCHEMA.CLUSTER_INFO"
python verify.py "SHOW GRANTS FOR CURRENT_USER()"
```

**Expect this to fail or come back empty on Starter, and treat that as the lesson, not a
problem.** On a shared multi-tenant data plane you do not get operator visibility into physical
nodes, because those nodes are not exclusively yours. If it errors, read the error with the
trainee. If it returns rows, note that and adjust - do not pretend an outcome you did not see.

Then have them read their own grants and notice what is absent. On TiDB Cloud they will not have
the full operator privilege set they would have on a self-hosted cluster.

**Socratic:** "You just got told no by the database. Which plane refused you, and why is that
refusal a *good* thing for the customer sitting next to you on this shared tier?"

**SE drill:** "A prospect asks: 'on the free tier, is our data on the same machines as another
company's?' Two sentences, and do not weasel." Grade for: says yes plainly for Starter, names
the tier that fixes it, does not apologize for the architecture.

---

## Task 2 - Encryption and who holds the key

**Framing:** "who can see our data" is really two questions: who can reach it over the network,
and who holds the encryption key. The second one is where deals are won.

TiDB Cloud uses **dual-layer encryption at rest**: the cloud provider's own storage-level
encryption as the first layer, and a TiDB Cloud layer on top using either **CMEK
(customer-managed encryption keys)** or **escrow keys** that TiDB Cloud manages. Dedicated
clusters always use dual-layer encryption. Defaults differ by tier, and they change - verify
current per-tier defaults at `docs.pingcap.com/tidbcloud/security-concepts/` before quoting them.

In transit: TLS on all connection types.

**Assign:** "Confirm your own connection is actually encrypted in transit, from inside SQL."

Hint ladder:
1. "There is a session status variable about the current connection's cipher."
2. "`SHOW STATUS LIKE 'Ssl_cipher'`."

**Check:**
```
python verify.py "SHOW STATUS LIKE 'Ssl_cipher'"
```
Pass when a non-empty cipher is returned and the trainee can connect it back to `TIDB_SSL=true`
in their `SETUP.md` config.

**Socratic:** "A customer says 'encrypted at rest' is table stakes and every vendor claims it.
What is the follow-up question that actually separates vendors?" (Who holds the key. CMEK vs
vendor-managed is the real distinction, not the word "encrypted.")

**SE drill:** "Prospect: 'we have a regulatory requirement that our provider cannot decrypt our
data.' Two sentences." Grade for: names CMEK, names the tier that supports it, and does **not**
promise a specific compliance certification without checking. Correct them hard if they claim a
certification off the top of their head.

---

## Task 3 - Network isolation, and the BYOC boundary

**Framing:** most enterprise security reviews are really network reviews. The escalating ladder
is: public endpoint with an IP access list, then VPC peering, then private endpoint, then BYOC.

The options TiDB Cloud provides:
- **IP access list** - a firewall restricting which addresses can reach the cluster
- **VPC peering** - a private cloud-to-cloud connection
- **Private endpoints** - AWS PrivateLink, Azure Private Link, Google Cloud Private Service
  Connect, and Alibaba Cloud
- **BYOC** - the data plane relocates into the customer's account entirely

**Assign (no cluster needed, this is a whiteboard task):** "Draw two boxes, control plane and
data plane. Now draw the same diagram three times: Starter, Dedicated with a private endpoint,
and BYOC. In each, mark where the customer's bytes are and which side of the line PingCAP
operates."

**Check:** grade the drawing yourself against the tier table above. The most common error is
moving the control plane into the customer account for BYOC. If they do that, stop and correct
it immediately - that mistake will get contradicted by a customer's cloud architect.

**Socratic:** "In BYOC, PingCAP still operates the software running in the customer's account.
What does that mean the customer must still grant, and why is that a negotiation and not a
checkbox?" (IAM roles and access policies the customer defines; PingCAP software runs inside
their VPC. The BYOC setup requires storage settings and IAM roles - the exact role list and
deploy time should be verified live, not quoted from memory.)

**SE drill:** "Prospect: 'BYOC means you can't see anything at all, right?' Two sentences."
Grade for: honest that data stays in their account, honest that the control plane still exists
and still receives metadata and metering, does not oversell airgap.

---

## The three questions this lesson makes answerable

Drill these until the trainee is fast. These are the actual intro-call questions:

1. "Where does our data physically live?" → depends on tier; name it, do not generalize.
2. "Can PingCAP read our data?" → key custody question; CMEK vs escrow keys.
3. "Can we run it in our own VPC?" → BYOC for the data plane, control plane stays managed.

---

## Week 2 (planes) done when

The trainee can, unprompted: draw both planes and put the right components in each, state where
the data plane lives for every tier including that Starter is multi-tenant, explain that BYOC
relocates the data plane but not the control plane, and name the key-custody distinction. They
must also demonstrate the habit of saying "let me verify that" for tier limits, certifications,
and preview status instead of answering from memory.

Record in `progress.json` anything shaky. The two most common failures: putting the control
plane inside the customer account for BYOC, and quoting a compliance certification or a tier
limit without checking.

---

## Sources used for this lesson

- `docs.pingcap.com/tidbcloud/tidb-cloud-intro/` - central services, per-resource VPC, tier list
- `docs.pingcap.com/tidbcloud/architecture-concepts/` - Starter multi-tenant, Dedicated isolated
- `docs.pingcap.com/tidbcloud/security-concepts/` - dual-layer encryption, CMEK, escrow keys,
  network isolation options

Re-verify all four before teaching. Tier names, preview status, and per-tier defaults drift.
