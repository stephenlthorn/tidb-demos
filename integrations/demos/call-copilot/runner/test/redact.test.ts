import { describe, expect, it } from 'vitest';
import { redactPII } from '../src/redact';

describe('redactPII', () => {
  it('replaces email addresses with a placeholder', () => {
    const input = 'reach me at jane.doe@example.com after the call';
    expect(redactPII(input)).toBe('reach me at [redacted-email] after the call');
  });

  it('replaces phone numbers with a placeholder', () => {
    const input = 'call me at 415-555-0134 tomorrow';
    expect(redactPII(input)).toBe('call me at [redacted-phone] tomorrow');
  });

  it('leaves text with no PII unchanged', () => {
    const input = 'TiDB uses HTAP to serve both transactional and analytical queries';
    expect(redactPII(input)).toBe(input);
  });

  it('redacts multiple matches in the same string', () => {
    const input = 'email a@b.com or call 415-555-0134';
    expect(redactPII(input)).toBe('email [redacted-email] or call [redacted-phone]');
  });
});
