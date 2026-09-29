import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CatalogMedia } from '@lab/contract';
import { MediaGallery } from '../src/components/MediaGallery';

const media: CatalogMedia = {
  videos: [{ src: 'data/media/okta/okta-live.mp4', title: 'Live side by side' }],
  screenshots: [
    { src: 'data/media/okta/screenshots/01-start.jpg', caption: 'Start', group: 'console' },
    { src: 'data/media/okta/replay/02-phase-warmup.jpg', caption: 'Phase: warmup', group: 'replay' },
  ],
};

describe('MediaGallery', () => {
  it('renders nothing when there is no media', () => {
    const { container } = render(<MediaGallery media={undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when media has no videos or screenshots', () => {
    const { container } = render(<MediaGallery media={{ videos: [], screenshots: [] }} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the section, videos, and grouped screenshots', () => {
    render(<MediaGallery media={media} />);
    expect(screen.getByText('Proof from the live run')).toBeTruthy();
    expect(screen.getByText('Live side by side')).toBeTruthy();
    expect(screen.getByText('Real vendor console')).toBeTruthy();
    expect(screen.getByText('Replay at each phase')).toBeTruthy();
    expect(screen.getAllByRole('img')).toHaveLength(2);
  });

  it('opens and closes the overlay on click and on Escape', () => {
    render(<MediaGallery media={media} />);
    fireEvent.click(screen.getByAltText('Start'));
    const dialog = screen.getByRole('dialog', { name: 'Start' });
    expect(dialog).toBeTruthy();
    expect(screen.getByLabelText('Close')).toBe(document.activeElement);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByAltText('Phase: warmup'));
    expect(screen.getByRole('dialog', { name: 'Phase: warmup' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
