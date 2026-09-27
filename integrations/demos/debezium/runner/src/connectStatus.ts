export type ConnectorStatus = {
  readonly connector: { readonly state: string };
  readonly tasks: readonly { readonly id: number; readonly state: string }[];
};

export const summarizeConnectorStatus = (status: ConnectorStatus): number =>
  status.tasks.length > 0 && status.tasks.every((task) => task.state === 'RUNNING') ? 1 : 0;
