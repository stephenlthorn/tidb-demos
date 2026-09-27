# Talk track: Terraform + EKS + TiDB Cloud

## Per-phase script

- **Plan**: "This is one Terraform config: a VPC, an EKS cluster, a TiDB Cloud
  Dedicated cluster, and the app that connects them. Let's see the plan before
  we touch anything."
- **Apply: VPC + EKS + TiDB**: "Terraform is creating all of this in one run.
  The VPC and the TiDB Cloud cluster don't depend on each other, so they
  provision in parallel; EKS takes the longest because AWS has to stand up a
  real control plane. We've time-lapsed that wait; the timestamps on screen
  are real."
- **Connect app to TiDB**: "The app never touches TiDB Cloud credentials by
  hand. Terraform wrote the connection secret straight from its own output."
- **Load burst**: "Now let's put traffic through it and watch QPS and
  latency."
- **Scale TiDB capacity**: "We're changing TiKV's node count from 3 to 5.
  Terraform shows this as an update, not a replace, because the provider
  marks node count as changeable in place, not something that forces a new
  cluster."
- **Verify zero downtime**: "While that scale-out ran, here's the exact
  request error count the load generator logged. Not an assumption, a count."
- **Teardown**: "And here's the exact command and the exact check that
  nothing is left running or billing."

## Discovery questions

1. "How much of your database provisioning today goes through Terraform
   versus a console or a ticket?"
2. "When you scale a stateful system today, does that show up in your plan as
   an update or as a replace? How do you catch the difference before you
   apply?"
3. "Do your app teams get database credentials through the same pipeline as
   everything else, or is that still a separate, manual step?"
4. "Are you running EKS clusters per environment, per team, or shared? How
   does that shape how you'd connect to a managed database?"
5. "What does your current teardown process look like, and how do you know
   for certain nothing's left running after a demo or a test environment?"

## Objections and honest answers

1. **"We already run our own TiDB with the Operator, why would we use
   Dedicated?"** Fair; the Operator is a real, supported option (see the
   appendix links in the plan) and self-managed control over the Kubernetes
   layer is a legitimate reason to choose it. Dedicated trades that control
   for not operating TiDB, TiKV, and PD upgrades and failover yourself. This
   demo doesn't claim one is strictly better; it shows Dedicated fits the same
   Terraform workflow.
2. **"A community, partner-maintained provider feels risky for production
   IaC."** The `tidbcloud/tidbcloud` provider is published under the
   `tidbcloud` GitHub org and listed as a Partner provider on the Terraform
   Registry; it is still comparatively young (fewer historical major
   versions than `hashicorp/aws`). Pin an exact version, read the changelog
   before upgrading, and treat it like any other provider you don't control
   the release cadence of.
3. **"Fifteen to twenty-five minutes to provision isn't really a 'demo'."**
   Correct, and this plan says so directly: the recording uses a time-lapse
   label on the EKS wait rather than pretending it's instant. The point isn't
   speed, it's that the same `terraform apply` you already run handles the
   database too.
4. **"What happens to in-flight queries when you scale TiKV nodes?"** This
   demo measures that directly with the `errors-during-scale` check and
   metric rather than asserting zero downtime; if it's nonzero, that's what
   gets reported.
5. **"Private connectivity setup looks like it needs a live confirmation
   step, not just Terraform."** Correct, and Section 4 of the plan flags
   exactly which two details need a live check (DNS resolution behavior and
   TLS enforcement over the private path) before this is presented as
   turnkey.
