import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { allowedOrigin, logFailure } from './http.ts';
import { isMember, readSession } from './auth.ts';
import { changesAfter, latestSequence } from './feed.ts';
import { knownWorkspace } from './inbox.ts';

export function attachWebSockets(server: Server) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    function reject(status: number, reason: string) {
      socket.end('HTTP/1.1 ' + status + ' ' + reason + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
    socket.on('error', () => socket.destroy());
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') { reject(404, 'Not Found'); return; }
      const session = await readSession(req.headers.cookie);
      if (!session) { reject(401, 'Unauthorized'); return; }
      const workspace = url.searchParams.get('workspace');
      if (!allowedOrigin(req.headers.origin) || !knownWorkspace(workspace) || !isMember(session, workspace)) {
        reject(403, 'Forbidden');
        return;
      }
      const after = url.searchParams.get('after');
      if (after !== null && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))) {
        reject(400, 'Bad Request');
        return;
      }
      const cursor = after === null ? await latestSequence(workspace) : Number(after);
      if (socket.destroyed) return;
      sockets.handleUpgrade(req, socket, head, ws => {
        if (after === null) ws.send(JSON.stringify({ type: 'feed.ready', cursor }));
        follow(ws, workspace, cursor, req.headers.cookie);
      });
    })().catch(error => {
      logFailure('WebSocket upgrade failed', error);
      if (!socket.destroyed) reject(503, 'Service Unavailable');
    });
  });
}

function follow(ws: WebSocket, workspace: string, cursor: number, cookie: string | undefined) {
  let timer: NodeJS.Timeout | undefined;
  let alive = true;
  async function stillAuthorized() {
    const session = await readSession(cookie);
    if (session && isMember(session, workspace)) return true;
    ws.close(1008, 'Session ended');
    return false;
  }
  const heartbeat = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false;
    ws.ping();
    void stillAuthorized().catch(() => ws.close(1011, 'Session unavailable'));
  }, 15_000);
  ws.on('pong', () => { alive = true; });
  ws.on('error', () => ws.terminate());
  ws.once('close', () => {
    clearInterval(heartbeat);
    clearTimeout(timer);
  });

  // Replay and live delivery use the same ordered query and cursor.
  async function pump() {
    try {
      const batch = await changesAfter(workspace, cursor);
      if (batch.length && !await stillAuthorized()) return;
      for (const event of batch) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 512 * 1024) { ws.close(1013, 'Reconnect to resume'); return; }
        ws.send(JSON.stringify(event));
        cursor = event.seq;
      }
      if (ws.readyState === WebSocket.OPEN) timer = setTimeout(pump, batch.length === 100 ? 0 : 200);
    } catch (error) {
      logFailure('WebSocket feed read failed', error);
      ws.close(1011, 'Feed unavailable');
    }
  }
  void pump();
}
