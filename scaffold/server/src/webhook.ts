import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { knownWorkspace, recordStatus, storeInbound } from './inbox.ts';

export function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validSignature(signature: string | undefined, raw: Buffer) {
  const match = /^t=(\d+),v1=([a-f\d]{64})$/i.exec(signature ?? '');
  if (!match) return false;

  const [, timestamp, signatureHex] = match;
  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (Math.abs(age) > 300) return false;

  const expected = createHmac('sha256', config.pigeon.webhookSecret)
    .update(timestamp + '.').update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signatureHex, 'hex'));
}

export async function applyWebhook(raw: Buffer, eventId: string | undefined) {
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return 400;
  }
  if (!event || !nonempty(event.type)) return 400;
  if (event.type !== 'message.inbound' && event.type !== 'message.status') return 204;
  if (!nonempty(event.workspace)) return 400;
  if (!knownWorkspace(event.workspace)) return 204;
  if (!nonempty(event.id) || eventId !== event.id || !event.data || !nonempty(event.data.message_id)) return 400;

  const { workspace, data } = event;
  if (event.type === 'message.status') {
    const { status, client_ref, message_id } = data;
    if (!nonempty(client_ref) || !['sent', 'delivered', 'failed'].includes(status)) return 400;
    await recordStatus(workspace, client_ref, message_id, status);
  } else {
    const occurredAt = new Date(typeof event.occurred_at === 'string' ? event.occurred_at : NaN);
    if (!Number.isFinite(occurredAt.getTime()) || !nonempty(data.from) || typeof data.text !== 'string') return 400;
    await storeInbound({
      workspace, contact: data.from, text: data.text, eventId: event.id,
      messageId: data.message_id, occurredAt,
    });
  }
  return 204;
}
