import { MongoServerError } from 'mongodb';
import { getDb } from './db.ts';
import { config } from './config.ts';

export type CarrierStatus = 'sent' | 'delivered' | 'failed';
export type ReplyStatus = 'queued' | CarrierStatus;

interface Inbound {
  workspace: string;
  contact: string;
  eventId: string;
  messageId: string;
  text: string;
  occurredAt: Date;
}

interface Conversation {
  workspace: string;
  contact: string;
  assignee: string;
}

interface Reply {
  workspace: string;
  contact: string;
  clientRef: string;
  text: string;
  status: ReplyStatus;
  providerId?: string;
  attempts: number;
  nextAttemptAt: Date;
}

interface SendGate {
  _id: string;
  owner?: string;
  availableAt: Date;
}

const db = getDb();
const inbound = db.collection<Inbound>('inbound');
const conversations = db.collection<Conversation>('conversations');
export const replies = db.collection<Reply>('replies');
export const sendGates = db.collection<SendGate>('send_gates');

export const workspaces = Object.keys(config.pigeon.apiKeys);

export function knownWorkspace(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(config.pigeon.apiKeys, value);
}

export async function initModels() {
  await Promise.all([
    inbound.createIndexes([
      { key: { workspace: 1, eventId: 1 }, unique: true },
      { key: { workspace: 1, messageId: 1 }, unique: true },
      { key: { workspace: 1, contact: 1, occurredAt: 1, messageId: 1 } },
    ]),
    conversations.createIndex({ workspace: 1, contact: 1 }, { unique: true }),
    replies.createIndexes([
      { key: { workspace: 1, clientRef: 1 }, unique: true },
      { key: { workspace: 1, status: 1, nextAttemptAt: 1, _id: 1 } },
    ]),
  ]);
}

export function duplicateKey(error: unknown) {
  return error instanceof MongoServerError && error.code === 11000;
}

export async function storeInbound(message: Inbound) {
  try {
    await inbound.insertOne(message);
  } catch (error) {
    if (!duplicateKey(error)) throw error;
  }
}

export async function queueReply(workspace: string, contact: string, text: string, clientRef: string) {
  try {
    await replies.updateOne(
      { workspace, clientRef },
      { $setOnInsert: { contact, text, status: 'queued', attempts: 0, nextAttemptAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    if (!duplicateKey(error)) throw error;
  }
}

export async function claimConversation(workspace: string, contact: string, agent: string) {
  try {
    const result = await conversations.updateOne(
      { workspace, contact, assignee: agent },
      { $setOnInsert: { workspace, contact, assignee: agent } },
      { upsert: true },
    );
    return result.matchedCount + result.upsertedCount === 1;
  } catch (error) {
    if (!duplicateKey(error)) throw error;
    return Boolean(await conversations.findOne({ workspace, contact, assignee: agent }));
  }
}

export async function recordStatus(workspace: string, clientRef: string, providerId: string, status: CarrierStatus) {
  await replies.updateOne(
    {
      workspace, clientRef, attempts: { $gt: 0 },
      status: { $in: status === 'sent' ? ['queued'] : ['queued', 'sent'] },
      $or: [{ providerId }, { providerId: { $exists: false } }],
    },
    { $set: { providerId, status } },
  );
}

interface ContactSnapshot {
  inbound: string[];
  assignee: string | null;
}

export async function snapshot() {
  const result = Object.fromEntries(workspaces.map(workspace => [workspace, {
    contacts: Object.create(null) as Record<string, ContactSnapshot>,
    outbound: Object.create(null) as Record<string, ReplyStatus>,
  }]));
  for (const { workspace, contact, messageId } of await inbound.find({ workspace: { $in: workspaces } }).sort({
    workspace: 1, contact: 1, occurredAt: 1, messageId: 1,
  }).toArray()) {
    (result[workspace].contacts[contact] ??= { inbound: [], assignee: null }).inbound.push(messageId);
  }
  for (const { workspace, contact, clientRef, status } of await replies.find({ workspace: { $in: workspaces } }).toArray()) {
    result[workspace].contacts[contact] ??= { inbound: [], assignee: null };
    result[workspace].outbound[clientRef] = status;
  }
  for (const { workspace, contact, assignee } of await conversations.find({ workspace: { $in: workspaces } }).toArray()) {
    (result[workspace].contacts[contact] ??= { inbound: [], assignee: null }).assignee = assignee;
  }
  return { workspaces: result };
}

export async function resetInbox() {
  await Promise.all([inbound.deleteMany({}), conversations.deleteMany({}), replies.deleteMany({}), sendGates.deleteMany({})]);
}
