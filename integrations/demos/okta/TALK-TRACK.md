# Talk track: Okta identity lifecycle to TiDB database access

## Presenter script by phase

**Baseline** - "Here's our starting state. TiDB already has two roles: `analyst`, read-only on the reporting schema, and `engineer`, read-write. Our demo user isn't in any Okta group yet, and has no TiDB login. Nothing here is faked; this is a real Okta org and a real TiDB cluster."

**Provision** - "I'm adding this person to the `lab_analysts` group in Okta right now. Watch the provision-latency metric: that's the actual wall-clock gap between Okta's own audit log timestamp for the group-add event and the moment TiDB finishes creating the user and granting the role. No polling trick, no pre-staged state."

**Re-scope** - "Now I move them to engineering in Okta. TiDB re-scopes their grants automatically. There's no manual SQL step and no application restart."

**Revoke** - "I deactivate them in Okta. Watch: this isn't a UI mock. The runner makes an actual database connection attempt as that user right after revoke, and you'll see it fail with an access-denied error. That's the revoke-latency metric."

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
