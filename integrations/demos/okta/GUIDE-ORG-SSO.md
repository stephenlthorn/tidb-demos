# Guide: TiDB Cloud Organization SSO with Okta (Part A)

This is a screen-share walkthrough of the real TiDB Cloud console plus a real Okta OIDC or SAML app. There is no manifest, no runner, and nothing here is recorded as a trace; it is presenter narration over a live console. Part B (this demo's runner) covers a completely different identity plane: TiDB database users and roles, not TiDB Cloud console access.

## Prerequisites

- A TiDB Cloud organization on a paid plan (Cloud Organization SSO is a paid-org feature), with Organization Owner access. Use a disposable or already-SSO-enabled demo organization; Cloud Organization SSO cannot be disabled once turned on, so never enable it against a shared or production organization for a walkthrough.
- An Okta org (the Integrator Free Plan is enough) with permission to create an OIDC or SAML application.
- A verified email domain if you plan to demonstrate auto-provisioning or SAML SCIM, since both require Allowed Email Domains verified by a DNS TXT record.

## 1. Standard SSO vs Cloud Organization SSO

TiDB Cloud ships with Standard SSO (Google, GitHub, Microsoft) on by default for every organization. Cloud Organization SSO is a separate, paid-org-only feature that is off by default: it adds username/password, Google, GitHub, Microsoft, OIDC, and SAML as configurable methods, with organization-wide control over which methods are active.

Source: https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/ and https://docs.pingcap.com/tidbcloud/tidb-cloud-sso-authentication/. Status: Verified.

## 2. The custom login URL

Enabling Cloud Organization SSO gives the organization a custom login URL of the form `https://tidbcloud.com/enterprise/signin/<company-name>`. Walk through where this is configured in the console, and tell the audience plainly that this URL cannot be changed later without contacting TiDB Cloud Support.

Source: https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/. Status: Verified.

## 3. Configuring OIDC

TiDB Cloud's OIDC method needs three values from the Okta OIDC app: Issuer URL, Client ID, and Client Secret. Walk through creating the Okta OIDC app first, then entering those three values into TiDB Cloud.

**UNVERIFIED**: the literal redirect/callback URI value that TiDB Cloud's console displays for the audience to paste into the Okta app. The console only shows this value once OIDC is enabled in a real organization, and it was not present in the fetched documentation text. Confirm it by enabling OIDC in a live org, reading the "Authentication Method Details" pane, and replacing the placeholder below with the literal value before recording:

```
Okta app redirect URI: <CONFIRM IN A LIVE ORG - see Authentication Method Details pane>
```

Source: https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/ (redirect URI value not printed in fetched text). Status: UNVERIFIED, confirm before recording.

## 4. Configuring SAML

TiDB Cloud pre-populates two values for the SAML method: an Entity ID (SP entity ID) and a Postback URL (the ACS URL). Both go into the Okta SAML app. In return, Okta provides a Sign-on URL and a Signing Certificate, which go back into TiDB Cloud.

Source: https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/. Status: Verified.

## 5. Auto-provisioning

Auto-provisioning is off by default. When turned on, any user of the enabled method who signs in is auto-joined to the organization with the default **Organization Viewer** role. Both OIDC/SAML auto-provisioning and SAML SCIM require verified Allowed Email Domains, confirmed through a DNS TXT record.

Source: https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/. Status: Verified.

## 6. SCIM provisioning (SAML only)

SCIM provisioning is available only on the SAML method, never OIDC. Okta pushes its groups to TiDB Cloud, which shows them under Organization Settings > Authentication > Groups. The presenter grants each pushed group an organization or project role in TiDB Cloud. From then on, group membership changes made in Okta dynamically add or remove the corresponding TiDB Cloud console role. Call out clearly that this is real group-to-role mapping, but it is console RBAC only, never a database grant.

Source: https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/. Status: Verified.

## 7. Enforcing SSO

Enforcing SSO means disabling the username/password authentication method so only IdP methods remain on the login page. Show this toggle and explain that it is the last step once every admin and user has a working IdP login.

Source: https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/. Status: Verified.

## 8. Break-glass admin access

TiDB Cloud has no dedicated break-glass or emergency-admin feature. This is confirmed only by its absence from the Organization SSO Authentication documentation, so treat it as an **UNVERIFIED negative**: re-check TiDB Cloud release notes before every recording session in case this changes. The documented safety net is procedural, not a feature: keep the organization owner's own verified email domain enabled on at least one authentication method before disabling password auth, and remember that changing the custom login URL after enablement requires contacting TiDB Cloud Support.

Source: absence in https://docs.pingcap.com/tidbcloud/tidb-cloud-org-sso-authentication/. Status: UNVERIFIED as a negative, re-check before every recording.

## 9. Why database-user SSO does not exist

Close the walkthrough with the exact gap Part B closes. `docs.pingcap.com/tidbcloud/configure-sql-users/` states plainly that "Database users and roles are independent of organization and project users and roles." Organization SSO and SCIM provisioning never reach MySQL-protocol database accounts. An enterprise that wants Okta groups to control database grants needs a small sync service, which is exactly what this demo's runner (Part B) builds and measures.

Source: https://docs.pingcap.com/tidbcloud/configure-sql-users/. Status: Verified.

## Reference: TiDB Cloud console roles

For completeness when discussing SCIM group-to-role mapping in step 6, TiDB Cloud organization roles are Owner, Billing Manager, Billing Viewer, Console Audit Manager, and Viewer; project roles are Owner, Data Access Read-Write, Data Access Read-Only, and Viewer.

Source: https://docs.pingcap.com/tidbcloud/manage-user-access/. Status: Verified.

## After the walkthrough

Move to Part B (`README.md`, `TALK-TRACK.md`) to show the identity-lifecycle runner that keeps TiDB database users and grants in lockstep with Okta group membership, the gap this guide identifies in step 9.
