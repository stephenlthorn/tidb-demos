# Okta identity lifecycle to TiDB database access

## What it proves

- Okta group membership drives real TiDB `GRANT`/`REVOKE` statements, timed, not asserted (`provision-latency-ms`, `revoke-latency-ms`).
- A revoked or deactivated Okta user is provably locked out of the database, shown by a real failed connection attempt (`revoked-user-rejected`).
- Grant drift between Okta's desired state and TiDB's actual `SHOW GRANTS` is measured on a reconciliation loop (`grant-drift-count`, `no-orphan-users`).
- A companion guide (`GUIDE-ORG-SSO.md`) covers TiDB Cloud's own Organization SSO with Okta, which is a separate, console-only identity plane from the database users this runner manages.

## Prerequisites

- An Okta Integrator Free Plan org (https://developer.okta.com/signup/) with two groups (`lab_analysts`, `lab_engineers`), one demo user, and an API token scoped to `okta.users.read`, `okta.users.manage`, `okta.groups.read`, `okta.groups.manage`, `okta.logs.read`.
- Local TiDB via `../../infra/tidb/playground.sh`, or a TiDB Cloud instance (see pricing at https://www.pingcap.com/tidb-cloud-pricing/).
- Node 22, pnpm.

## Run

```bash
cp .env.example .env
# fill in OKTA_ORG_URL, OKTA_API_TOKEN, OKTA_ANALYSTS_GROUP_ID, OKTA_ENGINEERS_GROUP_ID, OKTA_DEMO_USER_ID
pnpm lab run okta
```

Open the UI at `http://localhost:5173` and select this demo to watch the flow diagram and metrics live, or press the control buttons directly with `curl -X POST http://localhost:7070/control/<id>` using one of `add-to-analysts`, `move-to-engineers`, `remove-from-groups`, `deactivate-user`.

## Record

```bash
pnpm lab run okta --record
```

Run through all five phases (`baseline`, `provision`, `rescope`, `revoke`, `reconcile`; see `TALK-TRACK.md`), then stop the runner. Promote the newest file in `traces/` to `traces/featured.json` once it looks clean.

## Teardown

```bash
tiup clean lab
```

In TiDB:

```sql
DROP USER IF EXISTS 'demo_okta_user'@'%';
DROP ROLE IF EXISTS 'analyst', 'engineer';
```

In Okta: delete the demo user, delete `lab_analysts` and `lab_engineers`, revoke the API token, and if `GUIDE-ORG-SSO.md` was walked through against a real org, delete that OIDC or SAML app integration too.

## Cost notes

The Okta org is free under the Integrator Free Plan's published limits (see https://developer.okta.com/docs/reference/org-defaults/ for current limits; do not hardcode the numeric limits elsewhere). TiDB cost follows the local playground (free) or the TiDB Cloud pricing page (https://www.pingcap.com/tidb-cloud-pricing/) for a Cloud instance. The demo issues no bulk data load and uses trivial row counts.

## Live proof: the real Okta console

Recorded 2026-09-29 during a live run against an Okta Integrator org and the local TiDB playground. The lab dashboard (left) and the real Okta admin console (right) are captured side by side; account details are blurred.

- Video (4x speed): [media/okta-live-side-by-side.mp4](media/okta-live-side-by-side.mp4)
- Screenshots at each phase and check verdict: [media/screenshots/](media/screenshots/)
  - Provision: the demo user added to `lab-analysts` in Okta, and the TiDB grant that follows: [06-phase-provision.jpg](media/screenshots/06-phase-provision.jpg)
  - Re-scope: moved to `lab-engineers`: [09-phase-rescope.jpg](media/screenshots/09-phase-rescope.jpg)
  - Revoke: the deactivated user, and the rejected TiDB login: [11-check-revoked-user-rejected-pass.jpg](media/screenshots/11-check-revoked-user-rejected-pass.jpg)
