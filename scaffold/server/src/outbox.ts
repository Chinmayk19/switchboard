import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { duplicateKey, finishSend, replies, sendGates, workspaces } from './inbox.ts';
import { logFailure } from './http.ts';
import { canSend } from './billing.ts';

const leaseMs = 10_000;
const requestTimeoutMs = 1_500;
const spacingMs = 275;

function retryAfterMs(value: string | null) {
  if (!value) return 2000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - Date.now()) : 2000;
}

async function runSend(workspace: string, owner: string) {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const due = { workspace, status: 'queued' as const, nextAttemptAt: { $lte: now } };
  if (!await replies.findOne(due, { projection: { _id: 1 } }) || !await canSend(workspace)) return;
  try {
    await sendGates.updateOne(
      { _id: workspace, availableAt: { $lte: now } },
      { $set: { owner, availableAt: leaseUntil } },
      { upsert: true },
    );
  } catch (error) {
    if (duplicateKey(error)) return;
    throw error;
  }

  let delay = 0;
  try {
    const reply = await replies.findOneAndUpdate(
      due,
      { $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1, _id: 1 }, returnDocument: 'after' },
    );
    if (!reply || !await canSend(workspace) || Date.now() + requestTimeoutMs >= leaseUntil.getTime()) return;

    delay = spacingMs;
    const backoff = Math.min(8_000, 500 * 2 ** Math.min(reply.attempts - 1, 4));
    const pending = { _id: reply._id, status: 'queued' as const, attempts: reply.attempts };
    let providerId: string | undefined;
    let permanentFailure = false;
    try {
      const response = await fetch(new URL('/v1/messages', config.pigeon.url), {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: 'Bearer ' + config.pigeon.apiKeys[workspace],
          'content-type': 'application/json',
          'idempotency-key': reply._id.toHexString(),
        },
        body: JSON.stringify({ to: reply.contact, text: reply.text, client_ref: reply.clientRef }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.ok) {
        const body = await response.json();
        if (typeof body.id === 'string' && body.id) providerId = body.id;
      } else {
        if (response.status === 429) {
          delay = Math.max(delay, retryAfterMs(response.headers.get('retry-after')) + 50);
          // Preserve a cooldown longer than the lease even if the worker dies
          // before rescheduling this reply.
          await sendGates.updateOne(
            { _id: workspace, owner },
            { $max: { availableAt: new Date(Date.now() + delay) } },
          );
        }
        permanentFailure = response.status >= 400 && response.status < 500 &&
          ![408, 425, 429].includes(response.status);
        await response.body?.cancel();
      }
    } catch {
      // A timeout may follow acceptance. Every retry uses the same stored key.
    }

    if (providerId || permanentFailure) {
      await finishSend(reply, providerId);
    } else {
      await replies.updateOne(pending, {
        $set: { nextAttemptAt: new Date(Date.now() + Math.max(delay, backoff)) },
      });
    }
  } finally {
    await sendGates.updateOne(
      { _id: workspace, owner },
      { $set: { availableAt: new Date(Date.now() + delay) }, $unset: { owner: '' } },
    );
  }
}

export function startOutbox() {
  for (const workspace of workspaces) {
    const poll = async () => {
      try {
        await runSend(workspace, randomUUID());
      } catch (error) {
        logFailure('Outbox worker failed for ' + workspace, error);
      } finally {
        setTimeout(poll, 75).unref();
      }
    };
    void poll();
  }
}
