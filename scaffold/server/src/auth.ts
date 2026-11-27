import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { Router } from 'express';
import { config } from './config.ts';
import { getDb } from './db.ts';
import { allowedOrigin, route } from './http.ts';

export interface Identity {
  sub: string;
  workspaces: { id: string; role: 'admin' | 'agent' }[];
}

const sessions = getDb().collection<Identity & { _id: string; expiresAt: Date }>('sessions');
const logins = getDb().collection<{ _id: string; verifier: string; nonce: string; expiresAt: Date }>('oidc_logins');
const sessionLifetime = 8 * 60 * 60 * 1000;
const handshakeLifetime = 10 * 60 * 1000;
const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: new URL(config.oidc.redirectUri).protocol === 'https:', path: '/' };
const random = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');

export async function initAuth() {
  await Promise.all([
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    logins.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

function cookie(header: string | undefined, name: string) {
  const value = header?.split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1);
  return value && /^[\w-]{43}$/.test(value) ? value : undefined;
}

export async function readSession(header: string | undefined) {
  const id = cookie(header, 'sb_session');
  return id ? sessions.findOne({ _id: hash(id), expiresAt: { $gt: new Date() } }) : null;
}

export function isMember(identity: Identity, workspace: unknown): workspace is string {
  return typeof workspace === 'string' && identity.workspaces.some(entry => entry.id === workspace);
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

async function fetchJson(url: string, options?: RequestInit) {
  const res = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error('Identity provider responded with ' + res.status);
  return res.json();
}

async function discovery(): Promise<Discovery> {
  const issuer = config.oidc.issuer.replace(/\/$/, '');
  const metadata = await fetchJson(issuer + '/.well-known/openid-configuration');
  if (metadata.issuer !== config.oidc.issuer ||
      !['authorization_endpoint', 'token_endpoint', 'jwks_uri'].every(key =>
        typeof metadata[key] === 'string' && new URL(metadata[key]).origin === new URL(issuer).origin)) {
    throw new Error('Invalid OIDC discovery metadata');
  }
  return metadata;
}

async function verifyIdentity(token: unknown, issuer: Discovery, nonce: string): Promise<Identity> {
  if (typeof token !== 'string') throw new Error('Missing ID token');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[\w-]+$/.test(part))) throw new Error('Invalid ID token');
  const [head, body, signature] = parts;
  const { alg, kid } = JSON.parse(Buffer.from(head, 'base64url').toString());
  if (alg !== 'RS256' || typeof kid !== 'string') throw new Error('Unsupported ID token algorithm');
  const { keys } = await fetchJson(issuer.jwks_uri);
  const jwk = keys.find((key: { kid: string; kty: string; alg?: string }) => key.kid === kid && key.kty === 'RSA' && (!key.alg || key.alg === alg));
  if (!jwk || !verify('RSA-SHA256', Buffer.from(head + '.' + body), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) {
    throw new Error('Invalid ID token signature');
  }
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== issuer.issuer || claims.aud !== config.oidc.clientId || claims.nonce !== nonce ||
      !Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now + 30 ||
      typeof claims.sub !== 'string' || !claims.sub || !Array.isArray(claims.workspaces)) {
    throw new Error('Invalid ID token claims');
  }
  const workspaces = claims.workspaces
    .filter((entry: Identity['workspaces'][number]) => entry && typeof entry.id === 'string' && ['admin', 'agent'].includes(entry.role))
    .map(({ id, role }: Identity['workspaces'][number]) => ({ id, role }));
  return { sub: claims.sub, workspaces };
}

export const auth = Router();
auth.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

auth.post('/logout', route(async (req, res) => {
  if (!allowedOrigin(req.get('origin')) || req.get('sec-fetch-site') === 'cross-site') {
    res.sendStatus(403);
    return;
  }
  const id = cookie(req.headers.cookie, 'sb_session');
  if (id) await sessions.deleteOne({ _id: hash(id) });
  res.clearCookie('sb_session', cookieOptions);
  res.sendStatus(204);
}));

auth.get('/login', route(async (_req, res) => {
  const issuer = await discovery();
  const state = random();
  const verifier = random();
  const nonce = random();
  await logins.insertOne({ _id: hash(state), verifier, nonce, expiresAt: new Date(Date.now() + handshakeLifetime) });
  res.cookie('sb_login', state, { ...cookieOptions, maxAge: handshakeLifetime });
  const url = new URL(issuer.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: config.oidc.clientId, redirect_uri: config.oidc.redirectUri,
    scope: 'openid profile', code_challenge: hash(verifier), code_challenge_method: 'S256', state, nonce,
  }).toString();
  res.redirect(url.href);
}));

auth.get('/callback', route(async (req, res) => {
  const { state, code } = req.query;
  if (typeof state !== 'string' || state !== cookie(req.headers.cookie, 'sb_login') || typeof code !== 'string' || !code) {
    res.status(400).send('Login could not be verified. Return to Switchboard and sign in again.');
    return;
  }
  res.clearCookie('sb_login', cookieOptions);
  const login = await logins.findOneAndDelete({ _id: hash(state), expiresAt: { $gt: new Date() } });
  if (!login) { res.sendStatus(400); return; }
  let identity: Identity;
  try {
    const issuer = await discovery();
    const token = await fetchJson(issuer.token_endpoint, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: config.oidc.redirectUri,
        client_id: config.oidc.clientId, client_secret: config.oidc.clientSecret, code_verifier: login.verifier,
      }),
    });
    identity = await verifyIdentity(token.id_token, issuer, login.nonce);
  } catch {
    res.status(401).send('Login failed. Return to Switchboard and sign in again.');
    return;
  }
  const previous = cookie(req.headers.cookie, 'sb_session');
  if (previous) await sessions.deleteOne({ _id: hash(previous) });
  const id = random();
  await sessions.insertOne({ ...identity, _id: hash(id), expiresAt: new Date(Date.now() + sessionLifetime) });
  res.cookie('sb_session', id, { ...cookieOptions, maxAge: sessionLifetime });
  res.redirect(config.webOrigin);
}));
