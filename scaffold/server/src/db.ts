import { MongoClient } from 'mongodb';
import { config } from './config.ts';

const client = new MongoClient(config.mongoUrl, {
  serverSelectionTimeoutMS: 2000,
  writeConcern: { w: 'majority', journal: true },
});

export function getDb() {
  return client.db();
}

export async function connectDb() {
  await client.connect();
}
