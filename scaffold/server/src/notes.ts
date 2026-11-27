import { MongoServerError } from 'mongodb';
import { getDb } from './db.ts';
import { change, type Change } from './feed.ts';
import type { PageCursor } from './inbox.ts';

export interface Envelope {
  id: string;
  version: 1;
  keyId: string;
  iv: string;
  ciphertext: string;
}

interface Note extends Envelope {
  workspace: string;
  contact: string;
  author: string;
  at: Date;
  changes?: Change[];
}

export const notes = getDb().collection<Note>('private_notes');

export function validEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 5 || body.version !== 1) return false;
  if (typeof body.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.id)) return false;
  if (typeof body.keyId !== 'string' || !/^[\w-]{22}$/.test(body.keyId)) return false;
  if (typeof body.iv !== 'string' || !/^[\w-]{16}$/.test(body.iv)) return false;
  return typeof body.ciphertext === 'string' && /^[\w-]+$/.test(body.ciphertext) &&
    body.ciphertext.length >= 23 && body.ciphertext.length <= 16_000 && body.ciphertext.length % 4 !== 1;
}

export async function initNotes() {
  await notes.createIndexes([
    { key: { workspace: 1, id: 1 }, unique: true },
    { key: { workspace: 1, contact: 1, at: -1, id: -1 } },
  ]);
}

export async function saveNote(workspace: string, contact: string, author: string, envelope: Envelope) {
  const record = { ...envelope, workspace, contact, author, at: new Date() };
  try {
    await notes.insertOne({ ...record, changes: [change('note.created', contact)] });
    return true;
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
    const existing = await notes.findOne({ workspace, id: envelope.id });
    return existing?.contact === contact && existing.author === author &&
      existing.keyId === envelope.keyId && existing.iv === envelope.iv && existing.ciphertext === envelope.ciphertext;
  }
}

export function listNotes(workspace: string, contact: string, limit: number, after?: PageCursor) {
  const cursor = after ? { $or: [{ at: { $lt: after.at } }, { at: after.at, id: { $lt: after.key } }] } : {};
  return notes.find({ workspace, contact, ...cursor }).sort({ at: -1, id: -1 }).limit(limit + 1)
    .project<Envelope & Pick<Note, 'author' | 'at'>>({ _id: 0, id: 1, version: 1, keyId: 1, iv: 1, ciphertext: 1, author: 1, at: 1 })
    .toArray();
}
