import { describe, expect, it } from 'vitest';
import { isPortForwardReady } from './port-forward';

describe('isPortForwardReady', () => {
  it('recognizes kubectl port-forward readiness output', () => {
    expect(isPortForwardReady('Forwarding from 127.0.0.1:8080 -> 8080')).toBe(true);
  });

  it('recognizes readiness output for the IPv6 loopback line kubectl also prints', () => {
    expect(isPortForwardReady('Forwarding from [::1]:8080 -> 8080')).toBe(true);
  });

  it('does not treat an unrelated log line as ready', () => {
    expect(isPortForwardReady('Handling connection for 8080')).toBe(false);
  });

  it('does not treat an error line as ready', () => {
    expect(isPortForwardReady('error: unable to forward port because pod is not running')).toBe(false);
  });
});
