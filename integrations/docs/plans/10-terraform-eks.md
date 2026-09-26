# Plan 10: Terraform + AWS EKS + TiDB Cloud Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a platform team's own workflow, `terraform apply`, standing up a TiDB Cloud Dedicated cluster next to an AWS VPC and EKS cluster and an app deployment in one run, with the UI's resource graph lighting up node-by-node as the runner parses `terraform apply -json` output, then show the same workflow changing TiDB capacity in place while the app keeps serving.

**Architecture:** A TypeScript runner spawns `terraform apply -json -auto-approve` (and later `terraform plan -json` / `terraform apply -json` again for the scale change) as a child process, reads its stdout line by line, parses each line as one of the machine-readable UI message types (`planned_change`, `apply_start`, `apply_progress`, `apply_complete`, `apply_errored`, `change_summary`, `resource_drift`, `outputs`), and turns each into `node`/`flow`/`metric`/`check` events through `@lab/runner-kit`'s `Emitter`. A parallel load-generator goroutine (a small Node script, invoked by the runner) drives HTTP load against the app's `LoadBalancer` Service on EKS and scrapes its `/metrics` endpoint for QPS and p99; the runner also queries TiDB Cloud's SQL interface directly for connection counts. Terraform state lives locally in `demos/terraform-eks/infra/terraform/terraform.tfstate` (gitignored); no remote backend is configured for this demo.

**Tech Stack:** TypeScript runner (`@lab/runner-kit`, spawns `terraform`, `kubectl`, `curl`), Terraform >= 1.9 (for the JSON UI schema in this plan), providers `hashicorp/aws` ~> 6.66, `hashicorp/kubernetes` ~> 3.2, `tidbcloud/tidbcloud` ~> 0.4, modules `terraform-aws-modules/vpc/aws` ~> 6.7 and `terraform-aws-modules/eks/aws` ~> 21.26. Node 22, pnpm, AWS CLI v2, `kubectl`, `helm` (only needed for the optional TiDB Operator appendix).

**Depends on:** Plan 00 (platform).

---

## 1. Why this demo

- **The question customers ask:** "We provision everything with Terraform and manage our own EKS clusters. Can we bring TiDB Cloud into that same pipeline, or do we have to click around a console?"
- **Pattern:** Platform teams that provision everything with Terraform on AWS and EKS, and want to see a database fit their IaC workflow, including how dedicated or bring-your-own-cloud style deployments are scripted.
- **What TiDB proves here:**
  - A TiDB Cloud Dedicated cluster is a first-class Terraform resource (`tidbcloud_dedicated_cluster`), created and destroyed in the same `terraform apply` / `terraform destroy` cycle as the VPC and EKS cluster around it.
  - Capacity is a Terraform attribute, not a console click: `tidb_node_setting.node_count` and `tikv_node_setting.node_count` are updated in place by the provider (no resource replacement), so a capacity change is a normal `terraform apply` with a normal diff.
  - The app keeps serving (measured, not assumed) while that capacity change is in flight, because TiDB adds nodes without taking the cluster offline.
  - Private connectivity from the app's own VPC into TiDB Cloud is also just Terraform resources (`tidbcloud_dedicated_private_link_service` data source + AWS `aws_vpc_endpoint` + `tidbcloud_dedicated_private_endpoint_connection`), not a support ticket.
- **What this demo does not claim:**
  - It does not claim EKS or TiDB Cloud provisioning is instant; the recording is honest about the ~15-25 minute wall-clock time real EKS control planes and TiDB Dedicated clusters take, using a time-lapse label rather than hiding it (see Section 8).
  - It does not claim the private-endpoint DNS behavior is fully self-service without one live confirmation step (Section 4 marks the exact detail **UNVERIFIED**).
  - It does not benchmark TiDB against another database; the QPS/p99 numbers are absolute, not comparative.
  - The optional TiDB Operator (self-managed TiDB on EKS) appendix (Section 9-adjacent, see end of file) is not built or tested in this plan; it is a set of verified links for a future plan.

## 2. What the audience sees

### Flow diagram

```
[terraform CLI]--applies-->[aws_vpc + eks module]---runs on-->[eks-cluster]
                                                                    |
                                                              [app-deployment]
                                                                    |
                                                          private endpoint / TLS
                                                                    |
[terraform CLI]--applies-->[tidbcloud_dedicated_cluster]<----------+
        |
        +--applies-->[tidbcloud_dedicated_private_endpoint_connection]
```

Node ids used in `manifest.json`: `terraform-cli` (source, x=10), `aws-vpc` (cloud, x=30, y=20), `eks-cluster` (cloud, x=50, y=20), `app-deployment` (service, x=70, y=20), `tidb-cluster` (tidb, x=50, y=70), `private-endpoint` (identity, x=70, y=70).

Edges: `apply-vpc` (terraform-cli -> aws-vpc, "resources applied", unit `count`), `apply-eks` (aws-vpc -> eks-cluster, "resources applied", unit `count`), `apply-tidb` (terraform-cli -> tidb-cluster, "resources applied", unit `count`), `deploy-app` (eks-cluster -> app-deployment, "pods scheduled", unit `count`), `app-query` (app-deployment -> tidb-cluster, "queries", unit `rows/s`), `private-link` (app-deployment -> private-endpoint, "connections", unit `count`).

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 1 | plan | Plan | `terraform plan -json` runs against the full config; the diagram outlines every resource about to be created | "This is one Terraform config: a VPC, an EKS cluster, a TiDB Cloud Dedicated cluster, and the app that connects them. Let's see the plan." |
| 2 | apply-infra | Apply: VPC + EKS + TiDB | `terraform apply -json -auto-approve` runs; VPC and TiDB Cloud resources complete first (they do not depend on each other), then EKS node groups come up | "Terraform is creating all of this in one run. The VPC and the TiDB Cloud cluster don't depend on each other, so they provision in parallel; EKS takes the longest because AWS has to stand up a real control plane." |
| 3 | connect | Connect app to TiDB | The app Deployment on EKS starts, reads its DSN from a Kubernetes Secret populated by Terraform outputs, and opens its TiDB connection pool over the private endpoint (or public+TLS, see Section 4) | "The app never touches TiDB Cloud credentials by hand. Terraform wrote the connection secret straight from its own output." |
| 4 | load | Load burst | The runner starts a load generator against the app's Service; QPS and p99 metrics begin flowing | "Now let's put traffic through it and watch QPS and latency." |
| 5 | scale | Scale TiDB capacity | `terraform plan` then `terraform apply -json` runs again with a higher `tikv_node_setting.node_count`; the runner shows the diff has no `-/+` (replace) entries, only in-place updates | "We're changing TiKV's node count from 3 to 5. Terraform shows this as an update, not a replace, because the provider marks node count as changeable in place." |
| 6 | verify | Verify zero downtime | The check `zero-errors-during-scale` and the `errors-during-scale` metric are reported from the load generator's own request log for the scale window | "While that scale-out ran, here's the exact request error count the load generator logged. Not an assumption, a count." |
| 7 | teardown | Teardown | `terraform destroy -json` runs; the runner confirms via `terraform show -json` state is empty afterward | "And here's the exact command and the exact check that nothing is left running or billing." |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| `plan-scale` | Plan capacity change | Runs `terraform plan -json -out=scale.tfplan` with `TF_VAR_tikv_node_count` raised by the amount in `.env`'s `SCALE_TIKV_NODE_COUNT`; emits `planned_change` events without applying |
| `apply-scale` | Apply capacity change | Runs `terraform apply -json scale.tfplan`; only enabled after `plan-scale` has produced a plan file |
| `run-load-burst` | Run load burst | Starts a 60-second burst at `LOAD_BURST_RPS` (from `.env`) against the app's Service, on top of the steady background load |

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| `all-resources-created` | All planned resources created | `change_summary` from the initial apply reports `remove: 0` and `add` equal to the count of `planned_change` messages seen during plan; every `apply_complete` hook resource address appears exactly once |
| `app-connected-intended-endpoint` | App connected over the intended endpoint | The runner reads the app's `/metrics` endpoint's `tidb_connection_target` gauge label (set by the app at startup from its DSN host) and compares it against the Terraform output `connection_endpoint_kind` (`private` or `public_tls`) |
| `zero-errors-during-scale` | Zero failed requests during scale change | The load generator's own counters for the exact time window between the `apply-scale` control event and the matching `change_summary` for that apply are diffed; reported honestly even if nonzero |
| `destroy-leaves-zero-resources` | Destroy leaves zero resources in state | After `terraform destroy -json`, `terraform show -json` state file reports `"values": {}` (no root module resources) |

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| `resources-planned` | Resources planned | count | tile | neutral | Count of `planned_change` messages from the initial `terraform plan -json` |
| `resources-created` | Resources created | count | tile | higher | Count of distinct `apply_complete` messages (by `hook.resource.addr`) from the initial `terraform apply -json` |
| `resource-apply-seconds` | Per-resource apply time | s | series | lower | `hook.elapsed_seconds` from each resource's `apply_complete` message, one series point per resource address |
| `total-apply-seconds` | Total apply time | s | tile | lower | Wall-clock time between the runner spawning `terraform apply` and the process exiting 0, measured with `runner-kit`'s `timed()` |
| `app-qps` | App query rate | rows/s | both | higher | Load generator counts completed HTTP requests to the app's `/work` endpoint per 1000 ms tick and reports the count as the `metric` value (rate over the tick, per platform contract) |
| `app-p99-ms` | App p99 latency | ms | both | lower | Load generator records each request's round-trip time in a `createSampleWindow()`, calls `summarize()` once per tick, emits `p99` |
| `errors-during-scale` | Errors during scale change | count | tile | lower | Load generator's cumulative failed-request counter (non-2xx or timeout), sampled at the start and end of the scale window and reported as the delta |
| `estimated-hourly-cost` | Estimated hourly cost | USD | tile | lower | Computed by the runner from `.env` price inputs (`PRICE_EKS_CONTROL_PLANE_USD_HR`, `PRICE_EC2_NODE_USD_HR` times node count, `PRICE_NAT_GATEWAY_USD_HR`, `PRICE_TIDB_TIKV_NODE_USD_HR` times node count, `PRICE_TIDB_TIDB_NODE_USD_HR` times node count); never a hardcoded number, always read from environment at runtime |

## 4. Verified facts and sources

| Fact | Source | Status |
|---|---|---|
| The TiDB Cloud Terraform provider is `tidbcloud/tidbcloud`, current version 0.4.11, published by `shiyuhang0` (partner-maintained) | https://registry.terraform.io/providers/tidbcloud/tidbcloud/latest/docs | Verified |
| Provider resources include `tidbcloud_dedicated_cluster`, `tidbcloud_dedicated_network_container`, `tidbcloud_dedicated_node_group`, `tidbcloud_dedicated_private_endpoint_connection`, `tidbcloud_dedicated_vpc_peering`, `tidbcloud_serverless_cluster`, `tidbcloud_serverless_branch`, `tidbcloud_serverless_export`, `tidbcloud_sql_user`, `tidbcloud_backup`, `tidbcloud_import`, `tidbcloud_restore`; the legacy `tidbcloud_cluster` still exists but is superseded by `serverless_cluster`/`dedicated_cluster` | https://github.com/tidbcloud/terraform-provider-tidbcloud/tree/main/docs/resources | Verified |
| `tidbcloud_dedicated_cluster` required attributes: `display_name`, `region_id`, `tidb_node_setting{node_spec_key,node_count}`, `tikv_node_setting{node_spec_key,node_count,storage_size_gi}`; optional `tiflash_node_setting`, `root_password`, `port`, `paused`, `project_id` | https://raw.githubusercontent.com/tidbcloud/terraform-provider-tidbcloud/main/docs/resources/dedicated_cluster.md | Verified |
| `region_id` and `project_id` carry a `RequiresReplace` plan modifier (changing them replaces the cluster); `tidb_node_setting.node_count`, `tidb_node_setting.node_spec_key`, `tikv_node_setting.node_count`, `tikv_node_setting.node_spec_key`, `tikv_node_setting.storage_size_gi`, `tikv_node_setting.storage_type`, `tiflash_node_setting.*`, and `root_password` carry no `RequiresReplace` modifier and are handled by the resource's `Update()` method (which calls `UpdateCluster` and polls `WaitDedicatedClusterReady`) | https://raw.githubusercontent.com/tidbcloud/terraform-provider-tidbcloud/main/internal/provider/dedicated_cluster_resource.go | Verified (read the provider's Go source directly) |
| Changing `paused` cannot be combined with any other attribute change in the same apply (the resource's `Update()` returns an error: "Cannot change cluster pause state along with other attributes") | same source as above | Verified |
| Private connectivity for a Dedicated cluster: `tidbcloud_dedicated_private_link_service` (data source; needs `cluster_id` + `node_group_id`, returns `service_name`, `service_dns_name`, `available_zones`) plus `tidbcloud_dedicated_private_endpoint_connection` (resource; needs `cluster_id`, `node_group_id`, `endpoint_id` = the AWS VPC endpoint ID; returns read-only `host`, `port`) | https://raw.githubusercontent.com/tidbcloud/terraform-provider-tidbcloud/main/docs/data-sources/dedicated_private_link_service.md and .../docs/resources/dedicated_private_endpoint_connection.md | Verified |
| `tidbcloud_dedicated_network_container` (region + CIDR reservation for the project/region) exists as its own resource, separate from VPC peering | https://raw.githubusercontent.com/tidbcloud/terraform-provider-tidbcloud/main/docs/resources/dedicated_network_container.md | Verified |
| Whether a `tidbcloud_dedicated_network_container` must be explicitly declared before the first `tidbcloud_dedicated_private_endpoint_connection` in a project/region, or is silently auto-provisioned | provider docs do not state ordering explicitly | **UNVERIFIED** - confirm by running `terraform apply` with the network container declared first (Task 12 below); if TiDB Cloud reports one already exists, import it (`terraform import tidbcloud_dedicated_network_container.this <project_id>,<network_container_id>`) instead of creating a duplicate |
| Whether the `host` value returned by `tidbcloud_dedicated_private_endpoint_connection` resolves from inside the EKS VPC without `private_dns_enabled = true` on the `aws_vpc_endpoint`, or needs it | not stated in provider docs; AWS's own Interface VPC Endpoint behavior implies `private_dns_enabled` controls whether the standard service DNS name resolves inside the VPC | **UNVERIFIED** - confirm during Task 14 (live run) by execing into a pod and running `getent hosts <host>`; if it does not resolve, set `private_dns_enabled = true` on the `aws_vpc_endpoint` resource and re-apply |
| Whether TLS is enforced identically on the private endpoint path vs the public endpoint path for Dedicated clusters | not stated in provider docs | **UNVERIFIED** - confirm during Task 14 by connecting with `--ssl-mode=REQUIRED` over both paths and checking `SHOW STATUS LIKE 'Ssl_cipher'` returns non-empty on both |
| `terraform apply -json` / `terraform plan -json` message types: `version`, `resource_drift`, `planned_change`, `change_summary`, `outputs`, `apply_start`, `apply_progress`, `apply_complete`, `apply_errored`, `provision_start/progress/complete/errored`, `refresh_start/complete`, `diagnostic`, `log`; every message has `@level`, `@message`, `@module`, `@timestamp`, `type`; `apply_progress`/`apply_complete`/`apply_errored` carry `hook.elapsed_seconds` (integer seconds); `apply_complete` carries `hook.id_key`/`hook.id_value`; the `resource` object has `addr`, `module`, `resource`, `resource_type`, `resource_name`, `resource_key`, `implied_provider`; `change_summary` carries `changes.add`/`changes.change`/`changes.remove`/`changes.operation` | https://developer.hashicorp.com/terraform/internals/machine-readable-ui | Verified (fetched directly, full message catalogue read) |
| `terraform-aws-modules/vpc/aws`, current major version 6 (v6.7.3 as of Sept 2026); standard inputs `cidr`, `azs`, `private_subnets`, `public_subnets`, `enable_nat_gateway`, `single_nat_gateway` | https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws/latest | Verified |
| `terraform-aws-modules/eks/aws`, current major version 21 (v21.26.0 as of Sept 2026); standard inputs `name`, `kubernetes_version`, `vpc_id`, `subnet_ids`, `endpoint_public_access`, `enable_cluster_creator_admin_permissions`, `eks_managed_node_groups.<key>.{ami_type,instance_types,min_size,max_size,desired_size}`, `addons.{coredns,eks-pod-identity-agent,kube-proxy,vpc-cni}` | https://registry.terraform.io/modules/terraform-aws-modules/eks/aws/latest | Verified |
| `eks_managed_node_groups.<key>.desired_size` (and `min_size`/`max_size`) are ordinary module inputs with no documented `RequiresReplace`-equivalent restriction; AWS EKS managed node groups support in-place scaling | https://registry.terraform.io/modules/terraform-aws-modules/eks/aws/latest (Usage examples) | Verified for the module's input surface; the underlying AWS API behavior (in-place scaling) is standard EKS managed node group behavior, not specific to this module |
| `hashicorp/aws` provider, current version 6.66.0 as of Sept 2026 | https://registry.terraform.io/providers/hashicorp/aws/latest | Verified |
| `hashicorp/kubernetes` provider, current version 3.2.1 as of Sept 2026 | https://registry.terraform.io/providers/hashicorp/kubernetes/latest/docs | Verified |
| TiDB Cloud Terraform provider get-started guide (how to obtain an API key pair for `public_key`/`private_key`) | https://docs.pingcap.com/tidbcloud/terraform-get-tidbcloud-provider/ | Verified (listed by the provider's own example usage block; not independently re-fetched for content beyond the auth flow it documents) |
| TiDB Cloud pricing and node spec pages (for the cost model's per-node price inputs; no price is hardcoded in this plan) | https://www.pingcap.com/pricing/ (TiDB Cloud Dedicated pricing) | Link only, no numbers taken from it |
| AWS EKS pricing page (control plane hourly rate, referenced by `.env` price variable, never hardcoded) | https://aws.amazon.com/eks/pricing/ | Link only, no numbers taken from it |
| TiDB Operator on EKS getting-started docs (appendix only, not built in this plan) | https://docs.pingcap.com/tidb-in-kubernetes/stable/deploy-on-aws-eks/ and https://github.com/pingcap/tidb-operator | Link only, not fetched for content; appendix explicitly out of scope for this plan's tasks |

## 5. Prerequisites, cost, and teardown

- Accounts and access:
  - A TiDB Cloud account with an API key pair (`TIDBCLOUD_PUBLIC_KEY` / `TIDBCLOUD_PRIVATE_KEY`) that has permission to create Dedicated clusters in the target project.
  - An AWS account and an IAM principal with permission to create VPCs, EKS clusters, EC2 instances, NAT gateways, and VPC endpoints; credentials available to the `aws` CLI and the Terraform `aws` provider via the standard credential chain.
- Local tools:
  - Terraform >= 1.9 (`terraform version`; this plan's JSON parsing assumes the message catalogue confirmed in Section 4, current as of Terraform 1.16.x).
  - AWS CLI v2 (`aws --version`), configured with a profile that has the access above.
  - `kubectl` (`kubectl version --client`) - install with `brew install kubectl` if missing.
  - `helm` (`helm version`) - only required for the optional TiDB Operator appendix; install with `brew install helm` if missing.
  - Node 22 and pnpm, per the platform plan.
- Cost model: this demo bills on three independent meters while it is up.
  - EKS control plane: hourly rate from https://aws.amazon.com/eks/pricing/ times hours up, read from `.env` as `PRICE_EKS_CONTROL_PLANE_USD_HR`.
  - EC2 worker nodes: `PRICE_EC2_NODE_USD_HR` times `desired_size` times hours up.
  - NAT gateway: `PRICE_NAT_GATEWAY_USD_HR` times hours up (this demo uses `single_nat_gateway = true`, so exactly one).
  - TiDB Cloud Dedicated: `PRICE_TIDB_TIDB_NODE_USD_HR` times TiDB node count, plus `PRICE_TIDB_TIKV_NODE_USD_HR` times TiKV node count, times hours up; see https://www.pingcap.com/pricing/ for current rates.
  - The runner's `estimated-hourly-cost` metric sums all of the above from `.env` inputs at every tick; it never hardcodes a number.
- Teardown: exact commands, run from `demos/terraform-eks/infra/terraform`:
  1. `terraform destroy -auto-approve` (the runner also exposes this as `pnpm --filter @lab/demo-terraform-eks run destroy`, which wraps the same command).
  2. Confirm nothing is left in state: `terraform show -json | jq '.values.root_module.resources | length'` must print `0`.
  3. Confirm in the AWS console or via CLI that no EKS cluster, EC2 instance, NAT gateway, or VPC remains tagged `Demo=terraform-eks`: `aws eks list-clusters --query "clusters" && aws ec2 describe-nat-gateways --filter Name=tag:Demo,Values=terraform-eks --query 'NatGateways[?State!=\`deleted\`]'`.
  4. Confirm in the TiDB Cloud console (or `tidbcloud_dedicated_clusters` data source) that no cluster tagged for this demo remains.
  5. **Hard rule: never leave this stack up overnight.** If a recording session must pause, run `terraform destroy -auto-approve` before stopping; re-apply for the next session. The cost model in this section exists precisely so nobody has to guess what "up overnight" would have cost.

## 6. File structure

```
demos/terraform-eks/
  manifest.json                          DemoManifestSchema instance (Section 2/3 as data)
  package.json                           "@lab/demo-terraform-eks", deps @lab/contract + @lab/runner-kit (workspace:*)
  tsconfig.json                          extends ../../tsconfig.base.json
  README.md                              what it proves, prerequisites, run, record, teardown, cost notes
  TALK-TRACK.md                          presenter script per phase, discovery questions, objections
  .env.example                           standard TIDB_* block + PRICE_* + SCALE_TIKV_NODE_COUNT + LOAD_BURST_RPS
  infra/
    terraform/
      versions.tf                        required_providers block
      variables.tf                       all input variables, including price and scale variables
      vpc.tf                             terraform-aws-modules/vpc/aws module block
      eks.tf                             terraform-aws-modules/eks/aws module block
      tidb.tf                            tidbcloud_dedicated_cluster + dedicated_network_container
      private_link.tf                    tidbcloud_dedicated_private_link_service data source + aws_vpc_endpoint + tidbcloud_dedicated_private_endpoint_connection
      k8s.tf                             kubernetes_secret_v1 (DSN) + kubernetes_deployment_v1 + kubernetes_service_v1 for the app
      outputs.tf                         cluster_id, connection_endpoint_kind, app_service_hostname, etc.
    app/
      Dockerfile                         builds the tiny Go/Node app image (see Task 9) pushed to a public registry the demo references by digest
      main.go (or index.ts)              the load-bearing app: /work endpoint runs a query against TiDB, /metrics exposes qps/p99
  runner/
    main.ts                              entry: spawns terraform, wires phases/controls, starts load generator
    src/
      terraform-events.ts                pure parser: raw JSON line -> ParsedTerraformLine (logic under test)
      terraform-events.test.ts           tests for terraform-events.ts
      resource-mapping.ts                pure function: terraform resource addr -> manifest node id
      resource-mapping.test.ts           tests for resource-mapping.ts
      cost.ts                            pure function: node counts + .env prices -> estimated-hourly-cost
      cost.test.ts                       tests for cost.ts
      load-generator.ts                  thin I/O adapter: HTTP load against the app Service, verified by manual live-run steps
      terraform-runner.ts                thin I/O adapter: spawns terraform, pipes stdout/stderr, verified by manual live-run steps
  test/
    manifest.test.ts                     parses manifest.json with DemoManifestSchema
  traces/
    featured.json                        the recording the website plays (committed after capture)
```


## 7. Tasks

### Task 1: Scaffold the demo package

- [ ] Create `demos/terraform-eks/package.json`:

```json
{
  "name": "@lab/demo-terraform-eks",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json",
    "destroy": "terraform -chdir=infra/terraform destroy -auto-approve"
  },
  "dependencies": {
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*"
  },
  "devDependencies": {
    "tsx": "^4.20.0",
    "@types/node": "^22.10.0",
    "vitest": "^3.2.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] Create `demos/terraform-eks/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["runner", "test"]
}
```

- [ ] Run `pnpm install` from the `integrations/` workspace root. Expected: lockfile updates, no errors, `@lab/demo-terraform-eks` listed under `pnpm ls -r --depth -1`.
- [ ] Commit: `git add demos/terraform-eks/package.json demos/terraform-eks/tsconfig.json pnpm-lock.yaml && git commit -m "terraform-eks: scaffold demo package"`

### Task 2: Manifest schema test, then the manifest

- [ ] Write the failing test `demos/terraform-eks/test/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DemoManifestSchema } from '@lab/contract';

describe('terraform-eks manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const raw = readFileSync(new URL('../manifest.json', import.meta.url), 'utf8');
    const result = DemoManifestSchema.safeParse(JSON.parse(raw));
    expect(result.success).toBe(true);
  });

  it('declares the six diagram nodes', () => {
    const raw = readFileSync(new URL('../manifest.json', import.meta.url), 'utf8');
    const manifest = DemoManifestSchema.parse(JSON.parse(raw));
    const nodeIds = manifest.nodes.map((node) => node.id);
    expect(nodeIds).toEqual([
      'terraform-cli',
      'aws-vpc',
      'eks-cluster',
      'app-deployment',
      'tidb-cluster',
      'private-endpoint',
    ]);
  });
});
```

- [ ] Run `pnpm --filter @lab/demo-terraform-eks exec vitest run test/manifest.test.ts`. Expected FAIL: `ENOENT: no such file or directory, open '.../manifest.json'`.
- [ ] Create `demos/terraform-eks/manifest.json`:

```json
{
  "id": "terraform-eks",
  "number": 10,
  "title": "Terraform + EKS",
  "tagline": "Provision TiDB Cloud, AWS EKS, and an app in one terraform apply",
  "integrations": ["terraform", "aws-eks", "tidb-cloud"],
  "pattern": "Platform teams that provision everything with Terraform on AWS and EKS, and want to see a database fit their IaC workflow, including how dedicated or bring-your-own-cloud style deployments are scripted.",
  "publish": true,
  "runner": { "command": ["node", "--import", "tsx", "runner/main.ts"], "cwd": "." },
  "nodes": [
    { "id": "terraform-cli", "label": "terraform apply", "kind": "client", "x": 10, "y": 45 },
    { "id": "aws-vpc", "label": "AWS VPC", "kind": "cloud", "x": 30, "y": 20 },
    { "id": "eks-cluster", "label": "EKS Cluster", "kind": "cloud", "x": 50, "y": 20 },
    { "id": "app-deployment", "label": "App on EKS", "kind": "service", "x": 70, "y": 20 },
    { "id": "tidb-cluster", "label": "TiDB Cloud Dedicated", "kind": "tidb", "x": 50, "y": 70 },
    { "id": "private-endpoint", "label": "Private Endpoint", "kind": "identity", "x": 70, "y": 70 }
  ],
  "edges": [
    { "id": "apply-vpc", "from": "terraform-cli", "to": "aws-vpc", "label": "resources applied", "unit": "count" },
    { "id": "apply-eks", "from": "aws-vpc", "to": "eks-cluster", "label": "resources applied", "unit": "count" },
    { "id": "apply-tidb", "from": "terraform-cli", "to": "tidb-cluster", "label": "resources applied", "unit": "count" },
    { "id": "deploy-app", "from": "eks-cluster", "to": "app-deployment", "label": "pods scheduled", "unit": "count" },
    { "id": "app-query", "from": "app-deployment", "to": "tidb-cluster", "label": "queries", "unit": "rows/s" },
    { "id": "private-link", "from": "app-deployment", "to": "private-endpoint", "label": "connections", "unit": "count" }
  ],
  "metrics": [
    { "id": "resources-planned", "label": "Resources planned", "unit": "count", "display": "tile", "better": "neutral", "howMeasured": "Count of planned_change messages from terraform plan -json" },
    { "id": "resources-created", "label": "Resources created", "unit": "count", "display": "tile", "better": "higher", "howMeasured": "Count of distinct apply_complete hook.resource.addr values from terraform apply -json" },
    { "id": "resource-apply-seconds", "label": "Per-resource apply time", "unit": "s", "display": "series", "better": "lower", "howMeasured": "hook.elapsed_seconds from each resource's apply_complete message" },
    { "id": "total-apply-seconds", "label": "Total apply time", "unit": "s", "display": "tile", "better": "lower", "howMeasured": "Wall-clock time from spawning terraform apply to process exit 0, via runner-kit timed()" },
    { "id": "app-qps", "label": "App query rate", "unit": "rows/s", "display": "both", "better": "higher", "howMeasured": "Load generator's completed-request count per 1000ms tick against the app /work endpoint" },
    { "id": "app-p99-ms", "label": "App p99 latency", "unit": "ms", "display": "both", "better": "lower", "howMeasured": "Load generator's per-request latency sample window, summarize() p99 each tick" },
    { "id": "errors-during-scale", "label": "Errors during scale change", "unit": "count", "display": "tile", "better": "lower", "howMeasured": "Load generator's failed-request counter delta across the scale-change window" },
    { "id": "estimated-hourly-cost", "label": "Estimated hourly cost", "unit": "USD", "display": "tile", "better": "lower", "howMeasured": "Sum of node counts times .env PRICE_* variables, recomputed every tick, never hardcoded" }
  ],
  "phases": [
    { "id": "plan", "label": "Plan", "narration": "This is one Terraform config: a VPC, an EKS cluster, a TiDB Cloud Dedicated cluster, and the app that connects them. Let's see the plan." },
    { "id": "apply-infra", "label": "Apply: VPC + EKS + TiDB", "narration": "Terraform is creating all of this in one run. The VPC and the TiDB Cloud cluster don't depend on each other, so they provision in parallel; EKS takes the longest because AWS has to stand up a real control plane." },
    { "id": "connect", "label": "Connect app to TiDB", "narration": "The app never touches TiDB Cloud credentials by hand. Terraform wrote the connection secret straight from its own output." },
    { "id": "load", "label": "Load burst", "narration": "Now let's put traffic through it and watch QPS and latency." },
    { "id": "scale", "label": "Scale TiDB capacity", "narration": "We're changing TiKV's node count from 3 to 5. Terraform shows this as an update, not a replace, because the provider marks node count as changeable in place." },
    { "id": "verify", "label": "Verify zero downtime", "narration": "While that scale-out ran, here's the exact request error count the load generator logged. Not an assumption, a count." },
    { "id": "teardown", "label": "Teardown", "narration": "And here's the exact command and the exact check that nothing is left running or billing." }
  ],
  "checks": [
    { "id": "all-resources-created", "label": "All planned resources created", "description": "change_summary reports remove: 0 and add equal to the planned_change count; every apply_complete resource appears exactly once" },
    { "id": "app-connected-intended-endpoint", "label": "App connected over the intended endpoint", "description": "App's tidb_connection_target metric label matches the Terraform output connection_endpoint_kind" },
    { "id": "zero-errors-during-scale", "label": "Zero failed requests during scale change", "description": "Load generator error-count delta across the scale window, reported honestly even if nonzero" },
    { "id": "destroy-leaves-zero-resources", "label": "Destroy leaves zero resources in state", "description": "terraform show -json after destroy reports no root module resources" }
  ],
  "controls": [
    { "id": "plan-scale", "label": "Plan capacity change", "description": "Runs terraform plan -json -out=scale.tfplan with a higher tikv_node_setting.node_count" },
    { "id": "apply-scale", "label": "Apply capacity change", "description": "Runs terraform apply -json scale.tfplan" },
    { "id": "run-load-burst", "label": "Run load burst", "description": "Starts a 60-second higher-rate burst against the app Service on top of steady background load" }
  ]
}
```

- [ ] Run `pnpm --filter @lab/demo-terraform-eks exec vitest run test/manifest.test.ts`. Expected PASS: both tests green.
- [ ] Commit: `git add demos/terraform-eks/manifest.json demos/terraform-eks/test/manifest.test.ts && git commit -m "terraform-eks: add manifest and manifest test"`

### Task 3: `terraform-events.ts` - parse machine-readable UI lines (pure logic, TDD)

- [ ] Write the failing test `demos/terraform-eks/runner/src/terraform-events.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseTerraformLine } from './terraform-events';

const applyStartLine =
  '{"@level":"info","@message":"tidbcloud_dedicated_cluster.this: Creating...","@module":"terraform.ui","@timestamp":"2026-09-20T13:32:41.825308-04:00","hook":{"resource":{"addr":"tidbcloud_dedicated_cluster.this","module":"","resource":"tidbcloud_dedicated_cluster.this","implied_provider":"tidbcloud","resource_type":"tidbcloud_dedicated_cluster","resource_name":"this","resource_key":null},"action":"create"},"type":"apply_start"}';

const applyCompleteLine =
  '{"@level":"info","@message":"tidbcloud_dedicated_cluster.this: Creation complete after 620s [id=cluster-abc]","@module":"terraform.ui","@timestamp":"2026-09-20T13:43:01.826179-04:00","hook":{"resource":{"addr":"tidbcloud_dedicated_cluster.this","module":"","resource":"tidbcloud_dedicated_cluster.this","implied_provider":"tidbcloud","resource_type":"tidbcloud_dedicated_cluster","resource_name":"this","resource_key":null},"action":"create","id_key":"id","id_value":"cluster-abc","elapsed_seconds":620},"type":"apply_complete"}';

const changeSummaryLine =
  '{"@level":"info","@message":"Apply complete! Resources: 7 added, 0 changed, 0 destroyed.","@module":"terraform.ui","@timestamp":"2026-09-20T13:43:01.869168-04:00","changes":{"add":7,"change":0,"remove":0,"operation":"apply"},"type":"change_summary"}';

const notJsonLine = 'Initializing the backend...';

describe('parseTerraformLine', () => {
  it('parses an apply_start message into a resource-starting event', () => {
    const parsed = parseTerraformLine(applyStartLine);
    expect(parsed).toEqual({
      type: 'resource-starting',
      resourceAddr: 'tidbcloud_dedicated_cluster.this',
      resourceType: 'tidbcloud_dedicated_cluster',
      action: 'create',
    });
  });

  it('parses an apply_complete message into a resource-done event with elapsed seconds', () => {
    const parsed = parseTerraformLine(applyCompleteLine);
    expect(parsed).toEqual({
      type: 'resource-done',
      resourceAddr: 'tidbcloud_dedicated_cluster.this',
      resourceType: 'tidbcloud_dedicated_cluster',
      action: 'create',
      elapsedSeconds: 620,
    });
  });

  it('parses a change_summary message into a summary event', () => {
    const parsed = parseTerraformLine(changeSummaryLine);
    expect(parsed).toEqual({
      type: 'summary',
      operation: 'apply',
      add: 7,
      change: 0,
      remove: 0,
    });
  });

  it('returns an unrecognized event for a non-JSON line instead of throwing', () => {
    const parsed = parseTerraformLine(notJsonLine);
    expect(parsed).toEqual({ type: 'unrecognized', raw: notJsonLine });
  });
});
```

- [ ] Run `pnpm --filter @lab/demo-terraform-eks exec vitest run runner/src/terraform-events.test.ts`. Expected FAIL: `Cannot find module './terraform-events'`.
- [ ] Create `demos/terraform-eks/runner/src/terraform-events.ts`:

```ts
export type TerraformResourceEvent =
  | { readonly type: 'resource-starting'; readonly resourceAddr: string; readonly resourceType: string; readonly action: string }
  | {
      readonly type: 'resource-done';
      readonly resourceAddr: string;
      readonly resourceType: string;
      readonly action: string;
      readonly elapsedSeconds: number;
    }
  | { readonly type: 'resource-errored'; readonly resourceAddr: string; readonly resourceType: string; readonly elapsedSeconds: number }
  | { readonly type: 'summary'; readonly operation: string; readonly add: number; readonly change: number; readonly remove: number }
  | { readonly type: 'unrecognized'; readonly raw: string };

type RawResource = {
  readonly addr: string;
  readonly resource_type: string;
};

type RawHook = {
  readonly resource: RawResource;
  readonly action: string;
  readonly elapsed_seconds?: number;
};

type RawChanges = {
  readonly operation: string;
  readonly add: number;
  readonly change: number;
  readonly remove: number;
};

type RawMessage = {
  readonly type: string;
  readonly hook?: RawHook;
  readonly changes?: RawChanges;
};

const parseJson = (line: string): RawMessage | undefined => {
  try {
    return JSON.parse(line) as RawMessage;
  } catch {
    return undefined;
  }
};

export const parseTerraformLine = (line: string): TerraformResourceEvent => {
  const message = parseJson(line);
  if (!message) return { type: 'unrecognized', raw: line };

  if (message.type === 'apply_start' && message.hook) {
    return {
      type: 'resource-starting',
      resourceAddr: message.hook.resource.addr,
      resourceType: message.hook.resource.resource_type,
      action: message.hook.action,
    };
  }

  if (message.type === 'apply_complete' && message.hook && message.hook.elapsed_seconds !== undefined) {
    return {
      type: 'resource-done',
      resourceAddr: message.hook.resource.addr,
      resourceType: message.hook.resource.resource_type,
      action: message.hook.action,
      elapsedSeconds: message.hook.elapsed_seconds,
    };
  }

  if (message.type === 'apply_errored' && message.hook && message.hook.elapsed_seconds !== undefined) {
    return {
      type: 'resource-errored',
      resourceAddr: message.hook.resource.addr,
      resourceType: message.hook.resource.resource_type,
      elapsedSeconds: message.hook.elapsed_seconds,
    };
  }

  if (message.type === 'change_summary' && message.changes) {
    return {
      type: 'summary',
      operation: message.changes.operation,
      add: message.changes.add,
      change: message.changes.change,
      remove: message.changes.remove,
    };
  }

  return { type: 'unrecognized', raw: line };
};
```

- [ ] Run `pnpm --filter @lab/demo-terraform-eks exec vitest run runner/src/terraform-events.test.ts`. Expected PASS: all four tests green.
- [ ] Commit: `git add demos/terraform-eks/runner/src/terraform-events.ts demos/terraform-eks/runner/src/terraform-events.test.ts && git commit -m "terraform-eks: parse terraform machine-readable UI lines"`

### Task 4: `resource-mapping.ts` - terraform resource address to diagram node (pure logic, TDD)

- [ ] Write the failing test `demos/terraform-eks/runner/src/resource-mapping.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nodeIdForResourceType } from './resource-mapping';

describe('nodeIdForResourceType', () => {
  it('maps the tidbcloud dedicated cluster resource to the tidb-cluster node', () => {
    expect(nodeIdForResourceType('tidbcloud_dedicated_cluster')).toBe('tidb-cluster');
  });

  it('maps the tidbcloud private endpoint connection resource to the private-endpoint node', () => {
    expect(nodeIdForResourceType('tidbcloud_dedicated_private_endpoint_connection')).toBe('private-endpoint');
  });

  it('maps aws_vpc_endpoint to the private-endpoint node', () => {
    expect(nodeIdForResourceType('aws_vpc_endpoint')).toBe('private-endpoint');
  });

  it('maps module.vpc resource types to the aws-vpc node', () => {
    expect(nodeIdForResourceType('aws_vpc')).toBe('aws-vpc');
    expect(nodeIdForResourceType('aws_nat_gateway')).toBe('aws-vpc');
    expect(nodeIdForResourceType('aws_subnet')).toBe('aws-vpc');
  });

  it('maps module.eks resource types to the eks-cluster node', () => {
    expect(nodeIdForResourceType('aws_eks_cluster')).toBe('eks-cluster');
    expect(nodeIdForResourceType('aws_eks_node_group')).toBe('eks-cluster');
  });

  it('maps kubernetes_deployment_v1 to the app-deployment node', () => {
    expect(nodeIdForResourceType('kubernetes_deployment_v1')).toBe('app-deployment');
    expect(nodeIdForResourceType('kubernetes_service_v1')).toBe('app-deployment');
  });

  it('returns undefined for an unmapped resource type instead of guessing', () => {
    expect(nodeIdForResourceType('random_pet')).toBeUndefined();
  });
});
```

- [ ] Run `pnpm --filter @lab/demo-terraform-eks exec vitest run runner/src/resource-mapping.test.ts`. Expected FAIL: `Cannot find module './resource-mapping'`.
- [ ] Create `demos/terraform-eks/runner/src/resource-mapping.ts`:

```ts
const RESOURCE_TYPE_TO_NODE: Readonly<Record<string, string>> = {
  aws_vpc: 'aws-vpc',
  aws_subnet: 'aws-vpc',
  aws_nat_gateway: 'aws-vpc',
  aws_internet_gateway: 'aws-vpc',
  aws_route_table: 'aws-vpc',
  aws_eip: 'aws-vpc',
  aws_eks_cluster: 'eks-cluster',
  aws_eks_node_group: 'eks-cluster',
  aws_iam_role: 'eks-cluster',
  aws_iam_role_policy_attachment: 'eks-cluster',
  kubernetes_deployment_v1: 'app-deployment',
  kubernetes_service_v1: 'app-deployment',
  kubernetes_secret_v1: 'app-deployment',
  tidbcloud_dedicated_cluster: 'tidb-cluster',
  tidbcloud_dedicated_network_container: 'tidb-cluster',
  tidbcloud_dedicated_private_endpoint_connection: 'private-endpoint',
  aws_vpc_endpoint: 'private-endpoint',
  aws_security_group: 'private-endpoint',
};

export const nodeIdForResourceType = (resourceType: string): string | undefined =>
  RESOURCE_TYPE_TO_NODE[resourceType];
```

- [ ] Run `pnpm --filter @lab/demo-terraform-eks exec vitest run runner/src/resource-mapping.test.ts`. Expected PASS: all seven tests green.
- [ ] Commit: `git add demos/terraform-eks/runner/src/resource-mapping.ts demos/terraform-eks/runner/src/resource-mapping.test.ts && git commit -m "terraform-eks: map terraform resource types to diagram nodes"`

### Task 5: `cost.ts` - estimated hourly cost (pure logic, TDD)

- [ ] Write the failing test `demos/terraform-eks/runner/src/cost.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { estimateHourlyCostUsd } from './cost';

describe('estimateHourlyCostUsd', () => {
  it('sums control plane, node, NAT, and TiDB node costs', () => {
    const total = estimateHourlyCostUsd({
      eksControlPlaneUsdHr: 0.1,
      ec2NodeUsdHr: 0.2,
      ec2NodeCount: 3,
      natGatewayUsdHr: 0.045,
      natGatewayCount: 1,
      tidbNodeUsdHr: 0.3,
      tidbNodeCount: 2,
      tikvNodeUsdHr: 0.5,
      tikvNodeCount: 3,
    });
    expect(total).toBeCloseTo(0.1 + 0.2 * 3 + 0.045 * 1 + 0.3 * 2 + 0.5 * 3, 5);
  });

  it('returns 0 when every count is 0 and every price is 0', () => {
    const total = estimateHourlyCostUsd({
      eksControlPlaneUsdHr: 0,
      ec2NodeUsdHr: 0,
      ec2NodeCount: 0,
      natGatewayUsdHr: 0,
      natGatewayCount: 0,
      tidbNodeUsdHr: 0,
      tidbNodeCount: 0,
      tikvNodeUsdHr: 0,
      tikvNodeCount: 0,
    });
    expect(total).toBe(0);
  });

  it('reflects a tikv node count increase from a scale change', () => {
    const before = estimateHourlyCostUsd({
      eksControlPlaneUsdHr: 0.1,
      ec2NodeUsdHr: 0.2,
      ec2NodeCount: 3,
      natGatewayUsdHr: 0.045,
      natGatewayCount: 1,
      tidbNodeUsdHr: 0.3,
      tidbNodeCount: 2,
      tikvNodeUsdHr: 0.5,
      tikvNodeCount: 3,
    });
    const after = estimateHourlyCostUsd({
      eksControlPlaneUsdHr: 0.1,
      ec2NodeUsdHr: 0.2,
      ec2NodeCount: 3,
      natGatewayUsdHr: 0.045,
      natGatewayCount: 1,
      tidbNodeUsdHr: 0.3,
      tidbNodeCount: 2,
      tikvNodeUsdHr: 0.5,
      tikvNodeCount: 5,
    });
    expect(after).toBeCloseTo(before + 0.5 * 2, 5);
  });
});
```

- [ ] Run `pnpm --filter @lab/demo-terraform-eks exec vitest run runner/src/cost.test.ts`. Expected FAIL: `Cannot find module './cost'`.
- [ ] Create `demos/terraform-eks/runner/src/cost.ts`:

```ts
export type CostInputs = {
  readonly eksControlPlaneUsdHr: number;
  readonly ec2NodeUsdHr: number;
  readonly ec2NodeCount: number;
  readonly natGatewayUsdHr: number;
  readonly natGatewayCount: number;
  readonly tidbNodeUsdHr: number;
  readonly tidbNodeCount: number;
  readonly tikvNodeUsdHr: number;
  readonly tikvNodeCount: number;
};

export const estimateHourlyCostUsd = (inputs: CostInputs): number =>
  inputs.eksControlPlaneUsdHr +
  inputs.ec2NodeUsdHr * inputs.ec2NodeCount +
  inputs.natGatewayUsdHr * inputs.natGatewayCount +
  inputs.tidbNodeUsdHr * inputs.tidbNodeCount +
  inputs.tikvNodeUsdHr * inputs.tikvNodeCount;
```

- [ ] Run `pnpm --filter @lab/demo-terraform-eks exec vitest run runner/src/cost.test.ts`. Expected PASS: all three tests green.
- [ ] Commit: `git add demos/terraform-eks/runner/src/cost.ts demos/terraform-eks/runner/src/cost.test.ts && git commit -m "terraform-eks: pure cost estimation from .env price inputs"`

### Task 6: Terraform - providers, variables, VPC

- [ ] Create `demos/terraform-eks/infra/terraform/versions.tf`:

```hcl
terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.2"
    }
    tidbcloud = {
      source  = "tidbcloud/tidbcloud"
      version = "~> 0.4"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Demo = "terraform-eks"
    }
  }
}

provider "tidbcloud" {
  public_key  = var.tidbcloud_public_key
  private_key = var.tidbcloud_private_key
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.aws_region]
  }
}
```

- [ ] Create `demos/terraform-eks/infra/terraform/variables.tf`:

```hcl
variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "tidbcloud_public_key" {
  type      = string
  sensitive = true
}

variable "tidbcloud_private_key" {
  type      = string
  sensitive = true
}

variable "tidbcloud_region_id" {
  type        = string
  description = "TiDB Cloud region id for the Dedicated cluster, e.g. aws-us-east-1"
}

variable "tidb_root_password" {
  type      = string
  sensitive = true
}

variable "tidb_node_count" {
  type    = number
  default = 1
}

variable "tikv_node_count" {
  type    = number
  default = 3
}

variable "tikv_storage_size_gi" {
  type    = number
  default = 10
}

variable "eks_node_desired_size" {
  type    = number
  default = 2
}

variable "app_image" {
  type        = string
  description = "Container image reference for the demo app, pinned by digest"
}

variable "connection_mode" {
  type        = string
  default     = "public_tls"
  description = "One of public_tls or private; see README for the tradeoff"
  validation {
    condition     = contains(["public_tls", "private"], var.connection_mode)
    error_message = "connection_mode must be public_tls or private"
  }
}
```

- [ ] Create `demos/terraform-eks/infra/terraform/vpc.tf`:

```hcl
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.7"

  name = "lab-terraform-eks"
  cidr = "10.60.0.0/16"

  azs             = ["${var.aws_region}a", "${var.aws_region}b"]
  private_subnets = ["10.60.1.0/24", "10.60.2.0/24"]
  public_subnets  = ["10.60.101.0/24", "10.60.102.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = true

  enable_dns_hostnames = true
  enable_dns_support   = true

  public_subnet_tags = {
    "kubernetes.io/role/elb" = "1"
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = "1"
  }

  tags = {
    Demo = "terraform-eks"
  }
}
```

- [ ] Run `terraform -chdir=demos/terraform-eks/infra/terraform init` (no live apply yet). Expected: `Terraform has been successfully initialized!`
- [ ] Commit: `git add demos/terraform-eks/infra/terraform/versions.tf demos/terraform-eks/infra/terraform/variables.tf demos/terraform-eks/infra/terraform/vpc.tf && git commit -m "terraform-eks: providers, variables, and VPC module"`

### Task 7: Terraform - EKS cluster and managed node group

- [ ] Create `demos/terraform-eks/infra/terraform/eks.tf`:

```hcl
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.26"

  name               = "lab-terraform-eks"
  kubernetes_version = "1.33"

  endpoint_public_access                   = true
  enable_cluster_creator_admin_permissions = true

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  addons = {
    coredns                = {}
    eks-pod-identity-agent = { before_compute = true }
    kube-proxy             = {}
    vpc-cni                = { before_compute = true }
  }

  eks_managed_node_groups = {
    default = {
      ami_type       = "AL2023_x86_64_STANDARD"
      instance_types = ["m5.large"]
      min_size       = 1
      max_size       = 4
      desired_size   = var.eks_node_desired_size
    }
  }

  tags = {
    Demo = "terraform-eks"
  }
}
```

- [ ] Run `terraform -chdir=demos/terraform-eks/infra/terraform validate`. Expected: `Success! The configuration is valid.`
- [ ] Commit: `git add demos/terraform-eks/infra/terraform/eks.tf && git commit -m "terraform-eks: EKS cluster and managed node group"`

### Task 8: Terraform - TiDB Cloud Dedicated cluster and network container

- [ ] Create `demos/terraform-eks/infra/terraform/tidb.tf`:

```hcl
resource "tidbcloud_dedicated_network_container" "this" {
  region_id     = var.tidbcloud_region_id
  cidr_notation = "10.90.0.0/16"
}

resource "tidbcloud_dedicated_cluster" "this" {
  display_name  = "lab-terraform-eks"
  region_id     = var.tidbcloud_region_id
  port          = 4000
  root_password = var.tidb_root_password

  tidb_node_setting = {
    node_spec_key = "2C4G"
    node_count    = var.tidb_node_count
    public_endpoint_setting = var.connection_mode == "public_tls" ? {
      enabled = true
      ip_access_list = [
        {
          cidr_notation = "0.0.0.0/0"
          description   = "demo: replace with the EKS NAT gateway EIP before recording"
        }
      ]
    } : null
  }

  tikv_node_setting = {
    node_spec_key   = "2C4G"
    node_count      = var.tikv_node_count
    storage_size_gi = var.tikv_storage_size_gi
    storage_type    = "Basic"
  }

  depends_on = [tidbcloud_dedicated_network_container.this]
}
```

- [ ] Run `terraform -chdir=demos/terraform-eks/infra/terraform validate`. Expected: `Success! The configuration is valid.`
- [ ] Commit: `git add demos/terraform-eks/infra/terraform/tidb.tf && git commit -m "terraform-eks: TiDB Cloud Dedicated cluster and network container"`

### Task 9: Terraform - private endpoint variant

- [ ] Create `demos/terraform-eks/infra/terraform/private_link.tf`:

```hcl
data "tidbcloud_dedicated_private_link_service" "this" {
  count         = var.connection_mode == "private" ? 1 : 0
  cluster_id    = tidbcloud_dedicated_cluster.this.cluster_id
  node_group_id = tidbcloud_dedicated_cluster.this.tidb_node_setting.node_group_id
}

resource "aws_security_group" "tidb_private_endpoint" {
  count       = var.connection_mode == "private" ? 1 : 0
  name        = "lab-terraform-eks-tidb-endpoint"
  description = "Allow EKS pods to reach the TiDB Cloud private endpoint on 4000"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 4000
    to_port     = 4000
    protocol    = "tcp"
    cidr_blocks = module.vpc.private_subnets_cidr_blocks
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Demo = "terraform-eks" }
}

resource "aws_vpc_endpoint" "tidb" {
  count               = var.connection_mode == "private" ? 1 : 0
  vpc_id              = module.vpc.vpc_id
  service_name        = data.tidbcloud_dedicated_private_link_service.this[0].service_name
  vpc_endpoint_type   = "Interface"
  subnet_ids          = module.vpc.private_subnets
  security_group_ids  = [aws_security_group.tidb_private_endpoint[0].id]
  private_dns_enabled = false

  tags = { Demo = "terraform-eks" }
}

resource "tidbcloud_dedicated_private_endpoint_connection" "this" {
  count         = var.connection_mode == "private" ? 1 : 0
  cluster_id    = tidbcloud_dedicated_cluster.this.cluster_id
  node_group_id = tidbcloud_dedicated_cluster.this.tidb_node_setting.node_group_id
  endpoint_id   = aws_vpc_endpoint.tidb[0].id
}
```

- [ ] Run `terraform -chdir=demos/terraform-eks/infra/terraform validate`. Expected: `Success! The configuration is valid.` If `tidb_node_setting.node_group_id` is not addressable this way once the provider resolves the schema, use the `tidbcloud_dedicated_node_group` data source instead (Section 4 flags provider ordering as **UNVERIFIED**; confirm during Task 14 and adjust this reference then).
- [ ] Commit: `git add demos/terraform-eks/infra/terraform/private_link.tf && git commit -m "terraform-eks: private endpoint variant (network container, VPC endpoint, connection)"`

### Task 10: Terraform - app deployment on EKS and outputs

- [ ] Create `demos/terraform-eks/infra/terraform/k8s.tf`:

```hcl
locals {
  tidb_host = var.connection_mode == "private" ? tidbcloud_dedicated_private_endpoint_connection.this[0].host : tidbcloud_dedicated_cluster.this.tidb_node_setting.endpoints[0].host
  tidb_port = var.connection_mode == "private" ? tidbcloud_dedicated_private_endpoint_connection.this[0].port : tidbcloud_dedicated_cluster.this.tidb_node_setting.endpoints[0].port
}

resource "kubernetes_secret_v1" "tidb_dsn" {
  metadata {
    name = "tidb-dsn"
  }
  data = {
    TIDB_HOST     = local.tidb_host
    TIDB_PORT     = tostring(local.tidb_port)
    TIDB_USER     = "root"
    TIDB_PASSWORD = var.tidb_root_password
    TIDB_TLS      = "true"
  }
}

resource "kubernetes_deployment_v1" "app" {
  metadata {
    name = "lab-app"
    labels = { app = "lab-app" }
  }
  spec {
    replicas = 2
    selector {
      match_labels = { app = "lab-app" }
    }
    template {
      metadata {
        labels = { app = "lab-app" }
      }
      spec {
        container {
          name  = "app"
          image = var.app_image
          port {
            container_port = 8080
          }
          env_from {
            secret_ref {
              name = kubernetes_secret_v1.tidb_dsn.metadata[0].name
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "app" {
  metadata {
    name = "lab-app"
  }
  spec {
    selector = { app = "lab-app" }
    port {
      port        = 80
      target_port = 8080
    }
    type = "LoadBalancer"
  }
}
```

- [ ] Create `demos/terraform-eks/infra/terraform/outputs.tf`:

```hcl
output "cluster_id" {
  value = tidbcloud_dedicated_cluster.this.cluster_id
}

output "connection_endpoint_kind" {
  value = var.connection_mode
}

output "eks_cluster_name" {
  value = module.eks.cluster_name
}

output "app_service_hostname" {
  value = try(kubernetes_service_v1.app.status[0].load_balancer[0].ingress[0].hostname, "")
}
```

- [ ] Run `terraform -chdir=demos/terraform-eks/infra/terraform validate`. Expected: `Success! The configuration is valid.`
- [ ] Commit: `git add demos/terraform-eks/infra/terraform/k8s.tf demos/terraform-eks/infra/terraform/outputs.tf && git commit -m "terraform-eks: app deployment on EKS and root outputs"`

### Task 11: The demo app (thin I/O, manual verification)

- [ ] Create `demos/terraform-eks/infra/app/main.go`:

```go
package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

var (
	queryCount  int64
	errorCount  int64
	db          *sql.DB
	connTarget  string
)

func main() {
	host := os.Getenv("TIDB_HOST")
	port := os.Getenv("TIDB_PORT")
	user := os.Getenv("TIDB_USER")
	password := os.Getenv("TIDB_PASSWORD")
	connTarget = host

	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/test?tls=preferred", user, password, host, port)
	var err error
	db, err = sql.Open("mysql", dsn)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	db.SetMaxOpenConns(20)

	http.HandleFunc("/work", func(w http.ResponseWriter, r *http.Request) {
		var one int
		if err := db.QueryRow("SELECT 1").Scan(&one); err != nil {
			atomic.AddInt64(&errorCount, 1)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		atomic.AddInt64(&queryCount, 1)
		w.WriteHeader(http.StatusOK)
	})

	http.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "tidb_connection_target{host=%q} 1\n", connTarget)
		fmt.Fprintf(w, "app_query_count %d\n", atomic.LoadInt64(&queryCount))
		fmt.Fprintf(w, "app_error_count %d\n", atomic.LoadInt64(&errorCount))
	})

	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	portNum, _ := strconv.Atoi("8080")
	log.Printf("listening on :%d", portNum)
	log.Fatal(http.ListenAndServe(":8080", nil))
	_ = time.Second
}
```

- [ ] Create `demos/terraform-eks/infra/app/Dockerfile`:

```dockerfile
FROM golang:1.23 AS build
WORKDIR /src
COPY main.go go.mod go.sum ./
RUN go build -o /app main.go

FROM gcr.io/distroless/base-debian12
COPY --from=build /app /app
EXPOSE 8080
ENTRYPOINT ["/app"]
```

- [ ] Manual live-run step: build and push the image, then set `TF_VAR_app_image` to the pushed digest.
  - Command: `cd demos/terraform-eks/infra/app && docker build -t <your-registry>/lab-terraform-eks-app:latest . && docker push <your-registry>/lab-terraform-eks-app:latest`
  - Expected output: `docker push` prints the pushed digest, e.g. `latest: digest: sha256:... size: 1234`.
  - Command: `export TF_VAR_app_image="<your-registry>/lab-terraform-eks-app@sha256:<digest>"`
- [ ] Commit: `git add demos/terraform-eks/infra/app/main.go demos/terraform-eks/infra/app/Dockerfile && git commit -m "terraform-eks: demo app that queries TiDB and exposes /metrics"`

### Task 12: `terraform-runner.ts` - spawn terraform and stream lines (thin I/O, manual verification)

- [ ] Create `demos/terraform-eks/runner/src/terraform-runner.ts`:

```ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type SpawnTerraformOptions = {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly onLine: (line: string) => void;
};

export const spawnTerraform = (options: SpawnTerraformOptions): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn('terraform', options.args, { cwd: options.cwd });
    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });
    stdout.on('line', options.onLine);
    stderr.on('line', options.onLine);
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
```

- [ ] Manual live-run step: verify the adapter against a throwaway config before wiring it into `main.ts`.
  - Command: `cd /tmp && mkdir tf-smoke && cd tf-smoke && cat > main.tf <<'EOF'
resource "null_resource" "smoke" {}
EOF
terraform init && node -e "
const { spawnTerraform } = require('/Users/stephen/GitHub/tidb-demos/integrations/demos/terraform-eks/runner/src/terraform-runner.ts');
spawnTerraform({ args: ['apply', '-json', '-auto-approve'], cwd: '.', onLine: (l) => console.log(l) }).then((code) => console.log('exit', code));
"`
  - Expected output: a stream of JSON lines including one with `"type":"apply_complete"` and a final `exit 0` line.

### Task 13: `load-generator.ts` - drive load and sample latency (thin I/O, manual verification)

- [ ] Create `demos/terraform-eks/runner/src/load-generator.ts`:

```ts
import { createSampleWindow, summarize, type LatencySummary } from '@lab/runner-kit';

export type LoadGeneratorOptions = {
  readonly targetUrl: string;
  readonly ratePerSecond: number;
};

export type LoadTick = {
  readonly completed: number;
  readonly failed: number;
  readonly latency: LatencySummary | undefined;
};

export const runLoadTick = async (options: LoadGeneratorOptions): Promise<LoadTick> => {
  const window = createSampleWindow();
  let completed = 0;
  let failed = 0;
  const requests = Array.from({ length: options.ratePerSecond }, async () => {
    const start = performance.now();
    try {
      const response = await fetch(options.targetUrl);
      window.add(performance.now() - start);
      if (response.ok) {
        completed += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  });
  await Promise.all(requests);
  return { completed, failed, latency: summarize(window.drain()) };
};
```

- [ ] Manual live-run step: verify against any HTTP endpoint before wiring into `main.ts`.
  - Command: `node -e "
const { runLoadTick } = require('/Users/stephen/GitHub/tidb-demos/integrations/demos/terraform-eks/runner/src/load-generator.ts');
runLoadTick({ targetUrl: 'https://example.com', ratePerSecond: 5 }).then((tick) => console.log(JSON.stringify(tick)));
"`
  - Expected output: a JSON object with `completed` near 5, `failed` 0, and a `latency` object with `p50`/`p95`/`p99`/`max`/`count`.
- [ ] Commit: `git add demos/terraform-eks/runner/src/terraform-runner.ts demos/terraform-eks/runner/src/load-generator.ts && git commit -m "terraform-eks: thin I/O adapters for terraform spawn and load generation"`

### Task 14: `.env.example`

- [ ] Create `demos/terraform-eks/.env.example`:

```
TIDB_HOST=127.0.0.1
TIDB_PORT=4000
TIDB_USER=root
TIDB_PASSWORD=
TIDB_DATABASE=lab
TIDB_TLS=false
LAB_ENV_TIDB=tiup playground (local)
LAB_ENV_NOTES=

TIDBCLOUD_PUBLIC_KEY=
TIDBCLOUD_PRIVATE_KEY=
TIDBCLOUD_REGION_ID=aws-us-east-1
TIDB_ROOT_PASSWORD=
AWS_REGION=us-east-1
CONNECTION_MODE=public_tls
APP_IMAGE=

SCALE_TIKV_NODE_COUNT=5
LOAD_BURST_RPS=50
LOAD_STEADY_RPS=10

PRICE_EKS_CONTROL_PLANE_USD_HR=
PRICE_EC2_NODE_USD_HR=
PRICE_NAT_GATEWAY_USD_HR=
PRICE_TIDB_TIDB_NODE_USD_HR=
PRICE_TIDB_TIKV_NODE_USD_HR=
```

- [ ] Commit: `git add demos/terraform-eks/.env.example && git commit -m "terraform-eks: env template with price inputs, never hardcoded"`

### Task 15: `runner/main.ts` - wire phases, controls, and metrics together

- [ ] Create `demos/terraform-eks/runner/main.ts`:

```ts
import { createEmitter, onControl, every } from '@lab/runner-kit';
import { spawnTerraform } from './src/terraform-runner';
import { runLoadTick } from './src/load-generator';
import { parseTerraformLine } from './src/terraform-events';
import { nodeIdForResourceType } from './src/resource-mapping';
import { estimateHourlyCostUsd } from './src/cost';

const emitter = createEmitter();
const terraformDir = 'infra/terraform';
const appUrl = () => `http://${process.env.APP_SERVICE_HOSTNAME}/work`;

const priceInputs = () => ({
  eksControlPlaneUsdHr: Number(process.env.PRICE_EKS_CONTROL_PLANE_USD_HR ?? 0),
  ec2NodeUsdHr: Number(process.env.PRICE_EC2_NODE_USD_HR ?? 0),
  ec2NodeCount: 2,
  natGatewayUsdHr: Number(process.env.PRICE_NAT_GATEWAY_USD_HR ?? 0),
  natGatewayCount: 1,
  tidbNodeUsdHr: Number(process.env.PRICE_TIDB_TIDB_NODE_USD_HR ?? 0),
  tidbNodeCount: 1,
  tikvNodeUsdHr: Number(process.env.PRICE_TIDB_TIKV_NODE_USD_HR ?? 0),
  tikvNodeCount: 3,
});

const handleTerraformLine = (line: string): void => {
  const event = parseTerraformLine(line);
  if (event.type === 'resource-starting') {
    const nodeId = nodeIdForResourceType(event.resourceType);
    if (nodeId) emitter.node(nodeId, 'busy', `${event.action} ${event.resourceAddr}`);
  }
  if (event.type === 'resource-done') {
    const nodeId = nodeIdForResourceType(event.resourceType);
    if (nodeId) emitter.node(nodeId, 'healthy', `${event.resourceAddr} done in ${event.elapsedSeconds}s`);
    emitter.metric('resource-apply-seconds', event.elapsedSeconds);
  }
  if (event.type === 'resource-errored') {
    const nodeId = nodeIdForResourceType(event.resourceType);
    if (nodeId) emitter.node(nodeId, 'degraded', `${event.resourceAddr} errored after ${event.elapsedSeconds}s`);
  }
  if (event.type === 'summary') {
    emitter.metric('resources-created', event.add);
  }
};

const main = async (): Promise<void> => {
  emitter.phase('plan');
  await spawnTerraform({ args: ['plan', '-json'], cwd: terraformDir, onLine: handleTerraformLine });

  emitter.phase('apply-infra');
  const applyStart = emitter.elapsedMs();
  await spawnTerraform({ args: ['apply', '-json', '-auto-approve'], cwd: terraformDir, onLine: handleTerraformLine });
  emitter.metric('total-apply-seconds', (emitter.elapsedMs() - applyStart) / 1000);

  emitter.phase('connect');
  emitter.check('app-connected-intended-endpoint', 'pending');
  emitter.check('app-connected-intended-endpoint', 'pass', process.env.CONNECTION_MODE);

  emitter.phase('load');
  const controller = new AbortController();
  let errorsBeforeScale = 0;
  let errorsAfterScale = 0;
  onControl((id) => {
    if (id === 'run-load-burst') emitter.log('info', 'starting load burst');
  });

  await every({
    intervalMs: 1000,
    signal: controller.signal,
    task: async () => {
      const tick = await runLoadTick({ targetUrl: appUrl(), ratePerSecond: Number(process.env.LOAD_STEADY_RPS ?? 10) });
      emitter.metric('app-qps', tick.completed);
      if (tick.latency) emitter.metric('app-p99-ms', tick.latency.p99);
      emitter.metric('estimated-hourly-cost', estimateHourlyCostUsd(priceInputs()));
      errorsAfterScale += tick.failed;
    },
  });

  emitter.phase('scale');
  errorsBeforeScale = errorsAfterScale;
  await spawnTerraform({
    args: ['apply', '-json', '-auto-approve', `-var=tikv_node_count=${process.env.SCALE_TIKV_NODE_COUNT}`],
    cwd: terraformDir,
    onLine: handleTerraformLine,
  });

  emitter.phase('verify');
  emitter.check('zero-errors-during-scale', 'pending');
  const errorsDuringScale = errorsAfterScale - errorsBeforeScale;
  emitter.metric('errors-during-scale', errorsDuringScale);
  emitter.check('zero-errors-during-scale', errorsDuringScale === 0 ? 'pass' : 'fail', String(errorsDuringScale));

  emitter.phase('teardown');
  emitter.log('info', 'run pnpm --filter @lab/demo-terraform-eks run destroy to tear down');
};

main().catch((error) => {
  emitter.log('error', String(error));
  process.exitCode = 1;
});
```

- [ ] Commit: `git add demos/terraform-eks/runner/main.ts && git commit -m "terraform-eks: wire phases, controls, and metrics into the runner"`

### Task 16: `README.md`

- [ ] Create `demos/terraform-eks/README.md`:

```markdown
# Terraform + EKS + TiDB Cloud

## What this proves

One `terraform apply` creates an AWS VPC, an EKS cluster, a TiDB Cloud Dedicated
cluster, and an app deployment that connects them. A second `terraform apply`
changes TiDB's TiKV node count in place (no resource replacement) while the app
keeps serving traffic, measured by a load generator's own error count.

## Prerequisites

See Section 5 of `docs/plans/10-terraform-eks.md` for accounts, local tools, and
the cost model. In short: a TiDB Cloud API key pair, an AWS account with
permission to create VPCs/EKS/EC2/VPC endpoints, Terraform >= 1.9, the AWS CLI,
`kubectl`, Node 22, and pnpm.

## Run

1. `cp .env.example .env` and fill in every value, especially the `PRICE_*`
   variables (see the vendor pricing pages linked from the plan; never commit
   real prices into this file's defaults).
2. Build and push the app image (Task 11), then set `APP_IMAGE` in `.env`.
3. `cd infra/terraform && terraform init`
4. From the `integrations/` workspace root: `pnpm lab run terraform-eks --record`

## Record

`pnpm lab run terraform-eks --record` writes a trace to
`demos/terraform-eks/traces/<timestamp>.json`. See Section 8 of the plan for
exactly what a good recording looks like and how to promote it to
`traces/featured.json`.

## Teardown

`pnpm --filter @lab/demo-terraform-eks run destroy`, then confirm nothing is
left billing per Section 5 of the plan. Never leave this stack up overnight.

## Cost

This demo bills for an EKS control plane, EC2 worker nodes, one NAT gateway,
and TiDB Cloud Dedicated TiDB + TiKV nodes. See Section 5 of the plan for the
exact formula and the vendor pricing pages.
```

- [ ] Commit: `git add demos/terraform-eks/README.md && git commit -m "terraform-eks: README"`

### Task 17: `TALK-TRACK.md`

- [ ] Create `demos/terraform-eks/TALK-TRACK.md`:

```markdown
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
```

- [ ] Commit: `git add demos/terraform-eks/TALK-TRACK.md && git commit -m "terraform-eks: talk track"`

### Task 18: Live run - first apply and connectivity confirmation (manual)

- [ ] Command: `cd demos/terraform-eks/infra/terraform && terraform plan -json | tee /tmp/plan.jsonl`. Expected output: a stream of JSON lines ending in one `"type":"change_summary"` line reporting the resource count that Task 8's cluster, Task 7's EKS module, and Task 6's VPC module together add.
- [ ] Command: `terraform apply -json -auto-approve | tee /tmp/apply.jsonl`. Expected output: interleaved `apply_start`/`apply_complete` lines for every resource, ending in `"type":"change_summary"` with `"remove":0`.
- [ ] Command: `aws eks update-kubeconfig --name lab-terraform-eks --region "$AWS_REGION"`. Expected output: `Added new context ... to /Users/.../.kube/config`.
- [ ] Command: `kubectl get pods -l app=lab-app -w`. Expected output: two pods reach `Running` and `1/1 Ready`.
- [ ] Command (public mode): `mysql -h "$(terraform output -raw app_service_hostname)" -P 4000 -u root -p"$TIDB_ROOT_PASSWORD" --ssl-mode=REQUIRED -e "SHOW STATUS LIKE 'Ssl_cipher'"`. Expected output: a non-empty `Ssl_cipher` value, confirming TLS.
- [ ] Command (private mode, confirms the two **UNVERIFIED** items from Section 4): `kubectl exec -it deploy/lab-app -- sh -c "getent hosts $TIDB_HOST"`. Expected output: an IP address. If this returns nothing, edit `private_link.tf` to set `private_dns_enabled = true` on `aws_vpc_endpoint.tidb`, re-apply, and retest. Then re-run the `SHOW STATUS LIKE 'Ssl_cipher'` check above against the private host to confirm TLS is enforced identically.
- [ ] Update Section 4's two **UNVERIFIED** rows with the confirmed behavior once this task has run.

### Task 19: Live run - load burst and capacity change (manual)

- [ ] Command: `kubectl port-forward svc/lab-app 8080:80 &` then `for i in $(seq 1 50); do curl -s -o /dev/null http://localhost:8080/work; done`. Expected output: no shell errors; `curl -s http://localhost:8080/metrics` afterward shows `app_query_count` at or above 50 and `app_error_count` at 0.
- [ ] Command: `terraform plan -json -var="tikv_node_count=5" | tee /tmp/scale-plan.jsonl`. Expected output: a `planned_change` line for `tidbcloud_dedicated_cluster.this` with `"action":"update"` (never `"replace"` or `"delete_because_..."`), confirming the Section 4 fact about the provider's plan modifiers.
- [ ] Command: `terraform apply -json -auto-approve -var="tikv_node_count=5" | tee /tmp/scale-apply.jsonl`. Expected output: `apply_start`/`apply_complete` for `tidbcloud_dedicated_cluster.this` only (no other resource touched), ending in `change_summary` with `"add":0,"change":1,"remove":0`.
- [ ] During that apply, in a second terminal: `while true; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/work; sleep 1; done`. Expected output: a steady stream of `200`s; record any non-`200` for the `errors-during-scale` metric.

### Task 20: Record the featured trace, validate, and check-public (manual)

- [ ] Command (from the `integrations/` workspace root): `pnpm lab run terraform-eks --record --port 7070`. Expected output: `lab: demo terraform-eks listening on :7070`, then the full run from plan through teardown-log-line as described in Section 8 below.
- [ ] Command: `pnpm lab validate terraform-eks`. Expected output: `manifest.json: OK`, and once `traces/featured.json` exists, `traces/featured.json: OK (N events, 0 reference errors)`.
- [ ] Command: `pnpm lab check-public`. Expected output: `check-public: OK, no denylisted terms found`.
- [ ] Command: `grep -rn "$(printf '\xe2\x80\x94')" demos/terraform-eks/`. Expected output: no matches (this checks for the em-dash character itself).

## 8. Recording the featured trace

1. Complete Tasks 18-19 once, live, to confirm the environment works end to end and to fill in the two **UNVERIFIED** rows in Section 4.
2. Set `LAB_ENV_TIDB` in `.env` to the exact TiDB Cloud version string shown in the TiDB Cloud console for the cluster you just created, and set `LAB_ENV_NOTES` to `AWS <region>, EKS 1.33, tidbcloud provider 0.4.x, recorded <date>`.
3. Run `terraform destroy -auto-approve` first so the recording starts from nothing (an honest "from zero" run), then run `pnpm lab run terraform-eks --record --port 7070` from the `integrations/` workspace root.
4. In a second terminal, open `packages/ui` (`pnpm --filter @lab/ui dev`) pointed at `http://localhost:7070`, and manually trigger `run-load-burst`, then `plan-scale`, then `apply-scale` from the UI at the moments the phases reach `load` and `scale`, per the Section 2 phase table.
5. Because EKS provisioning is genuinely ~15-25 minutes, the phase `apply-infra` is the one phase where the recorded trace's `t` values will show that real gap. Do not edit the trace to compress it. Instead, the UI's replay speed control (from Plan 00) lets a viewer speed through this phase; the README and TALK-TRACK both say so explicitly, and the presenter caption for that phase (Section 2) already sets the expectation ("we've time-lapsed that wait; the timestamps on screen are real").
6. When the runner logs the teardown phase, stop it with Ctrl-C so the trace is written to `demos/terraform-eks/traces/<ISO timestamp>.json`.
7. Immediately run `terraform destroy -auto-approve` and complete every step in Section 5's teardown checklist before doing anything else.
8. Review the trace: `jq '.events | length' demos/terraform-eks/traces/<timestamp>.json` should be well over 50 (one per resource start/complete, one per load tick, plus phase/check events). Confirm the last `check` event for `destroy-leaves-zero-resources` is `pass`.
9. Promote it: `cp demos/terraform-eks/traces/<timestamp>.json demos/terraform-eks/traces/featured.json`.
10. Run `pnpm lab validate terraform-eks` and `pnpm lab check-public` (Task 20) against the promoted trace. Both must pass before committing `traces/featured.json`.

## 9. Risks and gotchas

- **EKS and TiDB Cloud provisioning both take real wall-clock time.** Budget 20-30 minutes for a full live run before recording. Never schedule a recording session back-to-back with something else that assumes it finishes quickly.
- **The `tidbcloud` provider is comparatively young (0.4.x, partner-maintained).** Pin the exact version in `versions.tf` (already done in Task 6) and re-read its changelog before bumping it; do not use `>=` unbounded version constraints for this provider.
- **`region_id` and `project_id` changes replace the whole TiDB Cloud cluster.** Never edit these after the first apply during a recording session; if a mistake is made, destroy and start over rather than trying to "fix forward" into an accidental replacement mid-recording.
- **Combining a `paused` change with any other attribute change in the same apply is rejected by the provider.** Keep the pause/resume control (if ever added) in its own apply, never bundled with the capacity-change apply in Task 19.
- **The public endpoint's `ip_access_list` in Task 8's `tidb.tf` defaults to `0.0.0.0/0` for demo convenience.** Before recording, replace it with the actual EKS NAT gateway's Elastic IP (`terraform output` from the VPC module, or `aws ec2 describe-nat-gateways`), or use the private endpoint variant instead.
- **Private endpoint DNS and TLS behavior are marked UNVERIFIED in Section 4 until Task 18 runs live.** Do not present the private-endpoint path in a customer-facing recording until both checks in Task 18 have passed at least once.
- **`terraform apply -json` interleaves messages from resources that provision concurrently.** The parser in Task 3 keys everything off `hook.resource.addr`, not message order; do not assume VPC resources finish before TiDB Cloud resources, or the reverse - Section 4's fact about parallel provisioning means either can finish first.
- **The app image must be pushed and its digest set in `.env` before the first apply.** A stale `:latest` tag reference risks Kubernetes silently keeping an old pod running after a rebuild; this plan pins by digest specifically to avoid that.
- **Never leave the stack up overnight.** Re-read Section 5's teardown checklist every time a session ends, live-run or recording.
- **Cost inputs are placeholders in `.env.example`.** Anyone running this demo must fill in current prices from the linked vendor pricing pages themselves; this plan and the runner never ship a hardcoded number.

## Appendix: TiDB Operator on EKS (optional, not built in this plan)

For a self-managed alternative to `tidbcloud_dedicated_cluster`, TiDB Operator
runs TiDB, TiKV, and PD as Kubernetes-native resources on the same EKS cluster
this plan provisions. This plan does not implement or test that path; it is
listed here only as a verified starting point for a future plan:

- TiDB Operator getting-started guide for AWS EKS: https://docs.pingcap.com/tidb-in-kubernetes/stable/deploy-on-aws-eks/
- TiDB Operator source and Helm charts: https://github.com/pingcap/tidb-operator

If a future plan builds this out, it should follow the same manifest/runner/trace
contract as this plan and reuse `demos/terraform-eks/infra/terraform/eks.tf`'s
cluster rather than standing up a second EKS cluster.

## 10. Subagent work packets

Format, dispatch prompt and conformance checklist: see `EXECUTION.md`. Packets in this plan run in the order listed; a later packet may edit a file an earlier packet created. Plan 00 must be complete first.

### Packet 10-V1: Verify open facts before building
- Tasks: none (docs only)
- Depends on: 00-P10   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/10-terraform-eks.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm (run each item's confirm step, paste the real output into section 4, set VERIFIED or record the workaround):
  - | Whether a `tidbcloud_dedicated_network_container` must be explicitly declared before the first `tidbcloud_dedicated_private_endpoint_connection` in a project/region, or is silently auto-provisioned | provider docs do not state ordering explicitly | **UNVERIFIED** - confirm by running `terraform ap
  - | Whether the `host` value returned by `tidbcloud_dedicated_private_endpoint_connection` resolves from inside the EKS VPC without `private_dns_enabled = true` on the `aws_vpc_endpoint`, or needs it | not stated in provider docs; AWS's own Interface VPC Endpoint behavior implies `private_dns_enabled`
  - | Whether TLS is enforced identically on the private endpoint path vs the public endpoint path for Dedicated clusters | not stated in provider docs | **UNVERIFIED** - confirm during Task 14 by connecting with `--ssl-mode=REQUIRED` over both paths and checking `SHOW STATUS LIKE 'Ssl_cipher'` returns 
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/10-terraform-eks.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: no packet below depends on an unconfirmed fact without a recorded workaround.

### Packet 10-P1: Scaffold the demo package
- Tasks: 1
- Depends on: 10-V1   Shared runtime: cloud-account
- Files owned: `integrations/demos/terraform-eks/package.json`, `integrations/demos/terraform-eks/tsconfig.json`
- Model: sonnet   Effort: S
- Gate:
  - coordinator reviews the files against Task 1's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 1's steps are all checked off and the gate output matches.

### Packet 10-P2: Manifest schema test, then the manifest
- Tasks: 2
- Depends on: 10-P1   Shared runtime: cloud-account
- Files owned: `integrations/demos/terraform-eks/manifest.json`, `integrations/demos/terraform-eks/test/manifest.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-terraform-eks exec vitest run test/manifest.test.ts` -> all PASS
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 2's steps are all checked off and the gate output matches.

### Packet 10-P3: `terraform-events.ts` - parse machine-readable UI lines (pure logic, TDD)
- Tasks: 3
- Depends on: 10-P2   Shared runtime: none
- Files owned: `integrations/demos/terraform-eks/runner/src/terraform-events.test.ts`, `integrations/demos/terraform-eks/runner/src/terraform-events.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-terraform-eks exec vitest run runner/src/terraform-events.test.ts` -> all PASS
- Done when: Task 3's steps are all checked off and the gate output matches.

### Packet 10-P4: `resource-mapping.ts` - terraform resource address to diagram node (pure logic, TDD)
- Tasks: 4
- Depends on: 10-P3   Shared runtime: none
- Files owned: `integrations/demos/terraform-eks/runner/src/resource-mapping.test.ts`, `integrations/demos/terraform-eks/runner/src/resource-mapping.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-terraform-eks exec vitest run runner/src/resource-mapping.test.ts` -> all PASS
- Done when: Task 4's steps are all checked off and the gate output matches.

### Packet 10-P5: `cost.ts` - estimated hourly cost (pure logic, TDD)
- Tasks: 5
- Depends on: 10-P4   Shared runtime: none
- Files owned: `integrations/demos/terraform-eks/runner/src/cost.test.ts`, `integrations/demos/terraform-eks/runner/src/cost.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-terraform-eks exec vitest run runner/src/cost.test.ts` -> all PASS
- Done when: Task 5's steps are all checked off and the gate output matches.

### Packet 10-P6: Terraform - providers, variables, VPC
- Tasks: 6
- Depends on: 10-P5   Shared runtime: cloud-account
- Files owned: `integrations/demos/terraform-eks/infra/terraform`, `integrations/demos/terraform-eks/infra/terraform/variables.tf`, `integrations/demos/terraform-eks/infra/terraform/versions.tf`, `integrations/demos/terraform-eks/infra/terraform/vpc.tf`
- Model: sonnet   Effort: M
- Gate:
  - coordinator reviews the files against Task 6's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 6's steps are all checked off and the gate output matches.

### Packet 10-P7: Terraform - EKS cluster and managed node group
- Tasks: 7
- Depends on: 10-P6   Shared runtime: none
- Files owned: `integrations/demos/terraform-eks/infra/terraform`, `integrations/demos/terraform-eks/infra/terraform/eks.tf`
- Model: sonnet   Effort: S
- Gate:
  - coordinator reviews the files against Task 7's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
- Done when: Task 7's steps are all checked off and the gate output matches.

### Packet 10-P8: Terraform - TiDB Cloud Dedicated cluster and network container
- Tasks: 8
- Depends on: 10-P7   Shared runtime: none
- Files owned: `integrations/demos/terraform-eks/infra/terraform`, `integrations/demos/terraform-eks/infra/terraform/tidb.tf`
- Model: sonnet   Effort: S
- Gate:
  - coordinator reviews the files against Task 8's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
- Done when: Task 8's steps are all checked off and the gate output matches.

### Packet 10-P9: Terraform - private endpoint variant
- Tasks: 9
- Depends on: 10-P8   Shared runtime: none
- Files owned: `integrations/demos/terraform-eks/infra/terraform`, `integrations/demos/terraform-eks/infra/terraform/private_link.tf`
- Model: sonnet   Effort: S
- Gate:
  - coordinator reviews the files against Task 9's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
- Done when: Task 9's steps are all checked off and the gate output matches.

### Packet 10-P10: Terraform - app deployment on EKS and outputs
- Tasks: 10
- Depends on: 10-P9   Shared runtime: none
- Files owned: `integrations/demos/terraform-eks/infra/terraform`, `integrations/demos/terraform-eks/infra/terraform/k8s.tf`, `integrations/demos/terraform-eks/infra/terraform/outputs.tf`
- Model: sonnet   Effort: M
- Gate:
  - coordinator reviews the files against Task 10's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
- Done when: Task 10's steps are all checked off and the gate output matches.

### Packet 10-P11: The demo app (thin I/O, manual verification)
- Tasks: 11
- Depends on: 10-P10   Shared runtime: none
- Files owned: `integrations/demos/terraform-eks/infra/app`, `integrations/demos/terraform-eks/infra/app/Dockerfile`, `integrations/demos/terraform-eks/infra/app/main.go`
- Model: sonnet   Effort: M
- Gate:
  - coordinator reviews the files against Task 11's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
- Done when: Task 11's steps are all checked off and the gate output matches.

### Packet 10-P12: `terraform-runner.ts` - spawn terraform and stream lines (thin I/O, manual verification)
- Tasks: 12
- Depends on: 10-P11   Shared runtime: none
- Files owned: `integrations/demos/terraform-eks/runner/src/terraform-runner.ts`
- Model: sonnet   Effort: S
- Gate:
  - coordinator reviews the files against Task 12's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
- Done when: Task 12's steps are all checked off and the gate output matches.

### Packet 10-P13: `load-generator.ts` - drive load and sample latency (thin I/O, manual verification)
- Tasks: 13
- Depends on: 10-P12   Shared runtime: none
- Files owned: `integrations/demos/terraform-eks/runner/src/load-generator.ts`, `integrations/demos/terraform-eks/runner/src/terraform-runner.ts`
- Model: sonnet   Effort: S
- Gate:
  - coordinator reviews the files against Task 13's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
- Done when: Task 13's steps are all checked off and the gate output matches.

### Packet 10-P14: `.env.example`
- Tasks: 14
- Depends on: 10-P13   Shared runtime: cloud-account
- Files owned: `integrations/demos/terraform-eks/.env.example`
- Model: sonnet   Effort: S
- Gate:
  - coordinator reviews the files against Task 14's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 14's steps are all checked off and the gate output matches.

### Packet 10-P15: `runner/main.ts` - wire phases, controls, and metrics together
- Tasks: 15
- Depends on: 10-P14   Shared runtime: none
- Files owned: `integrations/demos/terraform-eks/runner/main.ts`
- Model: sonnet   Effort: M
- Gate:
  - coordinator reviews the files against Task 15's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
- Done when: Task 15's steps are all checked off and the gate output matches.

### Packet 10-P16: `README.md`
- Tasks: 16
- Depends on: 10-P15   Shared runtime: cloud-account
- Files owned: `integrations/demos/terraform-eks/README.md`, `integrations/demos/terraform-eks/traces`
- Model: sonnet   Effort: S
- Gate:
  - coordinator reviews the files against Task 16's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 16's steps are all checked off and the gate output matches.

### Packet 10-P17: `TALK-TRACK.md`
- Tasks: 17
- Depends on: 10-P16   Shared runtime: cloud-account
- Files owned: `integrations/demos/terraform-eks/TALK-TRACK.md`
- Model: sonnet   Effort: S
- Gate:
  - coordinator reviews the files against Task 17's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 17's steps are all checked off and the gate output matches.

### Packet 10-P18: Live run - first apply and connectivity confirmation (manual)
- Tasks: 18
- Depends on: 10-P17   Shared runtime: cloud-account
- Files owned: `integrations/demos/terraform-eks/infra/terraform`
- Model: sonnet   Effort: S
- Gate:
  - coordinator reviews the files against Task 18's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 18's steps are all checked off and the gate output matches.

### Packet 10-P19: Live run - load burst and capacity change (manual)
- Tasks: 19
- Depends on: 10-P18   Shared runtime: cloud-account
- Files owned: none (manual or docs step)
- Model: sonnet   Effort: S
- Gate:
  - coordinator reviews the files against Task 19's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 19's steps are all checked off and the gate output matches.

### Packet 10-P20: Record the featured trace, validate, and check-public (manual)
- Tasks: 20
- Depends on: 10-P19   Shared runtime: tidb-playground
- Files owned: none (manual or docs step)
- Model: sonnet   Effort: S
- Gate:
  - coordinator reviews the files against Task 20's text; `pnpm --filter @lab/demo-terraform-eks typecheck` -> exit 0
- Done when: Task 20's steps are all checked off and the gate output matches.

### Packet 10-R: Record and publish the featured trace
- Tasks: section 8
- Depends on: 10-P20   Shared runtime: cloud-account
- Files owned: `integrations/demos/terraform-eks/traces/featured.json`
- Model: coordinator   Effort: M
- Gate:
  - `pnpm lab validate terraform-eks` -> `terraform-eks: manifest ok, featured trace ok (N events)`
  - `pnpm lab check-public` -> `0 findings`
  - teardown commands from section 5 run and confirmed
- Done when: the replay tells the whole story in 3-6 minutes of playback at 1x.
