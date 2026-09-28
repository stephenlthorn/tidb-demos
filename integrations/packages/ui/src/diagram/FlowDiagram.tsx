import type { DemoManifest, ManifestEdge, ManifestNode, NodeStatus } from '@lab/contract';
import { formatRate } from '../format';
import type { DemoState } from '../state/demo-state';
import { edgeRate } from '../state/selectors';
import { CANVAS, NODE_SIZE, edgeCurve, laneBends, particleSpec, toCanvas, type Point } from './geometry';

const FlowEdge = ({ edge, from, to, bend, rate }: { readonly edge: ManifestEdge; readonly from: Point; readonly to: Point; readonly bend: number; readonly rate: number }) => {
  const { d, mid } = edgeCurve(from, to, bend);
  const spec = particleSpec(rate);
  return (
    <g className="edge" data-edge={edge.id}>
      <path d={d} className="edge-line" />
      {Array.from({ length: spec.count }, (_, index) => (
        <circle key={index} r={4} className="particle">
          <animateMotion dur={`${spec.durationS}s`} begin={`${(index * spec.durationS) / spec.count}s`} repeatCount="indefinite" path={d} />
        </circle>
      ))}
      <text x={mid.x} y={mid.y - 12} className="edge-label" textAnchor="middle">{`${edge.label}: ${formatRate(rate)}/s`}</text>
    </g>
  );
};

const FlowNode = ({ node, at, status, note }: { readonly node: ManifestNode; readonly at: Point; readonly status: NodeStatus; readonly note: string | undefined }) => (
  <g className="node" data-node={node.id} data-status={status} data-kind={node.kind} transform={`translate(${at.x - NODE_SIZE.width / 2} ${at.y - NODE_SIZE.height / 2})`}>
    <rect width={NODE_SIZE.width} height={NODE_SIZE.height} rx={12} />
    <circle className="status-dot" cx={16} cy={18} r={6} />
    <text x={30} y={23} className="node-kind">{node.kind}</text>
    <text x={16} y={46} className="node-label">{node.label}</text>
    {note === undefined ? null : <text x={NODE_SIZE.width / 2} y={NODE_SIZE.height + 18} className="node-note" textAnchor="middle">{note}</text>}
  </g>
);

export const FlowDiagram = ({ manifest, state }: { readonly manifest: DemoManifest; readonly state: DemoState }) => {
  const positions = new Map(manifest.nodes.map((node) => [node.id, toCanvas(node)]));
  const bends = laneBends(manifest.edges);
  return (
    <svg className="flow" viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`} role="img" aria-label={`${manifest.title} data flow`}>
      {manifest.edges.map((edge) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (from === undefined || to === undefined) return null;
        return <FlowEdge key={edge.id} edge={edge} from={from} to={to} bend={bends.get(edge.id) ?? 0} rate={edgeRate(state, edge.id)} />;
      })}
      {manifest.nodes.map((node) => (
        <FlowNode key={node.id} node={node} at={positions.get(node.id) ?? toCanvas(node)} status={state.nodes[node.id] ?? 'idle'} note={state.nodeNotes[node.id]} />
      ))}
    </svg>
  );
};
