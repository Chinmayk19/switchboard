import type { NextFunction, Request, Response } from 'express';
import { config } from './config.ts';

const origins = new Set([new URL(config.webOrigin).origin, new URL(config.oidc.redirectUri).origin]);
export const allowedOrigin = (origin: string | undefined) => !origin || origins.has(origin);

export function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}
