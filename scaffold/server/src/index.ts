import { timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import { config } from './config.ts';
import { connectDb, getDb } from './db.ts';
import { changeSources, claimConversation, initModels, knownWorkspace, queueReply, resetInbox, snapshot } from './inbox.ts';
import { startOutbox } from './outbox.ts';
import { nonempty, receiveWebhook } from './webhook.ts';
import { logFailure, route } from './http.ts';
import { auth, initAuth } from './auth.ts';
import { api } from './api.ts';
import { initFeed, startFeed } from './feed.ts';
import { attachWebSockets } from './socket.ts';

const app = express();
app.disable('x-powered-by');
app.use('/auth', auth);
app.use('/api', api);

app.get('/healthz', route(async (_req, res) => {
  try {
    await getDb().command({ ping: 1 }, { timeoutMS: 1500 });
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
}));

app.post('/webhooks/pigeon', route(async (req, res) => {
  res.sendStatus(await receiveWebhook(req, req.get('x-pigeon-signature'), req.get('x-pigeon-event-id')));
}));

const grader = express.Router();
grader.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const token = Buffer.from(req.get('x-grader-token') ?? '');
  const expected = Buffer.from(config.graderToken);
  if (!expected.length || token.length !== expected.length || !timingSafeEqual(token, expected)) {
    res.sendStatus(401);
    return;
  }
  next();
});
grader.use(express.json());

grader.post('/reset', route(async (_req, res) => {
  await resetInbox();
  res.sendStatus(200);
}));

grader.get('/snapshot', route(async (_req, res) => {
  res.json(await snapshot());
}));

grader.post('/reply', route(async (req, res) => {
  const { workspace, contact, text, client_ref } = req.body ?? {};
  if (!knownWorkspace(workspace) || !nonempty(contact) || !nonempty(text) || !nonempty(client_ref)) {
    res.sendStatus(400);
    return;
  }
  await queueReply(workspace, contact, text, client_ref);
  res.sendStatus(202);
}));

grader.post('/claim', route(async (req, res) => {
  const { workspace, contact, agent } = req.body ?? {};
  if (!knownWorkspace(workspace) || !nonempty(contact) || !nonempty(agent)) {
    res.sendStatus(400);
    return;
  }
  res.sendStatus(await claimConversation(workspace, contact, agent) ? 200 : 409);
}));

app.use('/__grader', grader);

const handleError: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    res.sendStatus(error.status);
    return;
  }
  logFailure('HTTP handler failed', error);
  res.sendStatus(503);
};
app.use(handleError);

await connectDb();
await Promise.all([initModels(), initAuth(), initFeed(changeSources)]);
const server = createServer(app);
attachWebSockets(server);
server.listen(config.port, () => {
  console.log('Switchboard listening', server.address());
  startOutbox();
  startFeed(changeSources);
});
