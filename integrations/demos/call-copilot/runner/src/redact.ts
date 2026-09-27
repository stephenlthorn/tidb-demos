const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_PATTERN = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

export const redactPII = (text: string): string =>
  text.replace(EMAIL_PATTERN, '[redacted-email]').replace(PHONE_PATTERN, '[redacted-phone]');
