export type RoutingEngine = 'tikv' | 'tiflash';

export const isolationEnginesFor = (engine: RoutingEngine): readonly string[] => {
  if (engine === 'tikv') return ['tikv'];
  return ['tiflash'];
};

export const setIsolationEnginesStatement = (engine: RoutingEngine): string =>
  `SET SESSION tidb_isolation_read_engines = '${isolationEnginesFor(engine).join(',')}'`;
