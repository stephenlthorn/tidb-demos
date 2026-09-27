export type FaultId = 'slow-query-storm' | 'write-hot-spot' | 'store-outage' | 'connection-surge';

export type ActiveFault = { readonly fault: FaultId; readonly injectedAtMs: number };

export type FaultState = { readonly active: ActiveFault | undefined };

export const createFaultState = (): FaultState => ({ active: undefined });

export const faultInjected = (
  _state: FaultState,
  { fault, atMs }: { readonly fault: FaultId; readonly atMs: number },
): FaultState => ({ active: { fault, injectedAtMs: atMs } });

export const faultsCleared = (_state: FaultState): FaultState => ({ active: undefined });
