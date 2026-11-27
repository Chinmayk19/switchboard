import { Router, json, type Request, type Response } from 'express';
import { isMember, readSession } from './auth.ts';
import { config } from './config.ts';
import { claimConversation, knownWorkspace, listConversations, listMessages, queueReply, setConversationClosed, type PageCursor } from './inbox.ts';
import { route } from './http.ts';
import { nonempty } from './webhook.ts';

const origins = new Set([new URL(config.webOrigin).origin, new URL(config.oidc.redirectUri).origin]);
export const allowedOrigin = (origin: string | undefined) => !origin || origins.has(origin);

function pagination(req: Request) {
  const limit = req.query.limit === undefined ? 30 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return;
  const encoded = req.query.after;
  if (encoded === undefined) return { limit };
  if (typeof encoded !== 'string' || encoded.length > 4096) return;
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    const at = new Date(data.at);
    if (!Number.isFinite(at.getTime()) || !nonempty(data.key)) return;
    const after: PageCursor = { at, key: data.key };
    return { limit, after };
  } catch {
    return;
  }
}

function sendPage<T>(res: Response, rows: T[], limit: number, cursor: (row: T) => PageCursor) {
  const items = rows.slice(0, limit);
  const next = rows.length > limit ? Buffer.from(JSON.stringify(cursor(items[limit - 1]))).toString('base64url') : null;
  res.json({ items, next });
}

export const api = Router();
api.use((req, res, next) => {
  void readSession(req.headers.cookie).then(identity => {
    res.set('Cache-Control', 'no-store');
    if (!identity) { res.sendStatus(401); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !allowedOrigin(req.get('origin'))) {
      res.sendStatus(403);
      return;
    }
    res.locals.identity = identity;
    next();
  }).catch(next);
});

api.get('/me', (_req, res) => {
  const { sub, workspaces } = res.locals.identity;
  res.json({ sub, workspaces });
});

api.use('/conversations', (req, res, next) => {
  const workspace = req.query.workspace;
  if (!knownWorkspace(workspace) || !isMember(res.locals.identity, workspace)) {
    res.sendStatus(403);
    return;
  }
  res.locals.workspace = workspace;
  next();
});

api.get('/conversations', route(async (req, res) => {
  const page = pagination(req);
  if (!page) { res.sendStatus(400); return; }
  const rows = await listConversations(res.locals.workspace, page.limit, page.after);
  sendPage(res, rows, page.limit, row => ({ at: row.lastActivity, key: row.contact }));
}));

api.get('/conversations/:contact/messages', route(async (req, res) => {
  const page = pagination(req);
  if (!page) { res.sendStatus(400); return; }
  const rows = await listMessages(res.locals.workspace, req.params.contact, page.limit, page.after);
  sendPage(res, rows, page.limit, row => ({ at: row.at, key: row.id }));
}));

api.post('/conversations/:contact/claim', route(async (req, res) => {
  const claimed = await claimConversation(res.locals.workspace, req.params.contact, res.locals.identity.sub);
  res.sendStatus(claimed ? 200 : 409);
}));

api.post('/conversations/:contact/reply', json(), route(async (req, res) => {
  const { text, client_ref } = req.body ?? {};
  if (!nonempty(text) || !text.trim() || !nonempty(client_ref) || client_ref.length > 200) {
    res.sendStatus(400);
    return;
  }
  await queueReply(res.locals.workspace, req.params.contact, text, client_ref);
  res.sendStatus(202);
}));

for (const action of ['close', 'reopen'] as const) {
  api.post('/conversations/:contact/' + action, route(async (req, res) => {
    const exists = await setConversationClosed(res.locals.workspace, req.params.contact, action === 'close');
    res.sendStatus(exists ? 200 : 404);
  }));
}
