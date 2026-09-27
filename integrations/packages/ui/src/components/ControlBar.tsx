import type { ManifestControl } from '@lab/contract';

export const ControlBar = (props: {
  readonly controls: readonly ManifestControl[];
  readonly enabled: boolean;
  readonly onControl: (id: string) => void;
}) => (
  <div className="controls" role="group" aria-label="Live controls">
    {props.controls.map((control) => (
      <button key={control.id} type="button" disabled={!props.enabled} title={control.description} onClick={() => props.onControl(control.id)}>
        {control.label}
      </button>
    ))}
  </div>
);
