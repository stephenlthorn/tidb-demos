import { describe, expect, it } from 'vitest';
import { emptyState, withBranch, withLayer, withMount } from '../src/state';
import { buildTeardownPlan } from '../src/teardownPlan';

const state = withBranch(
  withMount(withLayer(withLayer(emptyState('run-1'), 'lyr_task'), 'lyr_a1'), '/tmp/work/attempt-1'),
  { clusterId: 'fix', branchId: 'br_1' },
);

const base = {
  state,
  fixtureClusterId: 'fix',
  fixtureBranchIds: ['br_1', 'br_2'],
  orgClusterId: 'org',
  fileSystemId: 'fs-1',
  bucket: 'lab-bucket',
  prefix: '/agent-coding/',
  destroyInstances: false,
};

describe('buildTeardownPlan', () => {
  it('unmounts, deletes every fixture branch once, cascades the task layer and empties the prefix', () => {
    expect(buildTeardownPlan(base).map((step) => step.label)).toEqual([
      'unmount /tmp/work/attempt-1',
      'delete branch br_1',
      'delete branch br_2',
      'delete layer lyr_task and every layer forked from it',
      'empty s3://lab-bucket/agent-coding',
    ]);
  });

  it('uses the documented commands', () => {
    const steps = buildTeardownPlan(base);
    expect(steps[0]).toEqual({
      label: 'unmount /tmp/work/attempt-1',
      bin: 'ti',
      args: ['fs', 'unmount-file-system', '--mount-path', '/tmp/work/attempt-1', '--ignore-absent'],
    });
    expect(steps[3]?.args).toEqual(['fs', 'delete-layer', '--layer-ref', 'lyr_task', '--cascade']);
    expect(steps[4]?.args).toEqual(['s3', 'rm', 's3://lab-bucket/agent-coding', '--recursive']);
  });

  it('adds the file system and both instances only when asked', () => {
    const steps = buildTeardownPlan({ ...base, destroyInstances: true });
    expect(steps.slice(-3).map((step) => step.args)).toEqual([
      ['fs', 'delete-file-system', '--file-system-id', 'fs-1'],
      ['db', 'delete-db-cluster', '--db-cluster-id', 'fix', '--wait'],
      ['db', 'delete-db-cluster', '--db-cluster-id', 'org', '--wait'],
    ]);
  });

  it('skips the layer step when no layer was recorded', () => {
    const steps = buildTeardownPlan({ ...base, state: emptyState('run-1'), fixtureBranchIds: [] });
    expect(steps.map((step) => step.label)).toEqual(['empty s3://lab-bucket/agent-coding']);
  });
});
