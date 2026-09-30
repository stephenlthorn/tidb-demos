import { useEffect, useState } from 'react';
import type { CatalogEntry } from '@lab/contract';
import { demoHref } from '../route';

type Loaded = { readonly entries: readonly CatalogEntry[] } | { readonly error: string } | undefined;

const MediaBadges = ({ entry }: { readonly entry: CatalogEntry }) => {
  const videos = entry.media?.videos.length ?? 0;
  const screenshots = entry.media?.screenshots.length ?? 0;
  if (videos === 0 && screenshots === 0) return null;
  return (
    <ul className="badges">
      {videos > 0 && <li className="badge badge-video">Video</li>}
      {screenshots > 0 && <li className="badge">{`${screenshots} screenshots`}</li>}
    </ul>
  );
};

const StoryCard = ({ entry }: { readonly entry: CatalogEntry }) => (
  <a href={demoHref(entry.id)} className="story-card">
    <span className="card-tag">{entry.integrations.join(' · ')}</span>
    <h2>{entry.title}</h2>
    <p>{entry.tagline}</p>
    <div className="card-meta">
      <span className="pill" data-tone={entry.hasReplay ? 'fresh' : 'stale'}>
        <span aria-hidden="true">{entry.hasReplay ? '●' : '○'}</span>
        <span>{entry.hasReplay ? 'Replay ready' : 'Recording coming soon'}</span>
      </span>
      <MediaBadges entry={entry} />
    </div>
    {entry.hasReplay && <span className="card-go">Watch replay →</span>}
  </a>
);

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
    <main className="catalog">
      <header className="hero">
        <p className="eyebrow">Integration Lab</p>
        <h1>TiDB, working with the tools you already run.</h1>
        <p className="lead">
          Pick a demo to watch. Each one is a replay of a real run, and every number on screen was measured during that run and labeled with where it was recorded.
        </p>
      </header>
      <ul className="story-cards">
        {loaded.entries.map((entry) => (
          <li key={entry.id}>
            <StoryCard entry={entry} />
          </li>
        ))}
      </ul>
    </main>
  );
};
