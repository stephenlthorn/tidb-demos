import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { aManifest } from '@lab/contract/testing';
import { FlowDiagram } from '../src/diagram/FlowDiagram';
import { foldEvents } from '../src/state/demo-state';

describe('FlowDiagram', () => {
  it('renders every node with its live status and the edge rate', () => {
    const manifest = aManifest();
    const state = foldEvents(manifest, [
      { type: 'node', t: 0, node: 'tidb', status: 'degraded', note: 'one store down' },
      { type: 'flow', t: 1000, edge: 'source-to-tidb', count: 10 },
    ]);
    const { container } = render(<FlowDiagram manifest={manifest} state={state} />);
    expect(screen.getByText('Source')).toBeTruthy();
    expect(screen.getByText('one store down')).toBeTruthy();
    expect(container.querySelector('[data-node="tidb"]')?.getAttribute('data-status')).toBe('degraded');
    expect(screen.getByText('rows: 10/s')).toBeTruthy();
    expect(container.querySelectorAll('circle.particle').length).toBeGreaterThan(0);
  });
});
