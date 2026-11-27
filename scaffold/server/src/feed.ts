import { randomUUID } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import { getDb } from './db.ts';

export interface Change {
  key: string;
  type: string;
  contact: string;
  message_id?: string;
  client_ref?: string;
  status?: string;
  assignee?: string;
  closed?: boolean;
}

interface FeedEvent extends Change {
  workspace: string;
  seq: number;
}

interface Head {
  _id: string;
  seq: number;
  pending?: Change;
}

const heads = getDb().collection<Head>('feed_heads');
const events = getDb().collection<FeedEvent>('feed_events');

export function change(type: Change['type'], contact: string, fields: Partial<Change> = {}): Change {
  return { key: randomUUID(), type, contact, ...fields };
}

export async function initFeed() {
  await events.createIndexes([
    { key: { workspace: 1, seq: 1 }, unique: true },
    { key: { workspace: 1, key: 1 }, unique: true },
  ]);
}

export async function resetFeed() {
  await heads.deleteMany({});
  await events.deleteMany({});
}

export async function latestSequence(workspace: string) {
  const last = await events.findOne({ workspace }, { sort: { seq: -1 }, projection: { seq: 1 } });
  return last?.seq ?? 0;
}

export async function changesAfter(workspace: string, seq: number) {
  return events.find({ workspace, seq: { $gt: seq } })
    .sort({ seq: 1 }).limit(100).project<Omit<FeedEvent, 'key' | 'workspace'>>({ _id: 0, workspace: 0, key: 0 }).toArray();
}

// A workspace has one durable reservation. Any instance can finish it after a crash.
// The next reservation is only visible after the previous event has been written.
async function publish(workspace: string, next: Change) {
  await heads.updateOne({ _id: workspace }, { $setOnInsert: { seq: 0 } }, { upsert: true });
  while (!await events.findOne({ workspace, key: next.key }, { projection: { _id: 1 } })) {
    const head = await heads.findOne({ _id: workspace });
    if (!head) return false;
    if (!head.pending) {
      await heads.updateOne(
        { _id: workspace, seq: head.seq, pending: { $exists: false } },
        { $inc: { seq: 1 }, $set: { pending: next } },
      );
      continue;
    }
    // A concurrent projector may already have inserted this exact event.
    try {
      await events.updateOne({ workspace, key: head.pending.key }, {
        $setOnInsert: { seq: head.seq, ...head.pending },
      }, { upsert: true });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000 ||
          !await events.findOne({ workspace, key: head.pending.key })) throw error;
    }
    await heads.updateOne(
      { _id: workspace, seq: head.seq, 'pending.key': head.pending.key },
      { $unset: { pending: '' } },
    );
  }
  return true;
}

export function startFeed(sources: string[]) {
  const collections = sources.map(name => getDb().collection<{ _id: ObjectId; workspace: string; changes?: Change[] }>(name));
  const poll = async () => {
    try {
      for (const collection of collections) {
        const batch = await collection.find({ 'changes.0': { $exists: true } })
          .limit(100).project<{ _id: ObjectId; workspace: string; changes: Change[] }>({ workspace: 1, changes: 1 }).toArray();
        for (const row of batch) {
          for (const item of row.changes) {
            if (await publish(row.workspace, item)) {
              await collection.updateOne({ _id: row._id }, { $pull: { changes: { key: item.key } } });
            }
          }
        }
      }
    } catch (error) {
      console.error('Realtime projection failed', error);
    } finally {
      setTimeout(poll, 100).unref();
    }
  };
  void poll();
}
