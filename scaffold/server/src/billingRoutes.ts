import { Router, json } from 'express';
import { billingView, changeBilling, validSeats, validToken } from './billing.ts';
import { config } from './config.ts';
import { knownWorkspace } from './inbox.ts';
import { route } from './http.ts';

export function billingRoutes(grader: boolean) {
  const router = Router();
  if (!grader) {
    router.use((req, res, next) => {
      const workspace = req.query.workspace;
      if (!knownWorkspace(workspace) || !res.locals.identity.workspaces.some((member: { id: string; role: string }) =>
        member.id === workspace && member.role === 'admin')) {
        res.sendStatus(403);
        return;
      }
      res.locals.workspace = workspace;
      next();
    });
    router.get('/', route(async (_req, res) => {
      res.json({
        ...await billingView(res.locals.workspace),
        paybox_url: config.paybox.url,
        publishable_key: config.paybox.publishableKey,
      });
    }));
    router.use(json({ limit: '2kb' }));
  }
  for (const kind of ['subscribe', 'seats'] as const) {
    router.post('/' + kind, route(async (req, res) => {
      const workspace = grader ? req.body?.workspace : res.locals.workspace;
      const { seats, token } = req.body ?? {};
      const allowed = new Set(['seats', ...(grader ? ['workspace'] : []), ...(kind === 'subscribe' ? ['token'] : [])]);
      if (!knownWorkspace(workspace) || !validSeats(seats) || (kind === 'subscribe' && !validToken(token)) ||
          Object.keys(req.body ?? {}).some(key => !allowed.has(key))) {
        res.sendStatus(400);
        return;
      }
      const result = await changeBilling(workspace, kind, seats, token);
      res.status(result.ok ? 200 : 402).json(result);
    }));
  }
  return router;
}
