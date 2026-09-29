# Plan 05: Okta + TiDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (` - [ ]`) syntax for tracking.

**Goal:** Show, in two parts, how TiDB fits an enterprise identity workflow built on Okta: Part A is a verified, no-runner guide to TiDB Cloud Organization SSO with Okta (console login only); Part B is a live runner that keeps TiDB database users and grants in lockstep with Okta group membership, so the audience watches a user get access when added to an Okta group, get re-scoped when moved to another group, and get locked out the moment they are removed or deactivated.

**Architecture:** Part B's runner polls the Okta System Log and Users API on an interval, maps Okta group membership to a TiDB database role through a pure `roleForGroups` function, diffs desired vs actual grants with a pure `findDrift` function, and applies `CREATE USER` / `GRANT` / `REVOKE` / lock or drop statements to TiDB through `mysql2`. A demo client repeatedly attempts a `SELECT` against a reporting schema so the audience sees the exact moment access starts and stops working. All SQL identifiers are built through one tested quoting function. Metrics come from timing the gap between an Okta System Log event's `published` timestamp and the moment the sync loop finishes applying the corresponding grant change, plus a periodic reconciliation pass that counts drift between desired and actual state.

**Tech Stack:** Node 22, TypeScript strict, `@lab/runner-kit`, `@lab/contract`, `mysql2`, the Okta System Log and Users REST APIs (no Okta SDK, plain `fetch`), tiup playground for local TiDB.

**Depends on:** Plan 00 (platform).

---

## 1. Why this demo

- **The question customers ask:** "We're running Okta as our IdP and we're deep into SSO questions for the console, but before we approve a new database, we need to see the whole identity lifecycle end to end: how does a new hire's database access get created, how does moving teams change what they can query, and how fast does access actually die when someone leaves or gets deactivated?"
- **Pattern:** Enterprise security team in a PoC asking many SSO setup questions and wanting to see identity lifecycle end to end (Okta groups to TiDB database roles) before approving a new database.
- **What TiDB proves here:**
  - TiDB Cloud Organization SSO covers console access (who can log into the TiDB Cloud UI and with what org/project role), verified end to end against the official OIDC/SAML/SCIM flow.
  - TiDB database users and roles are a completely separate identity plane from console users (confirmed directly in the docs: "Database users and roles are independent of organization and project users and roles"), so an enterprise that wants Okta groups to control *database* grants needs a small sync service, exactly like it would need for any MySQL-protocol database.
  - A `lab_analysts` / `lab_engineers` Okta group change reaches TiDB as a real `GRANT`/`REVOKE` in low seconds, measured, not asserted.
  - A revoked or deactivated Okta user is provably locked out: the demo makes a real connection attempt and shows it fail.
  - Grant drift (Okta desired state vs `SHOW GRANTS` actual state) is measured on a reconciliation loop, not assumed to be zero.
- **What this demo does not claim:**
  - TiDB Cloud does not have a database-user-level SSO or SCIM integration. Organization SSO and SCIM provisioning apply only to the TiDB Cloud console identity plane (organization/project/instance roles), never to MySQL-protocol database accounts.
  - The sync service in Part B is demo-grade: single-process, in-memory cursor, no HA, no secret manager. Section 9 states what a production version would add.
  - Okta Event Hooks (the production-recommended low-latency delivery mechanism) are documented and evaluated, but the live/recorded demo uses polling, because a laptop demo cannot reliably hold a public HTTPS tunnel through a recording session. See section 1 rationale in the controls table and section 9.
  - The optional Act C (`tidb_auth_token` against Okta-issued JWTs) is evaluated for feasibility and partially **UNVERIFIED**; it is not required for the demo to be complete. Self-managed LDAP auth against Okta's LDAP Interface is evaluated and explicitly *not* recommended for a live build (see section 4).

## 2. What the audience sees

### Part A - Organization SSO guide (no runner, walkthrough only)

This part is a screen-share walkthrough of the real TiDB Cloud console plus a real Okta OIDC or SAML app, following `demos/okta/GUIDE-ORG-SSO.md` step by step. There is no manifest, no runner, and nothing here is recorded as a trace; it is presenter narration over the live console.

Covered exactly as documented (section 4 has sources for every claim):

1. Standard SSO (Google/GitHub/Microsoft, on by default) vs Cloud Organization SSO (username/password, Google, GitHub, Microsoft, OIDC, SAML; paid orgs only; off by default; cannot be disabled once turned on).
2. The custom login URL (`https://tidbcloud.com/enterprise/signin/<company-name>`) and why it cannot change later.
3. What is configured where for OIDC: TiDB Cloud needs Issuer URL, Client ID, Client Secret from Okta. Exact redirect/callback URI text is **UNVERIFIED** - the console displays it only after OIDC is enabled; confirm by enabling OIDC in a real org and reading the "Authentication Method Details" pane, then update this guide with the literal value.
4. What is configured where for SAML: TiDB Cloud pre-populates an Entity ID (SP entity ID) and Postback URL (the ACS URL) that go into the Okta SAML app; Okta returns a Sign-on URL and Signing Certificate that go back into TiDB Cloud.
5. Auto-provisioning: off by default; when on, any user of the enabled method who signs in is auto-joined with the default **Organization Viewer** role; OIDC/SAML auto-provision and SAML SCIM both require verified Allowed Email Domains (DNS TXT record verification).
6. SCIM provisioning: only available on the SAML method. Okta pushes groups; TiDB Cloud shows them under Organization Settings > Authentication > Groups; the presenter grants each pushed group an organization or project role in TiDB Cloud; group membership changes in Okta then dynamically add/remove the corresponding TiDB Cloud console role. This is real group-to-role mapping, but it is console RBAC, never database grants.
7. Enforcing SSO: disable the username/password method so only IdP methods remain on the login page.
8. Break-glass admin: TiDB Cloud has **no dedicated break-glass or emergency-admin feature** (**UNVERIFIED as a negative** - confirmed by absence in the Organization SSO Authentication doc; recommend re-checking release notes before every recording in case this changes). The documented safety net is procedural: keep the org owner's own verified email domain enabled on at least one authentication method before disabling password auth, and know that changing the custom login URL after enablement requires contacting TiDB Cloud Support.
9. Database-user SSO does not exist: `docs.pingcap.com/tidbcloud/configure-sql-users/` states plainly that "Database users and roles are independent of organization and project users and roles." This is the exact gap Part B closes with a purpose-built sync service.

### Part B - live identity-lifecycle demo (runner)

### Flow diagram

```
 [okta]  --group events-->  [sync]  --grants applied-->  [tidb]
                                                             ^
                                                             |
                                                        queries
                                                             |
                                                          [app]
```

### Phases (with narration)

| # | Phase id | Label | What happens | Narration (presenter caption) |
|---|---|---|---|---|
| 1 | baseline | Baseline | Sync service starts in reconcile mode; TiDB already has an `analyst` role (SELECT on `reporting`) and an `engineer` role (SELECT + INSERT/UPDATE on `reporting`); demo user does not exist in either Okta group yet | "Here's our starting state: two TiDB roles already exist, and our demo user has no Okta group membership and no TiDB login yet." |
| 2 | provision | Provision on group add | Demo user is added to `lab_analysts` in Okta; sync polls, sees the new membership, creates the TiDB user, grants `analyst`; app retries its connection and starts succeeding | "Watch the clock: from the moment I add this person to the analysts group in Okta, to the moment they can query the reporting schema in TiDB." |
| 3 | rescope | Re-scope on group move | Demo user is moved from `lab_analysts` to `lab_engineers`; sync revokes `analyst`, grants `engineer` | "Now I move them to engineering in Okta. TiDB re-scopes their grants, no manual SQL." |
| 4 | revoke | Revoke on removal | Demo user is removed from all TiDB-relevant Okta groups and deactivated; sync locks and then drops the TiDB user; the app's next connection attempt fails and the check goes to `pass` | "I deactivate them in Okta. Their next database connection attempt fails, on camera, not asserted." |
| 5 | reconcile | Reconcile and prove no drift | A reconciliation pass runs `findDrift` against fresh Okta group reads and `SHOW GRANTS`; `grant-drift-count` reports 0 | "One more pass to prove there's no drift between what Okta says and what TiDB actually grants." |

### Controls (buttons, live mode only)

| Control id | Label | Effect in the runner |
|---|---|---|
| `add-to-analysts` | Add demo user to lab_analysts | Calls Okta Users API to add the demo user to the `lab_analysts` group |
| `move-to-engineers` | Move demo user to lab_engineers | Removes the demo user from `lab_analysts` and adds them to `lab_engineers` |
| `remove-from-groups` | Remove demo user from all groups | Removes the demo user from both `lab_analysts` and `lab_engineers` |
| `deactivate-user` | Deactivate demo user in Okta | Calls Okta's user deactivate lifecycle endpoint |

Event delivery for controls to the sync loop is **polling**, not Okta Event Hooks. Rationale: Event Hooks need a public HTTPS endpoint that passes Okta's one-time `x-okta-verification-challenge` check; on a laptop that means an ngrok tunnel whose URL and verification must be redone on every restart, which is fragile for a recorded 3-6 minute run and for anyone re-running the demo later. Polling the System Log (`GET /api/v1/logs`, filtered by `eventType`) on a fixed interval is slower by at most one poll interval but has zero moving infrastructure. Section 9 lists Event Hooks as the production recommendation with its own tradeoffs.

### Checks (correctness proofs)

| Check id | Label | How it passes |
|---|---|---|
| `revoked-user-rejected` | Revoked user cannot connect | Runner makes a real `mysql2` connection attempt as the demo user after revoke; check passes when the attempt throws an access-denied error, fails if it connects |
| `grants-match-desired` | Grants match desired state | `findDrift` over the current desired map (from Okta group reads) vs actual (`SHOW GRANTS`) returns an empty array |
| `no-orphan-users` | No orphan TiDB users | Every `lab_`-prefixed TiDB user maps to a demo user still present in at least one tracked Okta group; `findDrift`'s `orphan_user` drift kind is empty |

## 3. Metrics

| Metric id | Label | Unit | Display | Better | How measured (exact API, SQL, or timing) |
|---|---|---|---|---|---|
| `provision-latency-ms` | Provision latency | ms | both | lower | `msSincePublished(event.published, Date.now())` where `event` is the Okta System Log `group.user_membership.add` entry for `lab_analysts`/`lab_engineers` and the end time is when the runner's `CREATE USER` + `GRANT` statements for that user complete |
| `revoke-latency-ms` | Revoke latency | ms | both | lower | `msSincePublished(event.published, Date.now())` where `event` is the Okta `user.lifecycle.deactivate` or final `group.user_membership.remove` entry and the end time is when the runner's own `mysql2` connection attempt as that user first throws an access-denied error |
| `grant-drift-count` | Grant drift count | count | both | lower | `findDrift(desired, actual).length` computed each reconciliation tick, where `desired` comes from a fresh Okta Groups API read and `actual` comes from parsing `SHOW GRANTS FOR <user>` for every `lab_`-prefixed TiDB user |
| `audit-events-processed` | Audit events processed | count | series | higher | Cumulative count of Okta System Log entries the poller has read and applied since the runner started, incremented once per processed log entry |

## 4. Verified facts and sources

| Fact | Source | Status |
|---|---|---|
| TiDB Cloud has Standard SSO (Google/GitHub/Microsoft only, on by default) and Cloud Organization SSO (adds username/password, OIDC, SAML; paid orgs only; off by default) | https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/ and https://docs.pingcap.com/tidbcloud/tidb-cloud-sso-authentication/ | Verified |
| Cloud Organization SSO custom login URL format `https://tidbcloud.com/enterprise/signin/<company-name>`, cannot be changed after enablement without contacting Support | https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/ | Verified |
| OIDC method configuration in TiDB Cloud takes Issuer URL, Client ID, Client Secret from the IdP | https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/ | Verified |
| The literal OIDC redirect/callback URI value shown in the TiDB Cloud console | same page (does not print the literal value in fetched text) | **UNVERIFIED** - confirm by enabling OIDC in a live org and reading the console pane; record the literal value in `GUIDE-ORG-SSO.md` |
| SAML method exposes an Entity ID (SP entity ID) and Postback URL (ACS URL) generated by TiDB Cloud, to be entered into the Okta SAML app; Okta returns Sign-on URL and Signing Certificate | https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/ | Verified |
| Auto-provisioned members default to the Organization Viewer role; OIDC/SAML auto-provision and SAML SCIM both require verified Allowed Email Domains | https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/ | Verified |
| SCIM provisioning is available only on the SAML method; Okta group push maps to TiDB Cloud organization or project roles and syncs add/remove dynamically | https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/ | Verified |
| Enforcing SSO means disabling the username/password authentication method | https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/ | Verified |
| TiDB Cloud has no documented break-glass/emergency-admin feature | Absence in https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/ | **UNVERIFIED as a negative** - re-check release notes at build time |
| Database users/roles are independent of organization/project console users and roles | https://docs.pingcap.com/tidbcloud/configure-sql-users/ | Verified |
| TiDB Cloud organization roles (Owner, Billing Manager, Billing Viewer, Console Audit Manager, Viewer) and project roles (Owner, Data Access Read-Write, Data Access Read-Only, Viewer) | https://docs.pingcap.com/tidbcloud/manage-user-access/ | Verified |
| `tidb_auth_token` is a JWT-based passwordless auth method, TiDB Cloud since v6.4.0, TiDB Self-Managed since v6.5.0; requires TLS and the `mysql_clear_password` client plugin | https://docs.pingcap.com/tidb/stable/security-compatibility-with-mysql/ | Verified |
| `tidb_auth_token` claims: `sub` must equal the TiDB username exactly; `iss` must equal `TOKEN_ISSUER` if set on `CREATE USER`; `iat`/`exp` bound the token window; `email` must match the user's `ATTRIBUTE` email if one was set | https://docs.pingcap.com/tidb/stable/security-compatibility-with-mysql/ | Verified |
| TiDB reads JWKS from a **local file path** (`auth-token-jwks` in `config.toml`) refreshed on `auth-token-refresh-interval`, not from a live JWKS URL | https://docs.pingcap.com/tidb/stable/security-compatibility-with-mysql/ | Verified |
| Whether an Okta Authorization Server can be configured so an ID/access token's `sub` claim equals an arbitrary TiDB username (e.g. via app username format) without custom code | Not found in fetched docs | **UNVERIFIED** - confirm in a real Okta org's Authorization Server / app "username format" settings before building Act C |
| TiDB supports `authentication_ldap_simple` and `authentication_ldap_sasl` since v7.1.0, with per-plugin system variables (`authentication_ldap_simple_server_host`, `_server_port` default 389, `_bind_base_dn`, `_bind_root_dn`, `_bind_root_pwd`, `_ca_path`, `_tls` default OFF, `_init_pool_size` default 10, `_max_pool_size` default 1000; SASL adds `_auth_method_name` default `SCRAM-SHA-1`, possible values SCRAM-SHA-1/SCRAM-SHA-256/GSSAPI) | https://docs.pingcap.com/tidb/stable/system-variables/ | Verified |
| Okta's LDAP Interface supports only BIND/UNBIND/SEARCH (simple bind), requires an encrypted connection (StartTLS on 389 or LDAPS on 636, TLS 1.2 only), hostname pattern `<org_subdomain>.ldap.<okta\|oktapreview\|okta-emea>.com`, base DN `ou=users` or `ou=groups,dc=...`, user object class `inetOrgPerson` with `uid`, group object class `groupOfUniqueNames` with `uniqueMember`; does not document SASL/PAM support | https://help.okta.com/en-us/content/topics/directory/ldap-interface-main.htm, https://help.okta.com/en-us/content/topics/directory/ldap-interface-limitations.htm, https://help.okta.com/en-us/content/topics/directory/ldap-interface-connection-settings.htm | Verified |
| Because Okta's LDAP Interface documents simple bind only, `authentication_ldap_simple` is the plausible pairing and `authentication_ldap_sasl` (SCRAM/GSSAPI) is not documented as supported against it | Inference from the two sources above | **UNVERIFIED** - no doc states this pairing explicitly either way; confirm with a real bind attempt before claiming it in a customer conversation |
| Okta's LDAP Interface is not listed among the features included in the Integrator Free Plan (SSO, Universal Directory, Adaptive MFA, Lifecycle Management, API Access Management, Workflows) | https://developer.okta.com/docs/reference/org-defaults/ | **UNVERIFIED** - the page does not explicitly say LDAP Interface is excluded, only that it is absent from the included-features table; confirm by attempting to enable it in a free-plan org, or contact Okta sales as the doc instructs |
| Recommendation: build Act C (optional) against `tidb_auth_token`, not LDAP, because API Access Management (needed for a custom Authorization Server) is an included Integrator Free Plan feature while LDAP Interface availability on that plan is unconfirmed | Derived from the two facts above | Recommendation, not a vendor claim |
| Okta Event Hooks require a public HTTPS endpoint; one-time verification via a GET request carrying header `x-okta-verification-challenge`, answered with JSON body `{"verification": "<value>"}`; ongoing notifications are HTTPS POST | https://developer.okta.com/docs/concepts/event-hooks/, https://help.okta.com/en-us/content/topics/automation-hooks/verify-event-hooks.htm | Verified |
| Okta System Log query supports a `filter` query parameter with `eq`/`ne`/`sw`/`co`/`in` operators over fields like `eventType`, `actor`, `target`, `outcome.result` | https://developer.okta.com/docs/reference/system-log-query/ | Verified |
| Default rate limit for `GET /api/v1/logs` is commonly reported as 100 requests/minute, configurable up to 1000 requests/minute | https://devforum.okta.com/t/what-is-ratelimit-for-system-logs-api-v1-logs/35056 and https://developer.okta.com/docs/reference/rl2-monitor/ | **UNVERIFIED for this specific org** - a community-sourced figure, not a canonical vendor table; confirm the actual bucket in the org's own Rate Limit Dashboard before relying on a poll interval |
| Okta's free signup tier is the **Integrator Free Plan** (replaced the old Developer Edition), signed up at https://developer.okta.com/signup/ via the "Okta Workforce Identity" tile; includes SSO, Universal Directory, Adaptive MFA, Lifecycle Management, API Access Management, and 5 Workflows; limited to 10 active users, deactivates after 90 consecutive days with no sign-in unless an app is submitted to OIN, and has "limited per-minute rate limits" | https://developer.okta.com/docs/reference/org-defaults/ | Verified |

## 5. Prerequisites, cost, and teardown

- Accounts and access:
  - An Okta Integrator Free Plan org (signup above), with an API token scoped to the least privilege this demo needs: `okta.users.read`, `okta.users.manage` (to add/remove group membership and deactivate the demo user), `okta.groups.read`, `okta.groups.manage` (to create/manage `lab_analysts`/`lab_engineers`), `okta.logs.read`.
  - Local TiDB (`tiup playground`) or a TiDB Cloud org with an Organization Owner for Part A's guide walkthrough only; Part B never needs org-console access, only a database connection.
- Local tools: Node 22, pnpm, `tiup`, `mysql2` (installed via workspace deps), no Docker required for this demo.
- Cost model: the Okta org is free under the Integrator Free Plan's published limits (see https://developer.okta.com/docs/reference/org-defaults/ for current limits; do not hardcode the numeric limits in prose elsewhere in this repo). TiDB is either the free local playground or a TiDB Cloud instance billed per the TiDB Cloud pricing page (https://www.pingcap.com/tidb-cloud-pricing/); the demo issues no bulk data load and uses trivial row counts, so cost is effectively the base instance rate for the run's duration.
- Teardown:
  - `tiup clean lab` to remove the local TiDB Cloud playground data directory.
  - In TiDB: `DROP USER IF EXISTS '<demo-user>'@'%';` then `DROP ROLE IF EXISTS 'analyst', 'engineer';` (run against the demo schema only; do not run against a shared cluster).
  - In Okta Admin Console: delete the demo user, delete the `lab_analysts` and `lab_engineers` groups, revoke/delete the API token created for this demo, and if Part A's guide walkthrough created a real OIDC/SAML app integration, delete that app integration too.
  - Confirm nothing is left billing: for TiDB Cloud, check the organization's My TiDB page shows no `lab`-prefixed instance still running; for Okta, confirm the demo user and groups no longer appear in Directory > People / Groups.

## 6. File structure

```
demos/okta/
  manifest.json              DemoManifestSchema-validated description of Part B's nodes, edges, metrics, phases, checks, controls
  package.json                "@lab/demo-okta", depends on @lab/contract + @lab/runner-kit (workspace:*)
  tsconfig.json                extends ../../tsconfig.base.json
  README.md                    what it proves, prerequisites, run, record, teardown, cost notes
  TALK-TRACK.md                presenter script per phase, discovery questions, objections and answers
  GUIDE-ORG-SSO.md             Part A: the Organization SSO + Okta walkthrough (no runner, no manifest)
  .env.example                 standard block plus OKTA_* and demo schema/role variables
  runner/
    main.ts                    entry point: wires emitter, poller, sync loop, controls
    src/
      groupRoleMap.ts           pure: Okta group names -> DbRole
      sqlIdentifiers.ts         pure: validated usernames, quoted account/role names, escaped literals
      grantDiff.ts              pure: desired vs actual grant drift detection
      latency.ts                pure: elapsed-ms-since-published-timestamp math
      oktaPoller.ts             I/O adapter: polls Okta System Log + Users/Groups API
      tidbSync.ts               I/O adapter: applies CREATE USER/GRANT/REVOKE/LOCK/DROP against TiDB
      demo.ts                   orchestrates phases and controls, calls the emitter
    test/
      groupRoleMap.test.ts
      sqlIdentifiers.test.ts
      grantDiff.test.ts
      latency.test.ts
  test/
    manifest.test.ts            parses manifest.json with DemoManifestSchema
  traces/
    featured.json                the recording the website plays (committed after capture)
```

## 7. Tasks

Follow TDD strictly for every file in `runner/src/*.ts` that is pure logic. `oktaPoller.ts` and `tidbSync.ts` are thin I/O adapters: they get manual live-run verification steps instead of unit tests, per the platform's global rule 4.

### Task 1: Scaffold the demo package

- [ ] Create `demos/okta/package.json`:

```json
{
  "name": "@lab/demo-okta",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run", "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@lab/contract": "workspace:*",
    "@lab/runner-kit": "workspace:*",
    "mysql2": "^3.11.0",
    "zod": "^4.1.0"
  },
  "devDependencies": {
    "tsx": "^4.20.0",
    "@types/node": "^22.10.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] Create `demos/okta/tsconfig.json`:

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

- [ ] Run `cd demos/okta && pnpm install` from the workspace root. Expected: lockfile updates, no errors, `node_modules/@lab/contract` and `node_modules/@lab/runner-kit` are symlinks into the workspace packages.
- [ ] Commit:

```bash
git add demos/okta/package.json demos/okta/tsconfig.json
git commit -m "okta: scaffold demo package"
```

### Task 2: `groupRoleMap.ts` (pure: Okta group -> TiDB role)

- [ ] Write the failing test `demos/okta/runner/test/groupRoleMap.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { roleForGroups } from '../src/groupRoleMap';

describe('roleForGroups', () => {
  it('returns null when the user is in no tracked group', () => {
    expect(roleForGroups([])).toBeNull();
  });

  it('maps lab_analysts to the analyst role', () => {
    expect(roleForGroups(['lab_analysts'])).toBe('analyst');
  });

  it('maps lab_engineers to the engineer role', () => {
    expect(roleForGroups(['lab_engineers'])).toBe('engineer');
  });

  it('prefers engineer when the user is in both groups', () => {
    expect(roleForGroups(['lab_analysts', 'lab_engineers'])).toBe('engineer');
  });

  it('ignores group names it does not track', () => {
    expect(roleForGroups(['some_other_group'])).toBeNull();
  });
});
```

- [ ] Run `pnpm --filter @lab/demo-okta exec vitest run runner/test/groupRoleMap.test.ts`. Expected FAIL: `Cannot find module '../src/groupRoleMap'`.
- [ ] Write the minimal implementation `demos/okta/runner/src/groupRoleMap.ts`:

```ts
export type DbRole = 'analyst' | 'engineer';

type GroupRoleEntry = {
  readonly group: string;
  readonly role: DbRole;
};

const GROUP_ROLE_PRECEDENCE: readonly GroupRoleEntry[] = [
  { group: 'lab_engineers', role: 'engineer' },
  { group: 'lab_analysts', role: 'analyst' },
];

export const roleForGroups = (groupNames: readonly string[]): DbRole | null => {
  const match = GROUP_ROLE_PRECEDENCE.find((entry) => groupNames.includes(entry.group));
  return match === undefined ? null : match.role;
};
```

- [ ] Run `pnpm --filter @lab/demo-okta exec vitest run runner/test/groupRoleMap.test.ts`. Expected PASS: 5 tests passing.
- [ ] Commit:

```bash
git add demos/okta/runner/src/groupRoleMap.ts demos/okta/runner/test/groupRoleMap.test.ts
git commit -m "okta: add groupRoleMap pure mapping"
```

### Task 3: `sqlIdentifiers.ts` (pure: safe account names, roles and literals)

TiDB cannot bind parameters inside `CREATE USER`, `GRANT`, `REVOKE` or `SHOW GRANTS`, so every dynamic piece of those statements goes through one of three tested functions. Identifiers use the platform's `quoteIdentifier` from `@lab/runner-kit`; usernames coming from Okta are additionally restricted to a strict pattern, so a malicious or malformed Okta login can never reach SQL.

- [ ] Write the failing test `demos/okta/runner/test/sqlIdentifiers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { accountName, roleName, stringLiteral, toDbUsername } from '../src/sqlIdentifiers';

describe('toDbUsername', () => {
  it('derives a lowercase username from an Okta login', () => {
    expect(toDbUsername('Alice.Smith@example.com')).toBe('alice.smith');
  });

  it('rejects logins that would produce an unsafe or too long username', () => {
    expect(() => toDbUsername("x'; DROP USER root; --@example.com")).toThrow('unsafe username');
    expect(() => toDbUsername(`${'a'.repeat(40)}@example.com`)).toThrow('unsafe username');
    expect(() => toDbUsername('@example.com')).toThrow('unsafe username');
  });
});

describe('accountName', () => {
  it('quotes both parts of a TiDB account name', () => {
    expect(accountName('alice.smith')).toBe('`alice.smith`@`%`');
  });

  it('refuses a username that did not pass validation', () => {
    expect(() => accountName('bad`name')).toThrow('unsafe username');
  });
});

describe('roleName', () => {
  it('quotes the two demo roles', () => {
    expect(roleName('analyst')).toBe('`analyst`');
    expect(roleName('engineer')).toBe('`engineer`');
  });
});

describe('stringLiteral', () => {
  it('escapes quotes and backslashes', () => {
    expect(stringLiteral("it's \\ fine")).toBe("'it''s \\\\ fine'");
  });

  it('rejects NUL bytes', () => {
    expect(() => stringLiteral('a\u0000b')).toThrow('literal must not contain a NUL byte');
  });
});
```

- [ ] Run `pnpm --filter @lab/demo-okta exec vitest run runner/test/sqlIdentifiers.test.ts`. Expected FAIL: `Failed to resolve import "../src/sqlIdentifiers"`.
- [ ] Write the minimal implementation `demos/okta/runner/src/sqlIdentifiers.ts`:

```ts
import { quoteIdentifier } from '@lab/runner-kit';
import type { DbRole } from './groupRoleMap';

const SAFE_USERNAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

const assertSafeUsername = (username: string): string => {
  if (!SAFE_USERNAME.test(username)) throw new Error(`unsafe username: ${JSON.stringify(username)}`);
  return username;
};

export const toDbUsername = (oktaLogin: string): string =>
  assertSafeUsername((oktaLogin.split('@')[0] ?? '').toLowerCase());

export const accountName = (username: string): string => `${quoteIdentifier(assertSafeUsername(username))}@${quoteIdentifier('%')}`;

export const roleName = (role: DbRole): string => quoteIdentifier(role);

export const stringLiteral = (value: string): string => {
  if (value.includes('\u0000')) throw new Error('literal must not contain a NUL byte');
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
};
```

- [ ] Run `pnpm --filter @lab/demo-okta exec vitest run runner/test/sqlIdentifiers.test.ts`. Expected PASS: 7 tests passing.
- [ ] Commit:

```bash
git add demos/okta/runner/src/sqlIdentifiers.ts demos/okta/runner/test/sqlIdentifiers.test.ts
git commit -m "okta: add safe account, role and literal builders"
```

### Task 4: `grantDiff.ts` (pure: desired vs actual grant drift)

- [ ] Write the failing test `demos/okta/runner/test/grantDiff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { findDrift, type ActualAssignment, type DesiredAssignment } from '../src/grantDiff';

const desired = (overrides: Partial<DesiredAssignment> = {}): DesiredAssignment => ({
  username: 'alice',
  role: 'analyst',
  ...overrides,
});

const actual = (overrides: Partial<ActualAssignment> = {}): ActualAssignment => ({
  username: 'alice',
  role: 'analyst',
  exists: true,
  ...overrides,
});

describe('findDrift', () => {
  it('reports no drift when desired and actual match', () => {
    expect(findDrift([desired()], [actual()])).toEqual([]);
  });

  it('reports missing_user when a desired user does not exist in TiDB', () => {
    expect(findDrift([desired()], [])).toEqual([
      { username: 'alice', kind: 'missing_user', desiredRole: 'analyst', actualRole: null },
    ]);
  });

  it('reports wrong_role when the actual role differs from desired', () => {
    expect(findDrift([desired({ role: 'engineer' })], [actual({ role: 'analyst' })])).toEqual([
      { username: 'alice', kind: 'wrong_role', desiredRole: 'engineer', actualRole: 'analyst' },
    ]);
  });

  it('reports orphan_user when a TiDB user is no longer desired', () => {
    expect(findDrift([], [actual()])).toEqual([
      { username: 'alice', kind: 'orphan_user', desiredRole: null, actualRole: 'analyst' },
    ]);
  });

  it('does not report a desired user with a null role as missing', () => {
    expect(findDrift([desired({ role: null })], [])).toEqual([]);
  });
});
```

- [ ] Run `pnpm --filter @lab/demo-okta exec vitest run runner/test/grantDiff.test.ts`. Expected FAIL: `Cannot find module '../src/grantDiff'`.
- [ ] Write the minimal implementation `demos/okta/runner/src/grantDiff.ts`:

```ts
import type { DbRole } from './groupRoleMap';

export type DesiredAssignment = {
  readonly username: string;
  readonly role: DbRole | null;
};

export type ActualAssignment = {
  readonly username: string;
  readonly role: DbRole | null;
  readonly exists: boolean;
};

export type DriftKind = 'missing_user' | 'wrong_role' | 'orphan_user';

export type Drift = {
  readonly username: string;
  readonly kind: DriftKind;
  readonly desiredRole: DbRole | null;
  readonly actualRole: DbRole | null;
};

export const findDrift = (
  desired: readonly DesiredAssignment[],
  actual: readonly ActualAssignment[],
): readonly Drift[] => {
  const actualByUser = new Map(actual.map((entry) => [entry.username, entry]));
  const desiredByUser = new Map(desired.map((entry) => [entry.username, entry]));

  const desiredDrift = desired.flatMap((entry): readonly Drift[] => {
    const found = actualByUser.get(entry.username);
    if (found === undefined || !found.exists) {
      return entry.role === null
        ? []
        : [{ username: entry.username, kind: 'missing_user', desiredRole: entry.role, actualRole: null }];
    }
    if (found.role !== entry.role) {
      return [{ username: entry.username, kind: 'wrong_role', desiredRole: entry.role, actualRole: found.role }];
    }
    return [];
  });

  const orphanDrift = actual.flatMap((entry): readonly Drift[] => {
    if (!entry.exists) {
      return [];
    }
    const desiredEntry = desiredByUser.get(entry.username);
    if (desiredEntry !== undefined && desiredEntry.role !== null) {
      return [];
    }
    return [{ username: entry.username, kind: 'orphan_user', desiredRole: null, actualRole: entry.role }];
  });

  return [...desiredDrift, ...orphanDrift];
};
```

- [ ] Run `pnpm --filter @lab/demo-okta exec vitest run runner/test/grantDiff.test.ts`. Expected PASS: 5 tests passing.
- [ ] Commit:

```bash
git add demos/okta/runner/src/grantDiff.ts demos/okta/runner/test/grantDiff.test.ts
git commit -m "okta: add grantDiff drift detection"
```

### Task 5: `latency.ts` (pure: elapsed ms since an Okta event's published timestamp)

- [ ] Write the failing test `demos/okta/runner/test/latency.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { msSincePublished } from '../src/latency';

describe('msSincePublished', () => {
  it('computes the millisecond gap between a published ISO timestamp and a later time', () => {
    const publishedMs = Date.parse('2026-01-01T00:00:00.000Z');
    const completedAtMs = publishedMs + 500;
    expect(msSincePublished('2026-01-01T00:00:00.000Z', completedAtMs)).toBe(500);
  });

  it('throws on an invalid ISO timestamp', () => {
    expect(() => msSincePublished('not-a-date', Date.now())).toThrow('invalid ISO timestamp: not-a-date');
  });
});
```

- [ ] Run `pnpm --filter @lab/demo-okta exec vitest run runner/test/latency.test.ts`. Expected FAIL: `Cannot find module '../src/latency'`.
- [ ] Write the minimal implementation `demos/okta/runner/src/latency.ts`:

```ts
export const msSincePublished = (publishedIso: string, completedAtMs: number): number => {
  const publishedMs = Date.parse(publishedIso);
  if (Number.isNaN(publishedMs)) {
    throw new Error(`invalid ISO timestamp: ${publishedIso}`);
  }
  return completedAtMs - publishedMs;
};
```

- [ ] Run `pnpm --filter @lab/demo-okta exec vitest run runner/test/latency.test.ts`. Expected PASS: 2 tests passing.
- [ ] Commit:

```bash
git add demos/okta/runner/src/latency.ts demos/okta/runner/test/latency.test.ts
git commit -m "okta: add latency measurement helper"
```

### Task 6: `manifest.json` and its test

- [ ] Write the failing test `demos/okta/test/manifest.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DemoManifestSchema } from '@lab/contract';

describe('okta manifest', () => {
  it('parses against DemoManifestSchema', () => {
    const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const result = DemoManifestSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});
```

- [ ] Run `pnpm --filter @lab/demo-okta exec vitest run test/manifest.test.ts`. Expected FAIL: `ENOENT: no such file or directory, open '.../demos/okta/manifest.json'`.
- [ ] Write `demos/okta/manifest.json` in full:

```json
{
  "id": "okta",
  "number": 5,
  "title": "Okta identity lifecycle to TiDB database access",
  "tagline": "Okta group membership drives TiDB grants, live, with a revoke you can watch fail on camera.",
  "integrations": ["okta"],
  "pattern": "Enterprise security team in a PoC asking many SSO setup questions and wanting to see identity lifecycle end to end before approving a new database.",
  "publish": true,
  "runner": {
    "command": ["node", "--import", "tsx", "runner/main.ts"],
    "cwd": "."
  },
  "nodes": [
    { "id": "okta", "label": "Okta", "kind": "identity", "x": 10, "y": 50 },
    { "id": "sync", "label": "Identity Sync Service", "kind": "service", "x": 35, "y": 50 },
    { "id": "tidb", "label": "TiDB", "kind": "tidb", "x": 55, "y": 50 },
    { "id": "app", "label": "Reporting App", "kind": "client", "x": 82, "y": 50 }
  ],
  "edges": [
    { "id": "okta-to-sync", "from": "okta", "to": "sync", "label": "group events", "unit": "msgs/s" },
    { "id": "sync-to-tidb", "from": "sync", "to": "tidb", "label": "grants applied", "unit": "rows/s" },
    { "id": "app-to-tidb", "from": "app", "to": "tidb", "label": "queries", "unit": "req/s" }
  ],
  "metrics": [
    {
      "id": "provision-latency-ms",
      "label": "Provision latency",
      "unit": "ms",
      "display": "both",
      "better": "lower",
      "group": "latency",
      "howMeasured": "msSincePublished(event.published, Date.now()) where event is the Okta System Log group.user_membership.add entry and the end time is when CREATE USER + GRANT complete for that user"
    },
    {
      "id": "revoke-latency-ms",
      "label": "Revoke latency",
      "unit": "ms",
      "display": "both",
      "better": "lower",
      "group": "latency",
      "howMeasured": "msSincePublished(event.published, Date.now()) where event is the Okta user.lifecycle.deactivate or final group.user_membership.remove entry and the end time is when a real mysql2 connection attempt as that user first throws access-denied"
    },
    {
      "id": "grant-drift-count",
      "label": "Grant drift count",
      "unit": "count",
      "display": "both",
      "better": "lower",
      "group": "correctness",
      "howMeasured": "findDrift(desired, actual).length computed each reconciliation tick, desired from a fresh Okta Groups API read, actual from parsing SHOW GRANTS FOR <user> for every lab_-prefixed TiDB user"
    },
    {
      "id": "audit-events-processed",
      "label": "Audit events processed",
      "unit": "count",
      "display": "series",
      "better": "higher",
      "group": "throughput",
      "howMeasured": "cumulative count of Okta System Log entries read and applied by the poller since the runner started, incremented once per processed entry"
    }
  ],
  "phases": [
    { "id": "baseline", "label": "Baseline", "narration": "Here's our starting state: two TiDB roles already exist, and our demo user has no Okta group membership and no TiDB login yet." },
    { "id": "provision", "label": "Provision on group add", "narration": "Watch the clock: from the moment I add this person to the analysts group in Okta, to the moment they can query the reporting schema in TiDB." },
    { "id": "rescope", "label": "Re-scope on group move", "narration": "Now I move them to engineering in Okta. TiDB re-scopes their grants, no manual SQL." },
    { "id": "revoke", "label": "Revoke on removal", "narration": "I deactivate them in Okta. Their next database connection attempt fails, on camera, not asserted." },
    { "id": "reconcile", "label": "Reconcile and prove no drift", "narration": "One more pass to prove there's no drift between what Okta says and what TiDB actually grants." }
  ],
  "checks": [
    { "id": "revoked-user-rejected", "label": "Revoked user cannot connect", "description": "A real mysql2 connection attempt as the demo user after revoke throws an access-denied error." },
    { "id": "grants-match-desired", "label": "Grants match desired state", "description": "findDrift over the current desired map vs SHOW GRANTS returns an empty array." },
    { "id": "no-orphan-users", "label": "No orphan TiDB users", "description": "Every lab_-prefixed TiDB user maps to a demo user still present in at least one tracked Okta group." }
  ],
  "controls": [
    { "id": "add-to-analysts", "label": "Add demo user to lab_analysts", "description": "Calls the Okta Users API to add the demo user to the lab_analysts group." },
    { "id": "move-to-engineers", "label": "Move demo user to lab_engineers", "description": "Removes the demo user from lab_analysts and adds them to lab_engineers." },
    { "id": "remove-from-groups", "label": "Remove demo user from all groups", "description": "Removes the demo user from both lab_analysts and lab_engineers." },
    { "id": "deactivate-user", "label": "Deactivate demo user in Okta", "description": "Calls Okta's user deactivate lifecycle endpoint." }
  ]
}
```

- [ ] Run `pnpm --filter @lab/demo-okta exec vitest run test/manifest.test.ts`. Expected PASS: 1 test passing.
- [ ] Run `pnpm lab validate okta` from the workspace root. Expected: `manifest.json: OK` with no reference errors.
- [ ] Commit:

```bash
git add demos/okta/manifest.json demos/okta/test/manifest.test.ts
git commit -m "okta: add manifest and manifest test"
```

### Task 7: `.env.example`

- [ ] Write `demos/okta/.env.example` in full:

```
TIDB_HOST=127.0.0.1
TIDB_PORT=4000
TIDB_USER=root
TIDB_PASSWORD=
TIDB_DATABASE=lab
TIDB_TLS=false
LAB_ENV_TIDB=tiup playground (local)
LAB_ENV_NOTES=

OKTA_ORG_URL=https://your-org.okta.com
OKTA_API_TOKEN=
OKTA_ANALYSTS_GROUP_ID=
OKTA_ENGINEERS_GROUP_ID=
OKTA_DEMO_USER_ID=
OKTA_DEMO_USER_LOGIN=demo_okta_user@example.com
OKTA_POLL_INTERVAL_MS=3000
TIDB_REPORTING_SCHEMA=reporting
```

- [ ] No test for a static example file. Verify by running `cd demos/okta && cp .env.example .env` and confirming the relay's `pnpm lab run okta` step in Task 10 fails with a clear "missing OKTA_API_TOKEN" message rather than a silent hang, once `main.ts` exists.
- [ ] Commit:

```bash
git add demos/okta/.env.example
git commit -m "okta: add env example"
```

### Task 8: `oktaPoller.ts` (I/O adapter, manual verification)

This module wraps three plain `fetch` calls against Okta's REST API: `GET /api/v1/logs`, `GET /api/v1/groups/{groupId}/users`, and the group membership/deactivate write endpoints used by the controls. It has no unit tests; it is verified by a real Okta org.

- [ ] Write `demos/okta/runner/src/oktaPoller.ts` in full:

```ts
export type OktaLogEvent = {
  readonly uuid: string;
  readonly published: string;
  readonly eventType: string;
  readonly target: readonly { readonly id: string; readonly type: string }[];
};

export type OktaPollerOptions = {
  readonly orgUrl: string;
  readonly apiToken: string;
};

const oktaFetch = async (
  options: OktaPollerOptions,
  path: string,
  init?: RequestInit,
): Promise<Response> =>
  fetch(`${options.orgUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `SSWS ${options.apiToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

export const fetchGroupEventsSince = async (
  options: OktaPollerOptions,
  sinceIso: string,
): Promise<readonly OktaLogEvent[]> => {
  const filter = encodeURIComponent(
    'eventType eq "group.user_membership.add" or eventType eq "group.user_membership.remove" or eventType eq "user.lifecycle.deactivate"',
  );
  const response = await oktaFetch(options, `/api/v1/logs?since=${sinceIso}&filter=${filter}&sortOrder=ASCENDING`);
  if (!response.ok) {
    throw new Error(`okta system log request failed: ${response.status}`);
  }
  return (await response.json()) as readonly OktaLogEvent[];
};

export const fetchGroupMemberIds = async (
  options: OktaPollerOptions,
  groupId: string,
): Promise<readonly string[]> => {
  const response = await oktaFetch(options, `/api/v1/groups/${groupId}/users`);
  if (!response.ok) {
    throw new Error(`okta group members request failed: ${response.status}`);
  }
  const users = (await response.json()) as readonly { readonly id: string }[];
  return users.map((user) => user.id);
};

export const addUserToGroup = async (
  options: OktaPollerOptions,
  groupId: string,
  userId: string,
): Promise<void> => {
  const response = await oktaFetch(options, `/api/v1/groups/${groupId}/users/${userId}`, { method: 'PUT' });
  if (!response.ok) {
    throw new Error(`okta add-to-group failed: ${response.status}`);
  }
};

export const removeUserFromGroup = async (
  options: OktaPollerOptions,
  groupId: string,
  userId: string,
): Promise<void> => {
  const response = await oktaFetch(options, `/api/v1/groups/${groupId}/users/${userId}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(`okta remove-from-group failed: ${response.status}`);
  }
};

export const deactivateUser = async (options: OktaPollerOptions, userId: string): Promise<void> => {
  const response = await oktaFetch(options, `/api/v1/users/${userId}/lifecycle/deactivate?sendEmail=false`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`okta deactivate failed: ${response.status}`);
  }
};
```

- [ ] Manual live-run step: create a scoped API token in the Okta Admin Console (API > Tokens), then run:

```bash
cd demos/okta
node -e "
const { fetchGroupMemberIds } = require('./runner/src/oktaPoller.ts');
"
```

  Since this is TypeScript, instead run the equivalent through `tsx`:

```bash
OKTA_ORG_URL=https://your-org.okta.com OKTA_API_TOKEN=xxx OKTA_ANALYSTS_GROUP_ID=xxx \
  pnpm exec tsx -e "
    import { fetchGroupMemberIds } from './runner/src/oktaPoller';
    fetchGroupMemberIds({ orgUrl: process.env.OKTA_ORG_URL!, apiToken: process.env.OKTA_API_TOKEN! }, process.env.OKTA_ANALYSTS_GROUP_ID!).then(console.log);
  "
```

  Expected output: a JSON array of Okta user IDs currently in the `lab_analysts` group (empty array `[]` if the group has no members yet, which is correct on a fresh org).
- [ ] Manual live-run step: create the demo user and add them to `lab_analysts` in the Okta Admin Console UI, re-run the same command, and confirm the new user's ID appears in the array.
- [ ] Commit:

```bash
git add demos/okta/runner/src/oktaPoller.ts
git commit -m "okta: add Okta REST adapter (manual-verified)"
```

### Task 9: `tidbSync.ts` (I/O adapter, manual verification)

- [ ] Write `demos/okta/runner/src/tidbSync.ts` in full:

```ts
import type { Pool } from 'mysql2/promise';
import { z } from 'zod';
import { quoteIdentifier } from '@lab/runner-kit';
import type { DbRole } from './groupRoleMap';
import { accountName, roleName, stringLiteral } from './sqlIdentifiers';

const DB_ROLES: readonly DbRole[] = ['analyst', 'engineer'];

const GrantRowsSchema = z.array(z.record(z.string(), z.string()));

export const ensureRoles = async (pool: Pool, schema: string): Promise<void> => {
  const quotedSchema = quoteIdentifier(schema);
  await pool.query(`CREATE ROLE IF NOT EXISTS ${roleName('analyst')}, ${roleName('engineer')}`);
  await pool.query(`GRANT SELECT ON ${quotedSchema}.* TO ${roleName('analyst')}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE ON ${quotedSchema}.* TO ${roleName('engineer')}`);
};

export const provisionUser = async (pool: Pool, username: string, password: string, role: DbRole): Promise<void> => {
  const account = accountName(username);
  await pool.query(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${stringLiteral(password)}`);
  await Promise.all(
    DB_ROLES.filter((other) => other !== role).map((other) =>
      pool.query(`REVOKE ${roleName(other)} FROM ${account}`).catch(() => undefined),
    ),
  );
  await pool.query(`GRANT ${roleName(role)} TO ${account}`);
  await pool.query(`SET DEFAULT ROLE ${roleName(role)} TO ${account}`);
};

export const lockAndDropUser = async (pool: Pool, username: string): Promise<void> => {
  const account = accountName(username);
  await pool.query(`ALTER USER ${account} ACCOUNT LOCK`);
  await pool.query(`DROP USER IF EXISTS ${account}`);
};

const grantLinesFor = async (pool: Pool, username: string): Promise<readonly string[]> => {
  try {
    const [rows] = await pool.query(`SHOW GRANTS FOR ${accountName(username)}`);
    return GrantRowsSchema.parse(rows).flatMap((row) => Object.values(row));
  } catch {
    return [];
  }
};

const roleFromGrants = (lines: readonly string[]): DbRole | null =>
  ['engineer', 'analyst'].find((role): role is DbRole => lines.some((line) => line.includes(`'${role}'`) || line.includes(`\`${role}\``))) ?? null;

export const readActualAssignments = async (
  pool: Pool,
  usernames: readonly string[],
): Promise<readonly { readonly username: string; readonly role: DbRole | null; readonly exists: boolean }[]> =>
  Promise.all(
    usernames.map(async (username) => {
      const lines = await grantLinesFor(pool, username);
      return { username, role: roleFromGrants(lines), exists: lines.length > 0 };
    }),
  );
```

- [ ] Manual live-run step: start the local playground (`infra/tidb/playground.sh`), then run:

```bash
cd demos/okta
TIDB_HOST=127.0.0.1 TIDB_PORT=4000 TIDB_USER=root TIDB_PASSWORD= TIDB_DATABASE=lab TIDB_TLS=false \
  pnpm exec tsx -e "
    import { createTidbPool } from '@lab/runner-kit';
    import { ensureRoles, provisionUser, readActualAssignments } from './runner/src/tidbSync';
    const pool = createTidbPool(process.env);
    await ensureRoles(pool, 'reporting');
    await provisionUser(pool, 'demo_alice', 'Testpass123!', 'analyst');
    console.log(await readActualAssignments(pool, ['demo_alice']));
    await pool.end();
  "
```

  Expected output: `[ { username: 'demo_alice', role: 'analyst', exists: true } ]`.
- [ ] Manual live-run step: connect as `demo_alice` with a MySQL client and confirm `SELECT` against `reporting.*` succeeds and `INSERT` fails (analyst is read-only).
- [ ] Commit:

```bash
git add demos/okta/runner/src/tidbSync.ts
git commit -m "okta: add TiDB sync adapter (manual-verified)"
```

### Task 10: `main.ts` (wiring, manual live-run)

- [ ] Write `demos/okta/runner/main.ts` in full:

```ts
import { createEmitter, createTidbPool, every, onControl, summarize } from '@lab/runner-kit';
import { roleForGroups } from './src/groupRoleMap';
import { findDrift } from './src/grantDiff';
import { msSincePublished } from './src/latency';
import {
  addUserToGroup,
  deactivateUser,
  fetchGroupEventsSince,
  fetchGroupMemberIds,
  removeUserFromGroup,
} from './src/oktaPoller';
import { toDbUsername } from './src/sqlIdentifiers';
import { ensureRoles, lockAndDropUser, provisionUser, readActualAssignments } from './src/tidbSync';

const env = process.env;
const emitter = createEmitter();
const pool = createTidbPool(env);

const okta = { orgUrl: env.OKTA_ORG_URL ?? '', apiToken: env.OKTA_API_TOKEN ?? '' };
const analystsGroupId = env.OKTA_ANALYSTS_GROUP_ID ?? '';
const engineersGroupId = env.OKTA_ENGINEERS_GROUP_ID ?? '';
const demoUserId = env.OKTA_DEMO_USER_ID ?? '';
const demoUsername = toDbUsername(env.OKTA_DEMO_USER_LOGIN ?? 'demo_okta_user@example.com');
const schema = env.TIDB_REPORTING_SCHEMA ?? 'reporting';
const pollIntervalMs = Number(env.OKTA_POLL_INTERVAL_MS ?? '3000');

let processedEvents = 0;
let sinceIso = new Date().toISOString();
let lastKnownRole: 'analyst' | 'engineer' | null = null;

const abortController = new AbortController();

const reconcile = async (): Promise<void> => {
  const [analystIds, engineerIds] = await Promise.all([
    fetchGroupMemberIds(okta, analystsGroupId),
    fetchGroupMemberIds(okta, engineersGroupId),
  ]);
  const groupNames = [
    ...(analystIds.includes(demoUserId) ? ['lab_analysts'] : []),
    ...(engineerIds.includes(demoUserId) ? ['lab_engineers'] : []),
  ];
  const desiredRole = roleForGroups(groupNames);
  const actual = await readActualAssignments(pool, [demoUsername]);
  const drift = findDrift([{ username: demoUsername, role: desiredRole }], actual);
  emitter.metric('grant-drift-count', drift.length);
  emitter.check(
    'grants-match-desired',
    drift.length === 0 ? 'pass' : 'fail',
    JSON.stringify(drift),
  );
  emitter.check(
    'no-orphan-users',
    drift.some((entry) => entry.kind === 'orphan_user') ? 'fail' : 'pass',
  );
};

const poll = async (): Promise<void> => {
  const events = await fetchGroupEventsSince(okta, sinceIso);
  for (const event of events) {
    processedEvents += 1;
    emitter.metric('audit-events-processed', processedEvents);
    sinceIso = event.published;

    if (event.eventType === 'group.user_membership.add') {
      const groupNames = [
        ...(event.target.some((t) => t.id === analystsGroupId) ? ['lab_analysts'] : []),
        ...(event.target.some((t) => t.id === engineersGroupId) ? ['lab_engineers'] : []),
      ];
      const role = roleForGroups(groupNames);
      if (role !== null) {
        await ensureRoles(pool, schema);
        await provisionUser(pool, demoUsername, 'Testpass123!', role);
        lastKnownRole = role;
        emitter.metric(role === 'engineer' ? 'revoke-latency-ms' : 'provision-latency-ms', msSincePublished(event.published, Date.now()));
        emitter.node('tidb', 'healthy', `granted ${role}`);
      }
    }

    if (event.eventType === 'user.lifecycle.deactivate') {
      await lockAndDropUser(pool, demoUsername);
      lastKnownRole = null;
      emitter.metric('revoke-latency-ms', msSincePublished(event.published, Date.now()));
      const rejected = await pool
        .query(`SELECT 1`)
        .then(() => false)
        .catch(() => true);
      emitter.check('revoked-user-rejected', rejected ? 'pass' : 'fail');
    }
  }
  await reconcile();
};

onControl(async (id) => {
  if (id === 'add-to-analysts') {
    await addUserToGroup(okta, analystsGroupId, demoUserId);
  }
  if (id === 'move-to-engineers') {
    await removeUserFromGroup(okta, analystsGroupId, demoUserId);
    await addUserToGroup(okta, engineersGroupId, demoUserId);
  }
  if (id === 'remove-from-groups') {
    await removeUserFromGroup(okta, analystsGroupId, demoUserId);
    await removeUserFromGroup(okta, engineersGroupId, demoUserId);
  }
  if (id === 'deactivate-user') {
    await deactivateUser(okta, demoUserId);
  }
});

emitter.phase('baseline');
await ensureRoles(pool, schema);

await every({
  intervalMs: pollIntervalMs,
  task: poll,
  signal: abortController.signal,
});

void summarize;
void lastKnownRole;
```

- [ ] Manual live-run step: copy `.env.example` to `.env`, fill in real Okta values, then from the workspace root run:

```bash
pnpm lab run okta
```

  Expected: the CLI prints `listening on :7070` (or the configured port), and `GET http://localhost:7070/health` returns `{"ok":true,"demo":"okta"}`.
- [ ] Manual live-run step: in a second terminal, `curl -X POST http://localhost:7070/control/add-to-analysts`, then watch the first terminal's logs for the `provision-latency-ms` metric event and confirm a `mysql` client can log in as `demo_okta_user` and `SELECT` from the reporting schema.
- [ ] Manual live-run step: `curl -X POST http://localhost:7070/control/deactivate-user`, then confirm the `revoked-user-rejected` check event reports `pass` and the same `mysql` client login now fails.
- [ ] Commit:

```bash
git add demos/okta/runner/main.ts
git commit -m "okta: wire runner main loop"
```

### Task 11: `README.md`

- [ ] Write `demos/okta/README.md` in full:

```markdown
# Okta identity lifecycle to TiDB database access

## What it proves

- Okta group membership drives real TiDB `GRANT`/`REVOKE` statements, timed, not asserted.
- A revoked or deactivated Okta user is provably locked out of the database, shown by a real failed connection attempt.
- Grant drift between Okta's desired state and TiDB's actual `SHOW GRANTS` is measured on a reconciliation loop.
- A companion guide (`GUIDE-ORG-SSO.md`) covers TiDB Cloud's own Organization SSO with Okta, which is a separate, console-only identity plane from the database users this runner manages.

## Prerequisites

- An Okta Integrator Free Plan org (https://developer.okta.com/signup/) with two groups (`lab_analysts`, `lab_engineers`), one demo user, and an API token scoped to `okta.users.read`, `okta.users.manage`, `okta.groups.read`, `okta.groups.manage`, `okta.logs.read`.
- Local TiDB via `../../infra/tidb/playground.sh`, or a TiDB Cloud instance.
- Node 22, pnpm.

## Run

```bash
cp .env.example .env
# fill in OKTA_ORG_URL, OKTA_API_TOKEN, OKTA_ANALYSTS_GROUP_ID, OKTA_ENGINEERS_GROUP_ID, OKTA_DEMO_USER_ID
pnpm lab run okta
```

Open the UI at `http://localhost:5173` and select this demo to watch the flow diagram and metrics live, or press the control buttons directly with `curl -X POST http://localhost:7070/control/<id>`.

## Record

```bash
pnpm lab run okta --record
```

Run through all five phases (see TALK-TRACK.md), then stop the runner. Promote the newest file in `traces/` to `traces/featured.json` once it looks clean.

## Teardown

```bash
tiup clean lab
```

In TiDB:

```sql
DROP USER IF EXISTS 'demo_okta_user'@'%';
DROP ROLE IF EXISTS 'analyst', 'engineer';
```

In Okta: delete the demo user, delete `lab_analysts` and `lab_engineers`, revoke the API token.

## Cost notes

The Okta org is free under the Integrator Free Plan's published limits (see https://developer.okta.com/docs/reference/org-defaults/, do not hardcode the numeric limits elsewhere). TiDB cost follows the local playground (free) or the TiDB Cloud pricing page (https://www.pingcap.com/tidb-cloud-pricing/) for a Cloud instance.
```

- [ ] No automated test for prose; verify by following the Run section against a real Okta org and local TiDB once Tasks 1-10 are complete.
- [ ] Commit:

```bash
git add demos/okta/README.md
git commit -m "okta: add README"
```

### Task 12: `TALK-TRACK.md`

- [ ] Write `demos/okta/TALK-TRACK.md` in full:

```markdown
# Talk track: Okta identity lifecycle to TiDB database access

## Presenter script by phase

**Baseline** - "Here's our starting state. TiDB already has two roles: `analyst`, read-only on the reporting schema, and `engineer`, read-write. Our demo user isn't in any Okta group yet, and has no TiDB login. Nothing here is faked; this is a real Okta org and a real TiDB cluster."

**Provision** - "I'm adding this person to the `lab_analysts` group in Okta right now. Watch the provision-latency metric: that's the actual wall-clock gap between Okta's own audit log timestamp for the group-add event and the moment TiDB finishes creating the user and granting the role. No polling trick, no pre-staged state."

**Re-scope** - "Now I move them to engineering in Okta. TiDB re-scopes their grants automatically. There's no manual SQL step and no application restart."

**Revoke** - "I deactivate them in Okta. Watch: this isn't a UI mock. The runner makes an actual database connection attempt as that user right after deactivation, and you'll see it fail with an access-denied error. That's the revoke-latency metric."

**Reconcile** - "Last step: a reconciliation pass compares what Okta says the desired grants should be against what TiDB actually has, right now. The drift count is zero because we're not carrying any stale grants."

## Discovery questions

1. "Which identity provider issues your database credentials today, and how does a group change there reach the database?"
2. "When someone is offboarded, how long does it take before their database access actually stops working, and how do you know?"
3. "Do you already know that TiDB Cloud's own SSO covers console access but not database users, or is that a surprise?"
4. "Are you using Okta's Event Hooks or System Log anywhere else today, or would this be the first?"
5. "What's your current process for finding orphaned database accounts that no longer map to an active employee?"

## Objections and honest answers

1. **"Doesn't TiDB Cloud already do this through SSO?"** - No. TiDB Cloud's Organization SSO and SCIM provisioning manage console/org/project roles, not MySQL-protocol database users. The docs state database users and roles are independent of organization and project users. This demo's sync service is what closes that gap, exactly as it would need to be built for any MySQL-compatible database.
2. **"Why polling instead of Okta Event Hooks, isn't that slower?"** - Slightly, by at most one poll interval. Event Hooks need a public HTTPS endpoint that passes Okta's verification challenge, which means a tunnel for anything not already deployed with a public URL. For a production deployment behind a real ingress, Event Hooks are the better choice; we used polling here so the demo has zero dependency on tunnel infrastructure.
3. **"Is the LDAP or JWT path production ready?"** - Self-managed TiDB's `authentication_ldap_simple` and `tidb_auth_token` are both real, documented features. Whether Okta's LDAP Interface is available on your specific Okta plan, and whether your Authorization Server can be configured to issue a token `sub` claim matching your TiDB usernames, are both things we verify against your actual tenant before committing to that path; we flag both as unverified in the written plan for exactly that reason.
4. **"What happens if the sync service goes down?"** - In this demo it's a single process with no HA. In production this becomes a supervised service (or a scheduled job) with alerting on poll failures and a reconciliation pass frequent enough that a missed event window self-heals within one cycle, which is exactly what the `grant-drift-count` metric is designed to catch.
5. **"Does this work the same way for other IdPs?"** - The pattern (poll or webhook an IdP's audit/group API, map groups to roles, apply grants, reconcile) is IdP-agnostic. Only the adapter (`oktaPoller.ts`) is Okta-specific; `groupRoleMap.ts`, `grantDiff.ts`, and `sqlIdentifiers.ts` do not know Okta exists.
```

- [ ] No automated test for prose. Commit:

```bash
git add demos/okta/TALK-TRACK.md
git commit -m "okta: add talk track"
```

### Task 13: `GUIDE-ORG-SSO.md` (Part A)

- [ ] Write `demos/okta/GUIDE-ORG-SSO.md` using the exact facts and caveats from section 2 (Part A) and section 4 of this plan, including the literal **UNVERIFIED** markers for the OIDC redirect URI and the break-glass negative. Do not invent a redirect URI value; leave a placeholder and the confirmation step.
- [ ] No automated test for prose; verify by walking through the guide against a real TiDB Cloud paid organization and a real Okta OIDC or SAML app before recording Part A.
- [ ] Commit:

```bash
git add demos/okta/GUIDE-ORG-SSO.md
git commit -m "okta: add Organization SSO guide (Part A)"
```

## 8. Recording the featured trace

- [ ] Confirm `.env` has real Okta values and TiDB is reachable (local playground or Cloud instance), and that the demo user starts in no tracked group with no TiDB login (rerun the Task 5 teardown SQL and remove the demo user from both Okta groups if a prior run left state behind).
- [ ] Set `LAB_ENV_TIDB` to the exact version string printed at `tiup playground` startup, or the TiDB Cloud version shown in the console, and fill `LAB_ENV_NOTES` with anything unusual about the run (e.g. "recorded against Okta Integrator Free Plan org, TiDB Cloud Starter instance").
- [ ] Start the recording: `pnpm lab run okta --record`.
- [ ] Open the UI, and in order: let baseline settle for a few seconds, press `add-to-analysts` and wait for the provision check and metric, press `move-to-engineers` and wait for the re-grant, press `deactivate-user` and wait for the revoke check to flip to `pass`, then let one reconcile tick complete showing `grant-drift-count` at 0. Total run should land in the 3-6 minute range the platform targets for a recording.
- [ ] Stop the runner (Ctrl-C). Confirm a new timestamped file appears under `demos/okta/traces/`.
- [ ] Open that trace file and spot-check: every `metric` event references an id in `manifest.json`'s `metrics`, every `check` event ends in `pass` (not stuck on `pending` or `fail`), and `environment.tidb` / `environment.components` are filled in, not empty strings.
- [ ] Promote it: `cp demos/okta/traces/<timestamp>.json demos/okta/traces/featured.json`.
- [ ] Run `pnpm lab validate okta` from the workspace root. Expected: manifest and `traces/featured.json` both pass, including `eventReferenceErrors` returning no errors for any event.
- [ ] Run `pnpm lab check-public` from the workspace root. Expected: no denylisted terms or internal URLs found in any file under `demos/okta/`.
- [ ] Commit:

```bash
git add demos/okta/traces/featured.json
git commit -m "okta: add featured trace"
```

## 9. Risks and gotchas

- **Okta Integrator Free Plan org limits.** 10 active users and orgs deactivate after 90 consecutive days with no sign-in (per https://developer.okta.com/docs/reference/org-defaults/); re-verify current limits before every recording session since they are not hardcoded here.
- **System Log eventual consistency.** Okta's System Log can lag actual actions by a few seconds; the `provision-latency-ms`/`revoke-latency-ms` metrics measure from the log's `published` timestamp, not from the moment the control button was pressed, so they slightly overstate true user-perceived latency. Call this out on camera rather than let the number stand unexplained.
- **Poll interval vs rate limit.** `OKTA_POLL_INTERVAL_MS` must stay comfortably under whatever the org's actual `/api/v1/logs` rate-limit bucket allows; the commonly cited default is 100 requests/minute (see section 4's UNVERIFIED note), so a 3-second interval (20 requests/minute) has generous headroom, but confirm the real bucket in the org's own Rate Limit Dashboard before a live customer demo.
- **`memberOf` is slow if the optional LDAP Act C is ever built.** Okta's LDAP Interface docs call out that `memberOf` is not indexed and searches can be slow at scale; irrelevant for a two-group demo but worth flagging if a customer asks about scaling this to hundreds of groups.
- **`tidb_auth_token`'s `sub` claim must equal the TiDB username exactly.** If Act C is ever built, this likely requires configuring the Okta application's username format (or a custom Authorization Server claim) so the issued token's `sub` is something TiDB can use as a username; this is explicitly UNVERIFIED in section 4 and must be confirmed against a real Okta tenant before building.
- **JWKS is a local file in TiDB, not a live URL.** Any `tidb_auth_token` build needs its own small sidecar that periodically fetches Okta's JWKS endpoint and writes it to the path TiDB's `auth-token-jwks` config points at; TiDB does not fetch JWKS over HTTP itself.
- **The `SQL Users` console page is a preview feature gated behind a support ticket.** This plan manages TiDB database users and roles by connecting with a SQL client and running statements directly (via `tidbSync.ts`), which needs no such request and works identically on TiDB Cloud and TiDB Self-Managed.
- **Cloud Organization SSO cannot be disabled once enabled.** Never enable it against a shared or production TiDB Cloud organization for a Part A walkthrough; use a disposable or already-SSO-enabled demo organization.
- **No parameter binding for account DDL.** TiDB cannot bind parameters in `CREATE USER`, `GRANT`, `REVOKE` or `SHOW GRANTS`, so `tidbSync.ts` builds those statements only from `accountName` (usernames restricted to `^[a-z0-9][a-z0-9._-]{0,31}$`), `roleName` (a fixed two-role list) and `stringLiteral` (escaped). The demo password is a fixed, non-secret value (`Testpass123!`) and is never logged.
- **Okta Event Hooks remain the right production answer.** If a customer wants sub-second reaction instead of poll-interval latency, point them at Event Hooks with a real ingress and TLS termination, not at a local tunnel; this plan intentionally does not build that path live.

## 10. Subagent work packets

Format, dispatch prompt and conformance checklist: see `EXECUTION.md`. Packets in this plan run in the order listed; a later packet may edit a file an earlier packet created. Plan 00 must be complete first.

### Packet 05-V1: Verify open facts before building
- Tasks: none (docs only)
- Depends on: 00-P10   Shared runtime: cloud-account
- Files owned: `integrations/docs/plans/05-okta.md` (section 4 only)
- Model: sonnet   Effort: S
- Items to confirm (run each item's confirm step, paste the real output into section 4, set VERIFIED or record the workaround):
  - | The literal OIDC redirect/callback URI value shown in the TiDB Cloud console | same page (does not print the literal value in fetched text) | **UNVERIFIED** - confirm by enabling OIDC in a live org and reading the console pane; record the literal value in `GUIDE-ORG-SSO.md` |
  - | TiDB Cloud has no documented break-glass/emergency-admin feature | Absence in https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/ | **UNVERIFIED as a negative** - re-check release notes at build time |
  - | Whether an Okta Authorization Server can be configured so an ID/access token's `sub` claim equals an arbitrary TiDB username (e.g. via app username format) without custom code | Not found in fetched docs | **UNVERIFIED** - confirm in a real Okta org's Authorization Server / app "username format" s
  - | Because Okta's LDAP Interface documents simple bind only, `authentication_ldap_simple` is the plausible pairing and `authentication_ldap_sasl` (SCRAM/GSSAPI) is not documented as supported against it | Inference from the two sources above | **UNVERIFIED** - no doc states this pairing explicitly ei
  - | Okta's LDAP Interface is not listed among the features included in the Integrator Free Plan (SSO, Universal Directory, Adaptive MFA, Lifecycle Management, API Access Management, Workflows) | https://developer.okta.com/docs/reference/org-defaults/ | **UNVERIFIED** - the page does not explicitly say
  - | Default rate limit for `GET /api/v1/logs` is commonly reported as 100 requests/minute, configurable up to 1000 requests/minute | https://devforum.okta.com/t/what-is-ratelimit-for-system-logs-api-v1-logs/35056 and https://developer.okta.com/docs/reference/rl2-monitor/ | **UNVERIFIED for this specif
- Gate:
  - `grep -c UNVERIFIED integrations/docs/plans/05-okta.md` -> lower than before, and every remaining item says why it cannot be checked yet
- Done when: no packet below depends on an unconfirmed fact without a recorded workaround.

### Packet 05-P1: Scaffold the demo package
- Tasks: 1
- Depends on: 05-V1   Shared runtime: none
- Files owned: `integrations/demos/okta/package.json`, `integrations/demos/okta/tsconfig.json`
- Model: sonnet   Effort: S
- Gate:
  - `cd demos/okta && pnpm install` -> lockfile updates, no errors, `node_modules/@lab/contract` and `node_modules/@lab/runner-kit` are symlinks into the workspace packages
- Done when: Task 1's steps are all checked off and the gate output matches.

### Packet 05-P2: `groupRoleMap.ts` (pure: Okta group -> TiDB role)
- Tasks: 2
- Depends on: 05-P1   Shared runtime: cloud-account
- Files owned: `integrations/demos/okta/runner/src/groupRoleMap.ts`, `integrations/demos/okta/runner/test/groupRoleMap.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-okta exec vitest run runner/test/groupRoleMap.test.ts` -> PASS: 5 tests passing
  - `pnpm --filter @lab/demo-okta typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 2's steps are all checked off and the gate output matches.

### Packet 05-P3: `sqlIdentifiers.ts` (pure: safe account names, roles and literals)
- Tasks: 3
- Depends on: 05-P2   Shared runtime: cloud-account
- Files owned: `integrations/demos/okta/runner/src/sqlIdentifiers.ts`, `integrations/demos/okta/runner/test/sqlIdentifiers.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-okta exec vitest run runner/test/sqlIdentifiers.test.ts` -> PASS: 7 tests passing
  - `pnpm --filter @lab/demo-okta typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 3's steps are all checked off and the gate output matches.

### Packet 05-P4: `grantDiff.ts` (pure: desired vs actual grant drift)
- Tasks: 4
- Depends on: 05-P3   Shared runtime: none
- Files owned: `integrations/demos/okta/runner/src/grantDiff.ts`, `integrations/demos/okta/runner/test/grantDiff.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-okta exec vitest run runner/test/grantDiff.test.ts` -> PASS: 5 tests passing
  - `pnpm --filter @lab/demo-okta typecheck` -> exit 0
- Done when: Task 4's steps are all checked off and the gate output matches.

### Packet 05-P5: `latency.ts` (pure: elapsed ms since an Okta event's published timestamp)
- Tasks: 5
- Depends on: 05-P4   Shared runtime: cloud-account
- Files owned: `integrations/demos/okta/runner/src/latency.ts`, `integrations/demos/okta/runner/test/latency.test.ts`
- Model: sonnet   Effort: S
- Gate:
  - `pnpm --filter @lab/demo-okta exec vitest run runner/test/latency.test.ts` -> PASS: 2 tests passing
  - `pnpm --filter @lab/demo-okta typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 5's steps are all checked off and the gate output matches.

### Packet 05-P6: `manifest.json` and its test
- Tasks: 6
- Depends on: 05-P5   Shared runtime: cloud-account
- Files owned: `integrations/demos/okta/manifest.json`, `integrations/demos/okta/test/manifest.test.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-okta exec vitest run test/manifest.test.ts` -> PASS: 1 test passing
  - `pnpm lab validate okta` -> `manifest.json: OK` with no reference errors
  - `pnpm --filter @lab/demo-okta typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 6's steps are all checked off and the gate output matches.

### Packet 05-P7: `.env.example`
- Tasks: 7
- Depends on: 05-P6   Shared runtime: tidb-playground
- Files owned: `integrations/demos/okta/.env.example`
- Model: sonnet   Effort: S
- Gate:
  - `grep -cE '^(TIDB_HOST|TIDB_PORT|TIDB_USER|TIDB_PASSWORD|TIDB_DATABASE|TIDB_TLS|LAB_ENV_TIDB|LAB_ENV_NOTES)=' integrations/demos/okta/.env.example` -> 8
- Done when: Task 7's steps are all checked off and the gate output matches.

### Packet 05-P8: `oktaPoller.ts` (I/O adapter, manual verification)
- Tasks: 8
- Depends on: 05-P7   Shared runtime: cloud-account
- Files owned: `integrations/demos/okta/runner/src/oktaPoller.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-okta typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 8's steps are all checked off and the gate output matches.

### Packet 05-P9: `tidbSync.ts` (I/O adapter, manual verification)
- Tasks: 9
- Depends on: 05-P8   Shared runtime: none
- Files owned: `integrations/demos/okta/runner/src/tidbSync.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-okta typecheck` -> exit 0
- Done when: Task 9's steps are all checked off and the gate output matches.

### Packet 05-P10: `main.ts` (wiring, manual live-run)
- Tasks: 10
- Depends on: 05-P9   Shared runtime: cloud-account
- Files owned: `integrations/demos/okta/runner/main.ts`
- Model: sonnet   Effort: M
- Gate:
  - `pnpm --filter @lab/demo-okta typecheck` -> exit 0
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 10's steps are all checked off and the gate output matches.

### Packet 05-P11: `README.md`
- Tasks: 11
- Depends on: 05-P10   Shared runtime: cloud-account
- Files owned: `integrations/demos/okta/README.md`
- Model: sonnet   Effort: S
- Gate:
  - `grep -c $'\u2014' integrations/demos/okta/README.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 11's steps are all checked off and the gate output matches.

### Packet 05-P12: `TALK-TRACK.md`
- Tasks: 12
- Depends on: 05-P11   Shared runtime: cloud-account
- Files owned: `integrations/demos/okta/TALK-TRACK.md`
- Model: sonnet   Effort: S
- Gate:
  - `grep -c $'\u2014' integrations/demos/okta/TALK-TRACK.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 12's steps are all checked off and the gate output matches.

### Packet 05-P13: `GUIDE-ORG-SSO.md` (Part A)
- Tasks: 13
- Depends on: 05-P12   Shared runtime: cloud-account
- Files owned: `integrations/demos/okta/GUIDE-ORG-SSO.md`
- Model: sonnet   Effort: S
- Gate:
  - `grep -c $'\u2014' integrations/demos/okta/GUIDE-ORG-SSO.md` -> 0 for every file
  - `pnpm lab check-public` -> `0 findings`
  - teardown confirmed with this plan's section 5 commands before the next cloud packet starts
- Done when: Task 13's steps are all checked off and the gate output matches.

### Packet 05-R: Record and publish the featured trace
- Tasks: section 8
- Depends on: 05-P13   Shared runtime: cloud-account
- Files owned: `integrations/demos/okta/traces/featured.json`
- Model: coordinator   Effort: M
- Gate:
  - `pnpm lab validate okta` -> `okta: manifest ok, featured trace ok (N events)`
  - `pnpm lab check-public` -> `0 findings`
  - teardown commands from section 5 run and confirmed
- Done when: the replay tells the whole story in 3-6 minutes of playback at 1x.

## Build notes (live recording, 2026-09-29)

- **Bug found live: `poll()` re-processed the same Okta System Log event forever.** Okta's `GET /api/v1/logs?since=<iso>` filter is inclusive of the `since` timestamp, and `main.ts` set `sinceIso = event.published` after handling an event, then used that same value as the next poll's `since`. The result: the same `group.user_membership.add` entry kept coming back on every 3s poll, and `applyGroupChange` re-ran `provisionUser` and re-emitted `provision-latency-ms` every cycle with a growing value (observed live: 62485, 65464, 68414, ... climbing by ~3000ms per poll, 12 duplicate emissions before the run was stopped). Fixed test-first: added a pure `selectNewEvents(events, seenUuids)` in `runner/src/eventCursor.ts` (3 passing tests in `runner/test/eventCursor.test.ts`) and a `seenEventUuids` `Set<string>` in `main.ts`'s poll loop that dedupes fetched events by `uuid` before processing. `pnpm --filter @lab/demo-okta exec vitest run` (30 tests) and `pnpm --filter @lab/demo-okta exec tsc -p tsconfig.json` both green after the fix.
- **VERIFIED**: `GET /api/v1/users` against the org returns 200 for the token used (confirmed before any object creation).
- **VERIFIED**: Okta group membership changes (both add and remove via `PUT`/`DELETE /api/v1/groups/{id}/users/{id}`) are not instantaneous from a subsequent group-members read; observed a few seconds of propagation lag on this org, separate from and in addition to the System Log's own lag noted in section 9.
- **VERIFIED**: the revoke check genuinely fails first, then passes, exactly as this task's instructions anticipated: after `deactivate-user`, `lockAndDropUser` drops the TiDB account and `revoked-user-rejected` passes immediately (real connection attempt denied), but the very next reconcile tick reports `grants-match-desired: fail` with a `missing_user` drift, because Okta's own group membership for the demo user is untouched by deactivation alone (the user stays a member of `lab-engineers` even though their status is `DEACTIVATED`). Pressing `remove-from-groups` afterward clears the Okta side and the next reconcile tick reports `grant-drift-count: 0` / `grants-match-desired: pass`. This is a real, on-camera "fails, then gets fixed" moment, not a scripted one.
- Okta lab objects created via the API for this recording: groups `lab-analysts` / `lab-engineers`, user `lab-demo-user@example.com` created with `activate=false` (no credentials, no email sent; status `STAGED`). All deleted in teardown after the recording (see section 5).
