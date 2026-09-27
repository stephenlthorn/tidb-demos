# Terraform + EKS + TiDB Cloud

## What this proves

One `terraform apply` creates an AWS VPC, an EKS cluster, a TiDB Cloud Dedicated
cluster, and an app deployment that connects them. A second `terraform apply`
changes TiDB's TiKV node count in place (no resource replacement) while the app
keeps serving traffic, measured by a load generator's own error count.

## Prerequisites

See Section 5 of `docs/plans/10-terraform-eks.md` for accounts, local tools,
and the cost model. In short: a TiDB Cloud API key pair, an AWS account with
permission to create VPCs/EKS/EC2/VPC endpoints, Terraform >= 1.9, the AWS CLI,
`kubectl`, Go (to build the demo app image), Node 22, and pnpm.

## Run

1. `cp .env.example .env` and fill in every value, especially the `PRICE_*`
   variables (see the vendor pricing pages linked below; never commit real
   prices into this file's defaults).
2. Build and push the app image from `infra/app`, then set `APP_IMAGE` in
   `.env` to the pushed image reference, pinned by digest.
3. `cd infra/terraform && terraform init`
4. From the `integrations/` workspace root: `pnpm lab run terraform-eks --record`

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

## Cost

This demo bills for an EKS control plane, EC2 worker nodes, one NAT gateway,
and TiDB Cloud Dedicated TiDB + TiKV nodes. See Section 5 of the plan for the
exact formula, and current rates at
[AWS EKS pricing](https://aws.amazon.com/eks/pricing/) and
[TiDB Cloud pricing](https://www.pingcap.com/pricing/). No price is hardcoded
in this demo; every rate comes from the `.env` `PRICE_*` variables and is
recomputed on every metric tick.

## Connectivity modes

`CONNECTION_MODE` in `.env` is either `public_tls` (default, TLS over the
public endpoint) or `private` (AWS VPC endpoint + TiDB Cloud private
endpoint connection). Section 4 of the plan flags two details of the private
path as unverified until a live run confirms them: whether the endpoint's DNS
name resolves inside the EKS VPC without `private_dns_enabled = true`, and
whether TLS is enforced identically on both paths.
