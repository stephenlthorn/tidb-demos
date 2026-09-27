import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCanalJsonMessage } from '../src/canalJsonParser';
import { computeCheckpointLagMs, computeCheckpointLagMsFromTso } from '../src/checkpointLag';

const canalJsonSample = readFileSync(new URL('../../test/fixtures/canal-json-sample.json', import.meta.url), 'utf-8').trim();
const changefeedSample = JSON.parse(
  readFileSync(new URL('../../test/fixtures/ticdc-changefeed-sample.json', import.meta.url), 'utf-8'),
) as { readonly state: string; readonly checkpoint_ts: number; readonly checkpoint_time: string };

describe('canal-json parser against a real TiCDC v8.5.8 message', () => {
  it('parses the real INSERT row event captured from tidb-changes', () => {
    const parsed = parseCanalJsonMessage(canalJsonSample);
    expect(parsed).toEqual({
      ok: true,
      table: 'payments',
      type: 'INSERT',
      commitTs: 469374060999737350n,
      row: {
        payment_id: 'payment-000001',
        account_id: 'acct-1',
        amount_cents: '500',
        currency: 'USD',
        produce_ts: '1790519947033',
      },
    });
  });

  it('reports a real TIDB_WATERMARK message as not a row event', () => {
    const watermark =
      '{"id":0,"database":"","table":"","pkNames":null,"isDdl":false,"type":"TIDB_WATERMARK",' +
      '"es":1790519926702,"ts":1790519928000,"sql":"","sqlType":null,"mysqlType":null,"data":null,' +
      '"old":null,"_tidb":{"watermarkTs":469374055665369095}}';
    expect(parseCanalJsonMessage(watermark)).toEqual({ ok: false, reason: 'not a row event' });
  });
});

describe('checkpoint lag against a real GET /api/v2/changefeeds/{id} response', () => {
  it('confirms the changefeed was observed running normally', () => {
    expect(changefeedSample.state).toBe('normal');
  });

  it('computes a non-negative lag from the real checkpoint_time string', () => {
    const lag = computeCheckpointLagMs({ nowMs: Date.now(), checkpointTime: changefeedSample.checkpoint_time });
    expect(lag).toBeGreaterThanOrEqual(0);
  });

  it('computes a non-negative lag from the real checkpoint_ts TSO, read as raw text so precision is not lost', () => {
    const raw = readFileSync(new URL('../../test/fixtures/ticdc-changefeed-sample.json', import.meta.url), 'utf-8');
    const found = /"checkpoint_ts"\s*:\s*(\d+)/.exec(raw);
    expect(found).not.toBeNull();
    const checkpointTso = found?.[1] ?? '0';
    expect(BigInt(checkpointTso)).not.toBe(BigInt(changefeedSample.checkpoint_ts));
    const lag = computeCheckpointLagMsFromTso({ nowMs: Date.now(), checkpointTso });
    expect(lag).toBeGreaterThanOrEqual(0);
  });
});
