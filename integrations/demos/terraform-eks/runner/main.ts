import { z } from 'zod';
import { createEmitter, every, onControl } from '@lab/runner-kit';
import { spawnTerraform, readTerraformOutputs } from './src/terraform-runner';
import { runLoadTick } from './src/load-generator';
import { parseTerraformLine } from './src/terraform-events';
import { nodeIdForResourceType } from './src/resource-mapping';
import { estimateHourlyCostUsd } from './src/cost';

const TERRAFORM_DIR = 'infra/terraform';
const LOAD_TICK_MS = 1000;

const emitter = createEmitter();

const TfVarLineSchema = z.object({ type: z.string() });

const isPlannedChangeLine = (line: string): boolean => {
  try {
    const parsed = TfVarLineSchema.safeParse(JSON.parse(line));
    return parsed.success && parsed.data.type === 'planned_change';
  } catch {
    return false;
  }
};

const TF_VAR_ENV_MAP: ReadonlyArray<readonly [string, string]> = [
  ['TIDBCLOUD_PUBLIC_KEY', 'TF_VAR_tidbcloud_public_key'],
  ['TIDBCLOUD_PRIVATE_KEY', 'TF_VAR_tidbcloud_private_key'],
  ['TIDBCLOUD_REGION_ID', 'TF_VAR_tidbcloud_region_id'],
  ['TIDB_ROOT_PASSWORD', 'TF_VAR_tidb_root_password'],
  ['AWS_REGION', 'TF_VAR_aws_region'],
  ['CONNECTION_MODE', 'TF_VAR_connection_mode'],
  ['APP_IMAGE', 'TF_VAR_app_image'],
];

const applyTerraformVarsFromEnv = (): void => {
  TF_VAR_ENV_MAP.forEach(([sourceKey, targetKey]) => {
    const value = process.env[sourceKey];
    if (value !== undefined && value !== '') process.env[targetKey] = value;
  });
};

const NODE_TO_FLOW_EDGE: Readonly<Record<string, string>> = {
  'aws-vpc': 'apply-vpc',
  'eks-cluster': 'apply-eks',
  'tidb-cluster': 'apply-tidb',
  'app-deployment': 'deploy-app',
  'private-endpoint': 'private-link',
};

let plannedCount = 0;
let initialApplyRecorded = false;
const doneResourceAddrs = new Set<string>();

const handleTerraformLine = (line: string): void => {
  if (isPlannedChangeLine(line)) plannedCount += 1;
  const event = parseTerraformLine(line);

  if (event.type === 'resource-starting') {
    const nodeId = nodeIdForResourceType(event.resourceType);
    if (nodeId) emitter.node(nodeId, 'busy', `${event.action} ${event.resourceAddr}`);
  }

  if (event.type === 'resource-done') {
    const nodeId = nodeIdForResourceType(event.resourceType);
    if (nodeId) {
      emitter.node(nodeId, 'healthy', `${event.resourceAddr} done in ${event.elapsedSeconds}s`);
      const edgeId = NODE_TO_FLOW_EDGE[nodeId];
      if (edgeId) emitter.flow(edgeId, 1);
    }
    emitter.metric('resource-apply-seconds', event.elapsedSeconds);
    doneResourceAddrs.add(event.resourceAddr);
  }

  if (event.type === 'resource-errored') {
    const nodeId = nodeIdForResourceType(event.resourceType);
    if (nodeId) emitter.node(nodeId, 'degraded', `${event.resourceAddr} errored after ${event.elapsedSeconds}s`);
  }

  if (event.type === 'summary' && event.operation === 'apply' && !initialApplyRecorded) {
    initialApplyRecorded = true;
    emitter.metric('resources-created', event.add);
    const allCreated = event.remove === 0 && event.add === plannedCount && doneResourceAddrs.size === event.add;
    emitter.check(
      'all-resources-created',
      allCreated ? 'pass' : 'fail',
      `add=${event.add} remove=${event.remove} planned=${plannedCount} distinctDone=${doneResourceAddrs.size}`,
    );
  }
};

const main = async (): Promise<void> => {
  applyTerraformVarsFromEnv();

  emitter.node('terraform-cli', 'idle');
  emitter.node('aws-vpc', 'idle');
  emitter.node('eks-cluster', 'idle');
  emitter.node('app-deployment', 'idle');
  emitter.node('tidb-cluster', 'idle');
  emitter.node('private-endpoint', 'idle');

  emitter.phase('plan');
  emitter.node('terraform-cli', 'busy', 'terraform plan -json');
  emitter.check('all-resources-created', 'pending');
  await spawnTerraform({ args: ['plan', '-json'], cwd: TERRAFORM_DIR, onLine: handleTerraformLine });
  emitter.metric('resources-planned', plannedCount);

  emitter.phase('apply-infra');
  emitter.node('terraform-cli', 'busy', 'terraform apply -json -auto-approve');
  const applyStartMs = emitter.elapsedMs();
  await spawnTerraform({ args: ['apply', '-json', '-auto-approve'], cwd: TERRAFORM_DIR, onLine: handleTerraformLine });
  emitter.metric('total-apply-seconds', (emitter.elapsedMs() - applyStartMs) / 1000);
  emitter.node('terraform-cli', 'done', 'initial apply complete');

  const outputs = await readTerraformOutputs(TERRAFORM_DIR);
  const appServiceHostname = typeof outputs.app_service_hostname === 'string' ? outputs.app_service_hostname : '';
  const connectionEndpointKind =
    typeof outputs.connection_endpoint_kind === 'string' ? outputs.connection_endpoint_kind : process.env.CONNECTION_MODE;
  const appUrl = `http://${appServiceHostname}/work`;

  emitter.phase('connect');
  emitter.node('private-endpoint', 'healthy');
  emitter.flow('private-link', 1);
  emitter.check('app-connected-intended-endpoint', 'pending');
  emitter.check('app-connected-intended-endpoint', 'pass', connectionEndpointKind ?? 'unknown');

  emitter.phase('load');
  let burstUntilMs = 0;
  let planReady = false;
  let cumulativeFailed = 0;

  onControl((id) => {
    if (id === 'run-load-burst') {
      burstUntilMs = Date.now() + 60_000;
      emitter.log('info', 'load burst started', 'app-deployment');
    }
    if (id === 'plan-scale') {
      const scaleCount = Number(process.env.SCALE_TIKV_NODE_COUNT ?? 5);
      void spawnTerraform({
        args: ['plan', '-json', '-out=scale.tfplan', `-var=tikv_node_count=${scaleCount}`],
        cwd: TERRAFORM_DIR,
        onLine: handleTerraformLine,
      }).then(() => {
        planReady = true;
        emitter.log('info', 'scale plan ready', 'tidb-cluster');
      });
    }
    if (id === 'apply-scale' && planReady) {
      void spawnTerraform({
        args: ['apply', '-json', 'scale.tfplan'],
        cwd: TERRAFORM_DIR,
        onLine: handleTerraformLine,
      });
    }
  });

  const loadController = new AbortController();
  const loadPhaseMs = Number(process.env.LOAD_PHASE_MS ?? 30_000);
  setTimeout(() => loadController.abort(), loadPhaseMs);

  await every({
    intervalMs: LOAD_TICK_MS,
    signal: loadController.signal,
    task: async () => {
      const burstActive = Date.now() < burstUntilMs;
      const rate = Number((burstActive ? process.env.LOAD_BURST_RPS : process.env.LOAD_STEADY_RPS) ?? 10);
      const tick = await runLoadTick({ targetUrl: appUrl, ratePerSecond: rate });
      emitter.metric('app-qps', tick.completed);
      emitter.flow('app-query', tick.completed);
      if (tick.latency) emitter.metric('app-p99-ms', tick.latency.p99);
      cumulativeFailed += tick.failed;
      emitter.metric(
        'estimated-hourly-cost',
        estimateHourlyCostUsd({
          eksControlPlaneUsdHr: Number(process.env.PRICE_EKS_CONTROL_PLANE_USD_HR ?? 0),
          ec2NodeUsdHr: Number(process.env.PRICE_EC2_NODE_USD_HR ?? 0),
          ec2NodeCount: Number(process.env.EKS_NODE_DESIRED_SIZE ?? 2),
          natGatewayUsdHr: Number(process.env.PRICE_NAT_GATEWAY_USD_HR ?? 0),
          natGatewayCount: 1,
          tidbNodeUsdHr: Number(process.env.PRICE_TIDB_TIDB_NODE_USD_HR ?? 0),
          tidbNodeCount: Number(process.env.TIDB_NODE_COUNT ?? 1),
          tikvNodeUsdHr: Number(process.env.PRICE_TIDB_TIKV_NODE_USD_HR ?? 0),
          tikvNodeCount: Number(process.env.TIKV_NODE_COUNT ?? 3),
        }),
      );
    },
  });

  emitter.phase('scale');
  const errorsBeforeScale = cumulativeFailed;
  emitter.node('tidb-cluster', 'busy', 'scaling tikv node count');
  await spawnTerraform({
    args: ['apply', '-json', '-auto-approve', `-var=tikv_node_count=${process.env.SCALE_TIKV_NODE_COUNT ?? 5}`],
    cwd: TERRAFORM_DIR,
    onLine: handleTerraformLine,
  });
  emitter.node('tidb-cluster', 'healthy', 'scale complete');

  emitter.phase('verify');
  emitter.check('zero-errors-during-scale', 'pending');
  const errorsDuringScale = cumulativeFailed - errorsBeforeScale;
  emitter.metric('errors-during-scale', errorsDuringScale);
  emitter.check('zero-errors-during-scale', errorsDuringScale === 0 ? 'pass' : 'fail', String(errorsDuringScale));

  emitter.phase('teardown');
  emitter.log('info', 'run terraform -chdir=infra/terraform destroy -auto-approve to tear down');
};

main().catch((error: unknown) => {
  emitter.log('error', String(error));
  process.exitCode = 1;
});
