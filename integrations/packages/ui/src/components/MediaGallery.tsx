import { useEffect, useRef, useState } from 'react';
import type { CatalogMedia, MediaGroup, MediaScreenshot } from '@lab/contract';

type Lightbox = { readonly src: string; readonly caption: string };

const GROUP_LABELS: Record<MediaGroup, string> = {
  console: 'Real vendor console',
  replay: 'Replay at each phase',
};

const GROUP_ORDER: readonly MediaGroup[] = ['console', 'replay'];

const groupScreenshots = (screenshots: readonly MediaScreenshot[]): readonly (readonly [MediaGroup, readonly MediaScreenshot[]])[] =>
  GROUP_ORDER.map((group) => [group, screenshots.filter((shot) => shot.group === group)] as const).filter(([, shots]) => shots.length > 0);

const MediaOverlay = ({ item, onClose }: { readonly item: Lightbox; readonly onClose: () => void }) => {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="media-overlay" role="dialog" aria-label={item.caption}>
      <div className="media-overlay-body">
        <button ref={closeRef} type="button" className="media-overlay-close" aria-label="Close" onClick={onClose}>
          Close
        </button>
        <img src={item.src} alt={item.caption} />
        <p>{item.caption}</p>
      </div>
    </div>
  );
};

export const MediaGallery = ({ media }: { readonly media: CatalogMedia | undefined }) => {
  const [open, setOpen] = useState<Lightbox | undefined>(undefined);

  if (media === undefined || (media.videos.length === 0 && media.screenshots.length === 0)) return null;

  return (
    <section className="media" aria-label="Proof from the live run">
      <h2>Proof from the live run</h2>
      {media.videos.length > 0 && (
        <div className="media-videos">
          {media.videos.map((video) => (
            <figure key={video.src} className="media-video">
              <video controls preload="metadata" src={video.src} />
              <figcaption>{video.title}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {groupScreenshots(media.screenshots).map(([group, shots]) => (
        <div key={group} className="media-group">
          <h3>{GROUP_LABELS[group]}</h3>
          <ul className="media-grid">
            {shots.map((shot) => (
              <li key={shot.src}>
                <button type="button" onClick={() => setOpen(shot)}>
                  <img src={shot.src} alt={shot.caption} loading="lazy" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {open !== undefined && <MediaOverlay item={open} onClose={() => setOpen(undefined)} />}
    </section>
  );
};
