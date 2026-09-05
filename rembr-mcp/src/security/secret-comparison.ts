import { createHash, timingSafeEqual } from 'node:crypto';

/** Compare secrets in constant time without leaking their original lengths. */
export function constantTimeSecretEqual(expected: string, supplied: string): boolean {
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const suppliedDigest = createHash('sha256').update(supplied, 'utf8').digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

/** Return a header only when Express parsed exactly one string value. */
export function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
