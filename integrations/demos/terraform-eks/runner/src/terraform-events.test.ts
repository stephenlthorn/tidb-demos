import { describe, expect, it } from 'vitest';
import { parseTerraformLine } from './terraform-events';

const applyStartLine =
  '{"@level":"info","@message":"tidbcloud_dedicated_cluster.this: Creating...","@module":"terraform.ui","@timestamp":"2026-09-20T13:32:41.825308-04:00","hook":{"resource":{"addr":"tidbcloud_dedicated_cluster.this","module":"","resource":"tidbcloud_dedicated_cluster.this","implied_provider":"tidbcloud","resource_type":"tidbcloud_dedicated_cluster","resource_name":"this","resource_key":null},"action":"create"},"type":"apply_start"}';

const applyCompleteLine =
  '{"@level":"info","@message":"tidbcloud_dedicated_cluster.this: Creation complete after 620s [id=cluster-abc]","@module":"terraform.ui","@timestamp":"2026-09-20T13:43:01.826179-04:00","hook":{"resource":{"addr":"tidbcloud_dedicated_cluster.this","module":"","resource":"tidbcloud_dedicated_cluster.this","implied_provider":"tidbcloud","resource_type":"tidbcloud_dedicated_cluster","resource_name":"this","resource_key":null},"action":"create","id_key":"id","id_value":"cluster-abc","elapsed_seconds":620},"type":"apply_complete"}';

const changeSummaryLine =
  '{"@level":"info","@message":"Apply complete! Resources: 7 added, 0 changed, 0 destroyed.","@module":"terraform.ui","@timestamp":"2026-09-20T13:43:01.869168-04:00","changes":{"add":7,"change":0,"remove":0,"operation":"apply"},"type":"change_summary"}';

const notJsonLine = 'Initializing the backend...';

describe('parseTerraformLine', () => {
  it('parses an apply_start message into a resource-starting event', () => {
    const parsed = parseTerraformLine(applyStartLine);
    expect(parsed).toEqual({
      type: 'resource-starting',
      resourceAddr: 'tidbcloud_dedicated_cluster.this',
      resourceType: 'tidbcloud_dedicated_cluster',
      action: 'create',
    });
  });

  it('parses an apply_complete message into a resource-done event with elapsed seconds', () => {
    const parsed = parseTerraformLine(applyCompleteLine);
    expect(parsed).toEqual({
      type: 'resource-done',
      resourceAddr: 'tidbcloud_dedicated_cluster.this',
      resourceType: 'tidbcloud_dedicated_cluster',
      action: 'create',
      elapsedSeconds: 620,
    });
  });

  it('parses a change_summary message into a summary event', () => {
    const parsed = parseTerraformLine(changeSummaryLine);
    expect(parsed).toEqual({
      type: 'summary',
      operation: 'apply',
      add: 7,
      change: 0,
      remove: 0,
    });
  });

  it('returns an unrecognized event for a non-JSON line instead of throwing', () => {
    const parsed = parseTerraformLine(notJsonLine);
    expect(parsed).toEqual({ type: 'unrecognized', raw: notJsonLine });
  });
});
