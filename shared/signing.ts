// HMAC signing for app -> orchestrator webhooks.
// Signature = hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`)), sent as `sha256=<hex>`.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-stall-signature';
export const TIMESTAMP_HEADER = 'x-stall-timestamp';
export const EVENT_HEADER = 'x-stall-event';
export const DELIVERY_HEADER = 'x-stall-delivery';

export function sign(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verify(
  secret: string,
  timestamp: string | undefined,
  body: string,
  signature: string | undefined,
  toleranceSec = 300,
  now = Date.now(),
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const expected = Buffer.from(sign(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
