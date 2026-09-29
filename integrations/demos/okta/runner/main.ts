import { createConnection } from 'mysql2/promise';
import { createEmitter, createTidbPool, every, onControl, tidbConfigFromEnv } from '@lab/runner-kit';
import { roleForGroups } from './src/groupRoleMap';
import type { DbRole } from './src/groupRoleMap';
import { findDrift } from './src/grantDiff';
import { selectNewEvents } from './src/eventCursor';
import { msSincePublished } from './src/latency';
import {
  addUserToGroup,
  deactivateUser,
  fetchGroupEventsSince,
  fetchGroupMemberIds,
  removeUserFromGroup,
} from './src/oktaPoller';
import type { OktaLogEvent, OktaPollerOptions } from './src/oktaPoller';
import { toDbUsername } from './src/sqlIdentifiers';
import { ensureRoles, lockAndDropUser, provisionUser, readActualAssignments } from './src/tidbSync';

const env = process.env;
const emitter = createEmitter();
const pool = createTidbPool(env);

const okta: OktaPollerOptions = { orgUrl: env.OKTA_ORG_URL ?? '', apiToken: env.OKTA_API_TOKEN ?? '' };
const analystsGroupId = env.OKTA_ANALYSTS_GROUP_ID ?? '';
const engineersGroupId = env.OKTA_ENGINEERS_GROUP_ID ?? '';
const demoUserId = env.OKTA_DEMO_USER_ID ?? '';
const demoUsername = toDbUsername(env.OKTA_DEMO_USER_LOGIN ?? 'demo_okta_user@example.com');
const schema = env.TIDB_REPORTING_SCHEMA ?? 'reporting';
const pollIntervalMs = Number(env.OKTA_POLL_INTERVAL_MS ?? '3000');
const demoPassword = 'Testpass123!';

type DemoPhase = 'baseline' | 'provision' | 'rescope' | 'revoke' | 'reconcile';

let currentPhase: DemoPhase = 'baseline';
let processedEvents = 0;
let sinceIso = new Date().toISOString();
let lastKnownRole: DbRole | null = null;
const seenEventUuids = new Set<string>();

const abortController = new AbortController();

const setPhase = (phase: DemoPhase): void => {
  if (phase === currentPhase) return;
  currentPhase = phase;
  emitter.phase(phase);
};

const targetsInclude = (event: OktaLogEvent, id: string): boolean =>
  event.target.some((target) => target.id === id);

const currentGroupNames = async (): Promise<readonly string[]> => {
  const [analystIds, engineerIds] = await Promise.all([
    fetchGroupMemberIds(okta, analystsGroupId),
    fetchGroupMemberIds(okta, engineersGroupId),
  ]);
  return [
    ...(analystIds.includes(demoUserId) ? ['lab_analysts'] : []),
    ...(engineerIds.includes(demoUserId) ? ['lab_engineers'] : []),
  ];
};

const attemptDemoUserConnection = async (): Promise<boolean> => {
  const baseConfig = tidbConfigFromEnv(env);
  try {
    const connection = await createConnection({ ...baseConfig, user: demoUsername, password: demoPassword });
    await connection.query('SELECT 1');
    await connection.end();
    return true;
  } catch {
    return false;
  }
};

const reconcile = async (): Promise<void> => {
  const groupNames = await currentGroupNames();
  const desiredRole = roleForGroups(groupNames);
  const actual = await readActualAssignments(pool, [demoUsername]);
  const drift = findDrift([{ username: demoUsername, role: desiredRole }], actual);
  emitter.metric('grant-drift-count', drift.length);
  emitter.check('grants-match-desired', drift.length === 0 ? 'pass' : 'fail', JSON.stringify(drift));
  emitter.check('no-orphan-users', drift.some((entry) => entry.kind === 'orphan_user') ? 'fail' : 'pass');
  if (drift.length === 0 && desiredRole === null && currentPhase === 'revoke') {
    setPhase('reconcile');
  }
};

const applyGroupChange = async (event: OktaLogEvent): Promise<void> => {
  const groupNames = await currentGroupNames();
  const role = roleForGroups(groupNames);
  if (role === null) return;
  const previousRole = lastKnownRole;
  await ensureRoles(pool, schema);
  await provisionUser(pool, demoUsername, demoPassword, role);
  lastKnownRole = role;
  emitter.metric('provision-latency-ms', msSincePublished(event.published, Date.now()));
  emitter.node('sync', 'healthy', `applied ${role} for ${demoUsername}`);
  emitter.node('tidb', 'healthy', `granted ${role}`);
  emitter.flow('sync-to-tidb', 1);
  setPhase(previousRole === null ? 'provision' : 'rescope');
};

const applyRevoke = async (event: OktaLogEvent): Promise<void> => {
  if (lastKnownRole === null) return;
  await lockAndDropUser(pool, demoUsername);
  lastKnownRole = null;
  emitter.metric('revoke-latency-ms', msSincePublished(event.published, Date.now()));
  emitter.node('sync', 'healthy', `revoked access for ${demoUsername}`);
  emitter.flow('sync-to-tidb', 1);
  const connected = await attemptDemoUserConnection();
  emitter.flow('app-to-tidb', 1);
  emitter.node('app', connected ? 'healthy' : 'degraded', connected ? 'query succeeded' : 'query rejected');
  emitter.check('revoked-user-rejected', connected ? 'fail' : 'pass');
  emitter.log('warn', 'demo user access revoked', 'tidb');
  setPhase('revoke');
};

const poll = async (): Promise<void> => {
  const fetched = await fetchGroupEventsSince(okta, sinceIso);
  const events = selectNewEvents(fetched, seenEventUuids);
  if (events.length > 0) {
    emitter.flow('okta-to-sync', events.length);
  }
  for (const event of events) {
    seenEventUuids.add(event.uuid);
    processedEvents += 1;
    emitter.metric('audit-events-processed', processedEvents);
    sinceIso = event.published;
    if (!targetsInclude(event, demoUserId)) continue;
    if (event.eventType === 'group.user_membership.add') {
      await applyGroupChange(event);
    }
    if (event.eventType === 'group.user_membership.remove') {
      const groupNames = await currentGroupNames();
      if (roleForGroups(groupNames) === null) {
        await applyRevoke(event);
      }
    }
    if (event.eventType === 'user.lifecycle.deactivate') {
      await applyRevoke(event);
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
emitter.node('okta', 'healthy', 'polling system log');
emitter.node('sync', 'idle');
emitter.node('tidb', 'healthy');
emitter.node('app', 'idle');
emitter.log('info', 'sync loop starting');
await ensureRoles(pool, schema);

await every({
  intervalMs: pollIntervalMs,
  task: poll,
  signal: abortController.signal,
});
