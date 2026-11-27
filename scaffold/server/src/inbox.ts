import { MongoServerError } from 'mongodb';
import { getDb } from './db.ts';
import { config } from './config.ts';
import { change, resetFeed, type Change } from './feed.ts';

export type CarrierStatus = 'sent' | 'delivered' | 'failed';
export type ReplyStatus = 'queued' | CarrierStatus;

interface Inbound {
  workspace: string;
  contact: string;
  eventId: string;
  messageId: string;
  text: string;
  occurredAt: Date;
  changes?: Change[];
}

interface Conversation {
  workspace: string;
  contact: string;
  assignee?: string | null;
  closed?: boolean;
  createdAt?: Date;
  changes?: Change[];
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
  createdAt?: Date;
  changes?: Change[];
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
export const changeSources = [inbound, conversations, replies].map(collection => collection.collectionName);

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
      { key: { workspace: 1, contact: 1, createdAt: 1 } },
    ]),
  ]);
}

export function duplicateKey(error: unknown) {
  return error instanceof MongoServerError && error.code === 11000;
}

export async function storeInbound(message: Inbound) {
  try {
    await inbound.insertOne({
      ...message,
      changes: [change('message.inbound', message.contact, { message_id: message.messageId })],
    });
  } catch (error) {
    if (!duplicateKey(error)) throw error;
  }
}

export async function queueReply(workspace: string, contact: string, text: string, clientRef: string) {
  const now = new Date();
  try {
    await replies.updateOne(
      { workspace, clientRef },
      { $setOnInsert: {
        contact, text, status: 'queued', attempts: 0, nextAttemptAt: now, createdAt: now,
        changes: [change('message.status', contact, { client_ref: clientRef, status: 'queued' })],
      } },
      { upsert: true },
    );
  } catch (error) {
    if (!duplicateKey(error)) throw error;
  }
}

export async function claimConversation(workspace: string, contact: string, agent: string) {
  try {
    const result = await conversations.updateOne(
      { workspace, contact, assignee: null },
      {
        $set: { assignee: agent },
        $setOnInsert: { createdAt: new Date() },
        $push: { changes: change('conversation.assigned', contact, { assignee: agent }) },
      },
      { upsert: true },
    );
    return result.matchedCount + result.upsertedCount === 1;
  } catch (error) {
    if (!duplicateKey(error)) throw error;
    return Boolean(await conversations.findOne({ workspace, contact, assignee: agent }));
  }
}

export async function recordStatus(workspace: string, clientRef: string, providerId: string, status: CarrierStatus) {
  const reply = await replies.findOne({ workspace, clientRef }, { projection: { contact: 1 } });
  if (!reply) return;
  await replies.updateOne(
    {
      _id: reply._id, attempts: { $gt: 0 },
      status: { $in: status === 'sent' ? ['queued'] : ['queued', 'sent'] },
      $or: [{ providerId }, { providerId: { $exists: false } }],
    },
    {
      $set: { providerId, status },
      $push: { changes: change('message.status', reply.contact, { client_ref: clientRef, status }) },
    },
  );
}

export async function setConversationClosed(workspace: string, contact: string, closed: boolean) {
  const key = { workspace, contact };
  if (!await conversations.findOne(key) && !await inbound.findOne(key) && !await replies.findOne(key)) return false;
  const event = change('conversation.closed', contact, { closed });
  try {
    await conversations.updateOne(
      { ...key, closed: { $ne: closed } },
      { $set: { closed }, $setOnInsert: { createdAt: new Date() }, $push: { changes: event } },
      { upsert: true },
    );
  } catch (error) {
    if (!duplicateKey(error)) throw error;
    await conversations.updateOne(
      { ...key, closed: { $ne: closed } },
      { $set: { closed }, $push: { changes: event } },
    );
  }
  return true;
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
    (result[workspace].contacts[contact] ??= { inbound: [], assignee: null }).assignee = assignee ?? null;
  }
  return { workspaces: result };
}

export async function resetInbox() {
  await Promise.all([inbound.deleteMany({}), conversations.deleteMany({}), replies.deleteMany({}), sendGates.deleteMany({})]);
  await resetFeed();
}

export interface PageCursor {
  at: Date;
  key: string;
}

export async function listConversations(workspace: string, limit: number, after?: PageCursor) {
  const rows = await inbound.aggregate<{
    contact: string; lastActivity: Date; assignee: string | null; closed: boolean;
  }>([
    { $match: { workspace } },
    { $group: { _id: '$contact', lastActivity: { $max: '$occurredAt' } } },
    { $unionWith: { coll: replies.collectionName, pipeline: [
      { $match: { workspace } },
      { $group: { _id: '$contact', lastActivity: { $max: { $ifNull: ['$createdAt', { $toDate: '$_id' }] } } } },
    ] } },
    { $unionWith: { coll: conversations.collectionName, pipeline: [
      { $match: { workspace } },
      { $project: { _id: '$contact', fallbackActivity: { $ifNull: ['$createdAt', { $toDate: '$_id' }] }, assignee: 1, closed: 1 } },
    ] } },
    { $group: {
      _id: '$_id', lastActivity: { $max: '$lastActivity' }, fallbackActivity: { $max: '$fallbackActivity' },
      assignee: { $max: '$assignee' }, closed: { $max: '$closed' },
    } },
    { $set: { lastActivity: { $ifNull: ['$lastActivity', '$fallbackActivity'] } } },
    ...(after ? [{ $match: { $or: [{ lastActivity: { $lt: after.at } }, { lastActivity: after.at, _id: { $gt: after.key } }] } }] : []),
    { $sort: { lastActivity: -1, _id: 1 } },
    { $limit: limit + 1 },
    { $project: { _id: 0, contact: '$_id', lastActivity: 1, assignee: { $ifNull: ['$assignee', null] }, closed: { $ifNull: ['$closed', false] } } },
  ]).toArray();
  return rows;
}

export async function listMessages(workspace: string, contact: string, limit: number, after?: PageCursor) {
  const scope = { workspace, contact };
  return inbound.aggregate<{
    id: string; text: string; at: Date; direction: 'inbound' | 'outbound'; status?: ReplyStatus;
  }>([
    { $match: scope },
    { $project: { _id: 0, id: { $concat: ['in:', '$messageId'] }, at: '$occurredAt', text: 1, direction: { $literal: 'inbound' } } },
    { $unionWith: { coll: replies.collectionName, pipeline: [
      { $match: scope },
      { $project: {
        _id: 0, id: { $concat: ['out:', '$clientRef'] }, at: { $ifNull: ['$createdAt', { $toDate: '$_id' }] },
        text: 1, status: 1, direction: { $literal: 'outbound' },
      } },
    ] } },
    ...(after ? [{ $match: { $or: [{ at: { $lt: after.at } }, { at: after.at, id: { $lt: after.key } }] } }] : []),
    { $sort: { at: -1, id: -1 } },
    { $limit: limit + 1 },
  ]).toArray();
}
