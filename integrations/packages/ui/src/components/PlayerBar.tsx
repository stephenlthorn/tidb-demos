import { formatClock } from '../format';
import { SPEEDS, type PlayerState } from '../sources/player';

export type Marker = { readonly t: number; readonly label: string };

export const PlayerBar = (props: {
  readonly player: PlayerState;
  readonly markers: readonly Marker[];
  readonly onToggle: () => void;
  readonly onSeek: (ms: number) => void;
  readonly onSpeed: (speed: number) => void;
}) => (
  <div className="player" role="group" aria-label="Replay controls">
    <button type="button" onClick={props.onToggle}>{props.player.playing ? 'Pause' : 'Play'}</button>
    <div className="scrub">
      <input
        type="range"
        aria-label="Position"
        min={0}
        max={props.player.durationMs}
        step={100}
        value={props.player.positionMs}
        onChange={(event) => props.onSeek(Number(event.currentTarget.value))}
      />
      <div className="markers" aria-hidden="true">
        {props.markers.map((marker) => (
          <span key={`${marker.t}-${marker.label}`} title={marker.label} style={{ left: `${(marker.t / Math.max(props.player.durationMs, 1)) * 100}%` }} />
        ))}
      </div>
    </div>
    <span className="clock">{`${formatClock(props.player.positionMs)} / ${formatClock(props.player.durationMs)}`}</span>
    {SPEEDS.map((speed) => (
      <button key={speed} type="button" aria-pressed={props.player.speed === speed} onClick={() => props.onSpeed(speed)}>{`${speed}x`}</button>
    ))}
  </div>
);
