import type { RunState } from './state';

export type TeardownStep = {
  readonly label: string;
  readonly bin: string;
  readonly args: readonly string[];
};

export const buildTeardownPlan = (options: {
  readonly state: RunState;
  readonly fixtureClusterId: string;
  readonly fixtureBranchIds: readonly string[];
  readonly orgClusterId: string;
  readonly fileSystemId: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly destroyInstances: boolean;
}): readonly TeardownStep[] => {
  const prefix = options.prefix.replace(/^\/+|\/+$/g, '');
  const branchIds = [...new Set([...options.fixtureBranchIds, ...options.state.branches.map((branch) => branch.branchId)])];
  const taskLayer = options.state.layers[0];
  const cleanup: readonly TeardownStep[] = [
    ...options.state.mounts.map((mountPath) => ({
      label: `unmount ${mountPath}`,
      bin: 'ti',
      args: ['fs', 'unmount-file-system', '--mount-path', mountPath, '--ignore-absent'],
    })),
    ...branchIds.map((branchId) => ({
      label: `delete branch ${branchId}`,
      bin: 'ticloud',
      args: [
        'serverless',
        'branch',
        'delete',
        '--cluster-id',
        options.fixtureClusterId,
        '--branch-id',
        branchId,
        '--force',
        '--no-color',
      ],
    })),
    ...(taskLayer === undefined
      ? []
      : [
          {
            label: `delete layer ${taskLayer} and every layer forked from it`,
            bin: 'ti',
            args: ['fs', 'delete-layer', '--layer-ref', taskLayer, '--cascade'],
          },
        ]),
    {
      label: `empty s3://${options.bucket}/${prefix}`,
      bin: 'aws',
      args: ['s3', 'rm', `s3://${options.bucket}/${prefix}`, '--recursive'],
    },
  ];
  if (!options.destroyInstances) return cleanup;
  return [
    ...cleanup,
    {
      label: `delete file system ${options.fileSystemId}`,
      bin: 'ti',
      args: ['fs', 'delete-file-system', '--file-system-id', options.fileSystemId],
    },
    ...[options.fixtureClusterId, options.orgClusterId].map((clusterId) => ({
      label: `delete Starter instance ${clusterId}`,
      bin: 'ti',
      args: ['db', 'delete-db-cluster', '--db-cluster-id', clusterId, '--wait'],
    })),
  ];
};
