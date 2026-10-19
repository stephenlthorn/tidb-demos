import { Client } from 'tidbcloudlake-driver';
import { isReadStatement, zipRecord, type LakeClient, type LakeConfig } from './lake-config';

export const createLakeClient = (config: LakeConfig): LakeClient => ({
  query: async (sql) => {
    const connection = await new Client(config.dsn).getConn();
    try {
      if (!isReadStatement(sql)) {
        await connection.exec(sql);
        return [];
      }
      const iterator = await connection.queryIter(sql);
      const names = iterator.schema().fields().map((field) => field.name);
      const rows: Record<string, unknown>[] = [];
      for (let next = await iterator.next(); next !== null; next = await iterator.next()) {
        if (next instanceof Error) throw next;
        rows.push(zipRecord(names, next.values()));
      }
      return rows;
    } finally {
      connection.close();
    }
  },
});
