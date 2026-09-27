import { useEffect, useState } from 'react';
import type { CatalogEntry } from '@lab/contract';
import { demoHref } from '../route';

type Loaded = { readonly entries: readonly CatalogEntry[] } | { readonly error: string } | undefined;

export const CatalogPage = ({ load }: { readonly load: () => Promise<readonly CatalogEntry[]> }) => {
  const [loaded, setLoaded] = useState<Loaded>(undefined);
  useEffect(() => {
    load().then(
      (entries) => setLoaded({ entries }),
      (error: unknown) => setLoaded({ error: error instanceof Error ? error.message : String(error) }),
    );
  }, [load]);
  if (loaded === undefined) return <p className="status">Loading demos...</p>;
  if ('error' in loaded) return <p className="status error">{`Could not load demos: ${loaded.error}`}</p>;
  return (
    <div className="catalog">
      <header>
        <h1>TiDB Integration Lab</h1>
        <p>TiDB working with the tools you already run. Every number is measured on a real run and labeled with where it was recorded.</p>
      </header>
      <ul className="cards">
        {loaded.entries.map((entry) => (
          <li key={entry.id}>
            <a href={demoHref(entry.id)} className="card">
              <span className="card-number">{String(entry.number).padStart(2, '0')}</span>
              <h2>{entry.title}</h2>
              <p>{entry.tagline}</p>
              <ul className="chips">{entry.integrations.map((name) => <li key={name}>{name}</li>)}</ul>
              <span className="card-status">{entry.hasReplay ? 'Replay ready' : 'Recording coming soon'}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
};
