import { timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { config } from './config.ts';
import { connectDb, getDb } from './db.ts';
import { claimConversation, initModels, knownWorkspace, queueReply, resetInbox, snapshot } from './inbox.ts';
import { startOutbox } from './outbox.ts';
import { applyWebhook, nonempty, validSignature } from './webhook.ts';

const app = express();

function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

app.get('/healthz', route(async (_req, res) => {
  try {
    await getDb().command({ ping: 1 }, { timeoutMS: 1500 });
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
}));

app.post('/webhooks/pigeon',
  (req, res, next) => {
    if (!req.get('x-pigeon-signature')) {
      res.sendStatus(401);
      return;
    }
    next();
  },
  express.raw({ type: () => true, inflate: false }),
  route(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!validSignature(req.get('x-pigeon-signature'), raw)) {
      res.sendStatus(401);
      return;
    }
    res.sendStatus(await applyWebhook(raw, req.get('x-pigeon-event-id')));
  }),
);

const grader = express.Router();
grader.use((req, res, next) => {
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
  console.error(error);
  res.sendStatus(503);
};
app.use(handleError);

await connectDb();
await initModels();
const server = createServer(app);
server.listen(config.port, () => {
  console.log('Switchboard listening', server.address());
  startOutbox();
});
