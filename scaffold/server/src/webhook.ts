import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { config } from './config.ts';
import { knownWorkspace, recordStatus, storeInbound } from './inbox.ts';

export function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export async function receiveWebhook(req: IncomingMessage, signature: string | undefined, eventId: string | undefined) {
  const body = await readSignedBody(req, signature, config.pigeon.webhookSecret);
  return typeof body === 'number' ? body : applyWebhook(body, eventId);
}

export async function readSignedBody(req: IncomingMessage, signature: string | undefined, secret: string) {
  const match = /^t=(\d+),v1=([a-f\d]{64})$/i.exec(signature ?? '');
  if (!match) return 401;

  const [, timestamp, signatureHex] = match;
  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (Math.abs(age) > 300) return 401;

  const hmac = createHmac('sha256', secret).update(timestamp + '.');
  const limit = 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    hmac.update(chunk);
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  if (!timingSafeEqual(hmac.digest(), Buffer.from(signatureHex, 'hex'))) return 401;
  if (size > limit) return 413;
  return Buffer.concat(chunks);
}

export async function applyWebhook(raw: Buffer, eventId: string | undefined) {
  let event;
  try {
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
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
    if (!['sent', 'delivered', 'failed'].includes(status)) return 400;
    if (!nonempty(client_ref)) return 204;
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
