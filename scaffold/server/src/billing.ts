import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoServerError } from 'mongodb';
import { config } from './config.ts';
import { getDb } from './db.ts';
import { logFailure } from './http.ts';

type Status = 'none' | 'incomplete' | 'active' | 'past_due' | 'canceled';
type Operation = { id: string; seats: number } & ({ kind: 'subscribe'; token: string } | { kind: 'seats' });
type BillingFields = { status: Status; seats: number; approvalUrl?: string; customer?: string; subscription?: string };
type Billing = BillingFields & {
  _id: string; generation: string; owner?: string; until?: Date; syncAt?: Date; pending?: Operation;
};
interface Subscription {
  id: string;
  customer: string;
  quantity: number;
  status: Exclude<Status, 'none'> | 'incomplete_expired';
  latest_invoice?: { payment?: { status: string; next_action?: { url?: string } } };
}

const accounts = getDb().collection<Billing>('billing_accounts');
const events = getDb().collection<{ _id: string; workspace: string; done: boolean; expiresAt: Date }>('billing_webhooks');
const price = 'price_seat_monthly';
const leaseMs = 15_000;
const refreshMs = 10_000;
const defaultFields: BillingFields = { status: 'none', seats: 0 };

export async function initBilling() {
  await Promise.all([
    accounts.createIndexes([
      { key: { customer: 1 }, sparse: true, unique: true },
      { key: { syncAt: 1 } },
    ]),
    events.createIndexes([
      { key: { done: 1, workspace: 1 } },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ]),
  ]);
}

export async function resetBilling() {
  await Promise.all([accounts.deleteMany({}), events.deleteMany({})]);
}

export async function billingView(workspace: string) {
  return summary(await accounts.findOne({ _id: workspace }) ?? defaultFields);
}

export async function billingSummaries() {
  const rows = await accounts.find().project<Pick<Billing, '_id' | 'status' | 'seats'>>({ status: 1, seats: 1 }).toArray();
  return new Map(rows.map(row => [row._id, { status: row.status, seats: row.seats, can_send: row.status !== 'canceled' }]));
}

export async function canSend(workspace: string) {
  return !await accounts.findOne({ _id: workspace, status: 'canceled' }, { projection: { _id: 1 } });
}

const summary = (row: BillingFields) => ({
  status: row.status, seats: row.seats, can_send: row.status !== 'canceled', approval_url: row.approvalUrl || null,
});
export const validSeats = (seats: unknown): seats is number =>
  typeof seats === 'number' && Number.isSafeInteger(seats) && seats >= 1 &&
  seats <= Math.floor(Number.MAX_SAFE_INTEGER / 1200);
export const validToken = (token: unknown): token is string => typeof token === 'string' && /^tok_[a-zA-Z0-9_]{1,100}$/.test(token);

class ProviderError extends Error {
  readonly code: number;
  constructor(code: number) {
    super('Paybox request failed');
    this.code = code;
  }
}

async function paybox<T>(path: string, method = 'GET', body?: object, key?: string): Promise<T> {
  const response = await fetch(new URL(path, config.paybox.url), {
    method, redirect: 'error', signal: AbortSignal.timeout(2000),
    headers: {
      authorization: 'Bearer ' + config.paybox.secretKey,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderError(response.status);
  }
  return response.json();
}

async function locked<T>(workspace: string, wait: number, work: (row: Billing, owner: string) => Promise<T>) {
  try {
    await accounts.updateOne({ _id: workspace }, { $setOnInsert: { ...defaultFields, generation: randomUUID() } }, { upsert: true });
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
  }
  const owner = randomUUID();
  const deadline = Date.now() + wait;
  do {
    const now = new Date();
    const row = await accounts.findOneAndUpdate(
      { _id: workspace, $or: [{ until: { $exists: false } }, { until: { $lte: now } }] },
      { $set: { owner, until: new Date(now.getTime() + leaseMs) } }, { returnDocument: 'after' },
    );
    if (row) {
      try { return await work(row, owner); }
      finally { await accounts.updateOne({ _id: workspace, owner }, { $unset: { owner: '', until: '' } }); }
    }
    if (Date.now() >= deadline) break;
    await sleep(50);
  } while (true);
}

async function save(row: Billing, owner: string, fields: Partial<Billing>, clearPending = false) {
  const result = await accounts.updateOne({ _id: row._id, owner, until: { $gt: new Date() } }, {
    $set: fields, ...(clearPending ? { $unset: { pending: '' } } : {}),
  });
  if (!result.matchedCount) throw new Error('Billing lease ended');
  Object.assign(row, fields);
  if (clearPending) delete row.pending;
}

function fieldsFor(sub: Subscription, row: Billing) {
  if (sub.customer !== row.customer || !['active', 'incomplete', 'past_due', 'canceled', 'incomplete_expired'].includes(sub.status)) {
    throw new Error('Invalid Paybox subscription');
  }
  const payment = sub.latest_invoice?.payment;
  const action = payment?.status === 'requires_action' ? payment.next_action?.url : undefined;
  let approvalUrl = '';
  if (action) {
    const url = new URL(action);
    if (url.origin === new URL(config.paybox.url).origin && /^\/authenticate\/\w+$/.test(url.pathname)) approvalUrl = url.href;
  }
  return {
    subscription: sub.id,
    status: sub.status === 'incomplete_expired' ? 'canceled' as const : sub.status,
    seats: sub.quantity, approvalUrl, syncAt: new Date(Date.now() + refreshMs),
  };
}

async function refresh(row: Billing, owner: string) {
  if (!row.subscription) return;
  const sub = await paybox<Subscription>('/v1/subscriptions/' + row.subscription);
  await save(row, owner, fieldsFor(sub, row));
}

async function finish(row: Billing, owner: string, op: Operation) {
  try {
    let subscription = row.subscription;
    if (op.kind === 'subscribe') {
      if (!row.customer) {
        const { id } = await paybox<{ id: string }>('/v1/customers', 'POST', {
          name: row._id, metadata: { workspace: row._id },
        }, 'customer-' + row.generation);
        await save(row, owner, { customer: id });
      }
      await paybox('/v1/customers/' + row.customer + '/payment_method', 'POST', { token: op.token }, op.id);
      if (subscription && row.status === 'incomplete') await paybox('/v1/subscriptions/' + subscription, 'DELETE');
      const created = await paybox<Subscription>('/v1/subscriptions', 'POST', {
        customer: row.customer, price, quantity: op.seats,
      }, op.id);
      subscription = created.id;
    } else {
      if (!subscription) throw new Error('No subscription to resize');
      await paybox('/v1/subscriptions/' + subscription, 'POST', { quantity: op.seats }, op.id);
    }
    const sub = await paybox<Subscription>('/v1/subscriptions/' + subscription);
    await save(row, owner, fieldsFor(sub, row), true);
    return op.kind === 'subscribe' ? row.status === 'active' : row.seats === op.seats && row.status !== 'canceled';
  } catch (error) {
    if (!(error instanceof ProviderError) || ![400, 402].includes(error.code)) throw error;
    await save(row, owner, { syncAt: new Date() }, true);
    return false;
  }
}

export async function changeBilling(workspace: string, kind: 'subscribe' | 'seats', seats: number, token?: string) {
  const result = await locked(workspace, 8000, async (row, owner) => {
    if (row.pending) await finish(row, owner, row.pending);
    await refresh(row, owner);
    if (kind === 'subscribe' && (row.status === 'active' || row.status === 'past_due' || row.approvalUrl)) {
      return { ok: row.status === 'active', ...summary(row) };
    }
    if (kind === 'seats' && !['active', 'past_due'].includes(row.status)) return { ok: false, ...summary(row) };
    if (kind === 'seats' && row.seats === seats) return { ok: true, ...summary(row) };
    const common = { id: randomUUID(), seats };
    const pending: Operation = kind === 'subscribe' ? { ...common, kind, token: token! } : { ...common, kind };
    await save(row, owner, { pending, syncAt: new Date() });
    const ok = await finish(row, owner, pending);
    return { ok, ...summary(row) };
  });
  if (!result) throw new Error('Billing operation in progress');
  return result;
}

export async function receivePaybox(req: IncomingMessage, signature: string | undefined, eventId: string | undefined) {
  // This import keeps the shared signature reader independent of billing setup.
  const { readSignedBody } = await import('./webhook.ts');
  const body = await readSignedBody(req, signature, config.paybox.webhookSecret);
  if (typeof body === 'number') return body;
  let event;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { return 400; }
  if (!event || typeof event.id !== 'string' || (eventId && event.id !== eventId) || typeof event.type !== 'string') return 400;
  if (!['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
    'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required'].includes(event.type)) return 204;
  const customer = event.data?.object?.customer;
  if (typeof customer !== 'string') return 400;
  const row = await accounts.findOne({ customer }, { projection: { _id: 1 } });
  if (!row) return 204;
  try {
    await events.updateOne({ _id: event.id }, {
      $setOnInsert: { workspace: row._id, done: false, expiresAt: new Date(Date.now() + 86_400_000) },
    }, { upsert: true });
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
  }
  return 204;
}

export function startBilling() {
  const poll = async () => {
    try {
      const dirty = await events.distinct('workspace', { done: false });
      const due = await accounts.find({ syncAt: { $lte: new Date() } }, { projection: { _id: 1 } }).toArray();
      await Promise.allSettled([...new Set([...dirty, ...due.map(row => row._id)])].map(async workspace => {
        await locked(workspace, 0, async (row, owner) => {
          const batch = await events.find({ workspace, done: false }).limit(100).toArray();
          if (!batch.length && !row.pending && (!row.syncAt || row.syncAt > new Date())) return;
          try {
            if (row.pending) await finish(row, owner, row.pending);
            await refresh(row, owner);
            if (!row.subscription) await save(row, owner, { syncAt: new Date(Date.now() + refreshMs) });
            await events.updateMany({ _id: { $in: batch.map(event => event._id) } }, { $set: { done: true } });
          } catch (error) {
            await save(row, owner, { syncAt: new Date(Date.now() + refreshMs) });
            logFailure('Billing reconciliation failed', error);
          }
        });
      }));
    } catch (error) {
      logFailure('Billing worker failed', error);
    } finally {
      setTimeout(poll, 400).unref();
    }
  };
  void poll();
}
