import { CatalogSchema, DemoManifestSchema, TraceSchema, type CatalogEntry, type DemoManifest, type Trace } from '@lab/contract';

const fetchJson = async (url: string, signal?: AbortSignal): Promise<unknown> => {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};

export const fetchCatalog = async (): Promise<readonly CatalogEntry[]> => CatalogSchema.parse(await fetchJson('data/catalog.json'));

export const fetchTrace = async (id: string): Promise<Trace> => TraceSchema.parse(await fetchJson(`data/traces/${id}.json`));

export const fetchRelayManifest = async (relayUrl: string, signal: AbortSignal): Promise<DemoManifest> =>
  DemoManifestSchema.parse(await fetchJson(`${relayUrl}/manifest`, signal));
