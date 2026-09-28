# Terraform + EKS + TiDB Cloud

## What this proves

One `terraform apply` creates an AWS VPC, an EKS cluster, a TiDB Cloud Dedicated
cluster (the smallest configuration TiDB Cloud allows: 4 vCPU/16 GiB nodes,
1 TiDB node, 3 TiKV nodes), and an app deployment that connects to it over
PrivateLink. A second `terraform apply` raises the TiDB node count from 1 to 2
in place (no resource replacement) while the app keeps serving traffic,
measured by a load generator's own error count.

## Prerequisites

See Section 5 of `docs/plans/10-terraform-eks.md` for accounts, local tools,
and the cost model. In short: a TiDB Cloud API key pair, an AWS account with
permission to create VPCs/EKS/EC2/VPC endpoints (this demo assumes the
`DBaaS-DevUser-Role` AWS profile in `us-west-2`), Terraform >= 1.9, the AWS
CLI, `kubectl`, Go (to build the demo app image), Node 22, and pnpm.

## Run

1. `cp .env.example .env`. Load credentials at run time rather than editing
   them into `.env`: `set -a; source ~/.config/tidb-lab/secrets.env; set +a`
   and `export AWS_PROFILE=DBaaS-DevUser-Role`.
2. Look up the TiDB Cloud project id (only needed if the account has more
   than one project): `./infra/scripts/lookup-project-id.sh`, then set
   `TIDBCLOUD_PROJECT_ID` in `.env`.
3. Build and push the app image from `infra/app` **for both `linux/amd64`
   and `linux/arm64`** (the EKS node group runs arm64 `t4g.medium`
   instances): `docker buildx build --platform linux/amd64,linux/arm64 -t
   <registry>/<repo>:<tag> --push infra/app`, then set `APP_IMAGE` in `.env`
   to the pushed image reference, pinned by digest.
4. `cd infra/terraform && terraform init`
5. From the `integrations/` workspace root: `pnpm lab run terraform-eks --record`

## Record

`pnpm lab run terraform-eks --record` writes a trace to
`demos/terraform-eks/traces/<timestamp>.json`. See Section 8 of the plan for
exactly what a good recording looks like and how to promote it to
`traces/featured.json`.

## Teardown

From `infra/terraform`: `terraform destroy -auto-approve`, then confirm
nothing is left billing per Section 5 of the plan:

```
terraform show -json | jq '.values.root_module.resources | length'
```

must print `0`. Never leave this stack up overnight.

The app's Kubernetes Service is `ClusterIP`, not `LoadBalancer`, specifically
so `terraform destroy` is never blocked: a `LoadBalancer` Service's ELB and
ENIs are provisioned by the AWS cloud-controller-manager outside of
Terraform's state, and can leave the VPC's subnets and security groups
undeletable (`DependencyViolation`) until someone finds and deletes them by
hand. With `ClusterIP`, every network resource this demo creates - VPC, EKS,
the one PrivateLink VPC endpoint, the TiDB Cloud cluster and its private
endpoint connection - is a Terraform resource, so `terraform destroy` removes
all of it in one pass; the runner reaches the app only via a local `kubectl
port-forward` process (`runner/src/port-forward.ts`), which the runner stops
in the teardown phase and which never touches AWS billing anyway.

## Cost

This demo bills for an EKS control plane, two `t4g.medium` (arm64) EC2 worker
nodes, one PrivateLink Interface VPC endpoint, and TiDB Cloud Dedicated TiDB
(1, scaling to 2) + TiKV (3) nodes at the smallest published spec. It runs
with no NAT gateway (worker nodes sit in public subnets with public IPs
instead; see `infra/terraform/vpc.tf` for the tradeoff). See Section 5 of the
plan for the exact formula and cited current rates, and `.env.example` for
the same rates with sources and check dates. No price is hardcoded in this
demo; every rate comes from the `.env` `PRICE_*` variables and is recomputed
on every metric tick.

## Connectivity modes

`CONNECTION_MODE` in `.env` defaults to `private` (AWS VPC endpoint + TiDB
Cloud private endpoint connection), since connecting privately over
PrivateLink is one of this demo's three acts (provision everything, connect
privately, scale with no downtime). `public_tls` (TLS over the public
endpoint) remains available as a fallback. Section 4 of the plan flags two
details of the private path as unverified until a live run confirms them:
whether the endpoint's DNS name resolves inside the EKS VPC without
`private_dns_enabled = true`, and whether TLS is enforced identically on both
paths.
