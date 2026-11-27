import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import WebSocket from 'ws';
import { importShareCode, makeShareCode, openNote, sealNote } from '../../web/src/noteCrypto.ts';

const workspace = 'ws_acme';
const contact = '+14155550101';
const token = 'isolated-grader-token';
const secret = 'isolated-webhook-secret';
const app = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const databaseUrl = new URL(process.env.MONGO_URL || 'mongodb://localhost:27017');
databaseUrl.pathname = '/switchboard_test_' + randomUUID().replaceAll('-', '');

async function eventually(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await sleep(40);
  } while (Date.now() < deadline);
  assert.fail('Condition did not become true within ' + timeout + ' ms');
}

function webhook(url, body, { age = 0, signWith = secret, signature, eventId = body.id, signBody, encoding } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const timestamp = Math.floor(Date.now() / 1000) - age;
  const mac = createHmac('sha256', signWith).update(timestamp + '.').update(signBody ?? bytes).digest('hex');
  const headers = { 'content-type': 'application/json' };
  if (encoding) headers['content-encoding'] = encoding;
  if (eventId) headers['x-pigeon-event-id'] = eventId;
  if (signature !== null) headers['x-pigeon-signature'] = signature ?? 't=' + timestamp + ',v1=' + mac;
  return fetch(url + '/webhooks/pigeon', { method: 'POST', headers, body: bytes });
}

function event(data, type = 'message.inbound', tenant = workspace) {
  return { id: randomUUID(), type, workspace: tenant, occurred_at: new Date().toISOString(), data };
}

function grader(url, action, payload, auth = token) {
  const headers = { 'content-type': 'application/json', 'x-grader-token': auth };
  const options = payload ? { method: 'POST', headers, body: JSON.stringify(payload) } : { headers };
  return fetch(url + '/__grader/' + action, options);
}

test('webhook contract and distributed recovery', { timeout: 60_000 }, async t => {
  const mongo = new MongoClient(databaseUrl.href);
  const db = mongo.db();
  const attempts = [];
  const sockets = new Set();
  const children = new Set();
  const accepted = new Map();
  const carrier = createServer(async (req, res) => {
    const buffers = [];
    for await (const buffer of req) buffers.push(buffer);
    const body = JSON.parse(Buffer.concat(buffers).toString());
    const key = req.headers['idempotency-key'];
    attempts.push({ ref: body.client_ref, key, at: Date.now(), workspace: req.headers.authorization });
    if (body.client_ref === 'rate-first' && attempts.filter(entry => entry.ref === body.client_ref).length === 1) {
      res.writeHead(429, { 'retry-after': '1' });
      res.end();
      return;
    }
    const id = accepted.get(key) ?? 'pm_' + randomUUID();
    accepted.set(key, id);
    if (body.client_ref === 'crash' && attempts.filter(entry => entry.ref === 'crash').length === 1) return;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id, status: 'accepted' }));
  });
  carrier.listen(0, '127.0.0.1');
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await Promise.all([...children].map(stop));
    carrier.closeAllConnections();
    await new Promise(resolve => carrier.close(resolve));
    try { await db.dropDatabase(); } finally { await mongo.close(); }
  });
  await once(carrier, 'listening');

  function start() {
    const child = spawn(process.execPath, ['--experimental-strip-types', app], {
      env: {
        ...process.env, PORT: '0', MONGO_URL: databaseUrl.href, GRADER_TOKEN: token,
        PIGEON_URL: 'http://127.0.0.1:' + carrier.address().port, PIGEON_WEBHOOK_SECRET: secret,
        PIGEON_KEY_WS_ACME: 'test_acme', PIGEON_KEY_WS_GLOBEX: 'test_globex',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.add(child);
    return new Promise((resolve, reject) => {
      let output = '';
      const startup = setTimeout(() => reject(new Error('Backend did not start')), 8000);
      child.once('error', reject);
      child.once('exit', code => { clearTimeout(startup); reject(new Error('Backend exited: ' + code)); });
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = /listening.*port: (\d+)/.exec(output);
        if (match) {
          clearTimeout(startup);
          resolve({ child, url: 'http://127.0.0.1:' + match[1] });
        }
      });
    });
  }

  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }

  const first = await start();
  const rateWorkspace = 'ws_globex';
  const postReply = (url, client_ref, tenant = workspace) => grader(url, 'reply', { workspace: tenant, contact, text: 'A reply', client_ref });
  const replyStatus = ref => db.collection('replies').findOne({ clientRef: ref }).then(reply => reply?.status);

  await t.test('authenticates exact bytes and handles ignored, malformed, and duplicate events', async () => {
    const inbound = event({ message_id: 'pmsg_first', from: contact, text: 'Hello' });
    const nullRef = event({ message_id: 'pm_unknown', client_ref: null, status: 'delivered' }, 'message.status');
    const unknownType = { type: 'carrier.new_event' };
    const invalidUtf8 = Buffer.from(JSON.stringify({ ...inbound, data: { ...inbound.data, text: '^' } }));
    invalidUtf8[invalidUtf8.indexOf('^')] = 0xff;
    const compressed = gzipSync(JSON.stringify(inbound));
    const cases = [
      [inbound, { signature: null }, 401],
      [inbound, { signature: 't=broken,v1=xyz' }, 401],
      [inbound, { signWith: 'wrong' }, 401],
      [inbound, { signBody: JSON.stringify(inbound) + ' ' }, 401],
      [inbound, { age: 301 }, 401],
      [Buffer.from('{'), {}, 400],
      [invalidUtf8, { eventId: inbound.id }, 400],
      [compressed, { encoding: 'gzip', signWith: 'wrong' }, 401],
      [compressed, { encoding: 'gzip' }, 400],
      [unknownType, {}, 204],
      [event(inbound.data, inbound.type, 'unknown'), {}, 204],
      [nullRef, {}, 204],
      [inbound, { age: 299 }, 204],
      [inbound, {}, 204],
      [{ ...inbound, id: randomUUID() }, {}, 204],
      [{ ...inbound, data: { ...inbound.data, message_id: 'pmsg_duplicate_event' } }, {}, 204],
    ];
    for (const [body, options, expected] of cases) {
      assert.equal((await webhook(first.url, body, options)).status, expected);
    }
    assert.equal((await grader(first.url, 'snapshot', undefined, 'wrong')).status, 401);
    const snapshot = await (await grader(first.url, 'snapshot')).json();
    assert.deepEqual(snapshot.workspaces[workspace].contacts[contact].inbound, ['pmsg_first']);
    assert.deepEqual(snapshot.workspaces[workspace].outbound, {});
    assert.equal((await postReply(first.url, 'unknown-workspace', 'unknown')).status, 400);
  });

  let second;
  await t.test('recovers accepted work across instances without trusting an unrelated provider ID', async () => {
    assert.equal((await postReply(first.url, 'crash')).status, 202);
    const original = await eventually(() => attempts.find(attempt => attempt.ref === 'crash'));
    assert.ok(original.key);
    const realId = accepted.get(original.key);
    for (const [id, status] of [['pm_unrelated', 'failed'], [realId, 'delivered'], [realId, 'sent']]) {
      const callback = event({ message_id: id, client_ref: 'crash', status }, 'message.status');
      assert.equal((await webhook(first.url, callback)).status, 204);
    }
    assert.equal(await replyStatus('crash'), 'queued');
    await stop(first.child);
    second = await start();
    assert.equal((await postReply(second.url, 'crash')).status, 202);
    await eventually(async () => await replyStatus('crash') === 'delivered', 15_000);
    assert.equal(await db.collection('replies').countDocuments({ clientRef: 'crash' }), 1);
    const originalAttempts = attempts.filter(attempt => attempt.ref === 'crash');
    assert.equal(originalAttempts.length, 2);
    assert.equal(originalAttempts[0].key, originalAttempts[1].key);
    assert.ok(originalAttempts[1].at - originalAttempts[0].at < 60_000);
    const late = event({ message_id: realId, client_ref: 'crash', status: 'sent' }, 'message.status');
    assert.equal((await webhook(second.url, late)).status, 204);
    assert.equal(await replyStatus('crash'), 'delivered');
    const snapshot = await (await grader(second.url, 'snapshot')).json();
    assert.deepEqual(snapshot.workspaces[workspace].contacts[contact].inbound, ['pmsg_first']);
  });

  await t.test('shares Retry-After across workers and atomically claims new contacts', async () => {
    const third = await start();
    assert.equal((await postReply(second.url, 'rate-first', rateWorkspace)).status, 202);
    const limited = await eventually(() => attempts.find(attempt => attempt.ref === 'rate-first'));
    const repeated = await Promise.all([second, third].map(({ url }) => postReply(url, 'rate-second', rateWorkspace)));
    assert.deepEqual(repeated.map(res => res.status), [202, 202]);
    await eventually(async () => (await replyStatus('rate-second')) === 'sent', 6000);
    const later = attempts.find(attempt => attempt.ref === 'rate-second');
    assert.ok(later.at - limited.at >= 1000);
    assert.equal(attempts.filter(entry => entry.ref === 'rate-second').length, 1);
    const claim = (url, agent) => grader(url, 'claim', { workspace: rateWorkspace, contact, agent });
    const outcomes = await Promise.all([claim(second.url, 'second'), claim(third.url, 'third')]);
    assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
    const winner = outcomes[0].status === 200 ? 'second' : 'third';
    assert.equal((await claim(third.url, winner)).status, 200);
  });

  await t.test('finishes a stranded feed reservation before delivering newer events', async () => {
    const head = db.collection('feed_heads');
    const feed = db.collection('feed_events');
    await eventually(() => feed.findOne({ workspace, type: 'message.status', status: 'delivered' }));
    await eventually(async () => !(await head.findOne({ _id: workspace })).pending);
    const reservation = { key: randomUUID(), type: 'message.inbound', contact, message_id: 'stranded' };
    const claimedHead = await head.findOneAndUpdate(
      { _id: workspace }, { $inc: { seq: 1 }, $set: { pending: reservation } }, { returnDocument: 'after' },
    );
    const acknowledged = event({ message_id: 'pmsg_next', from: contact, text: 'After crash' });
    assert.equal((await webhook(second.url, acknowledged)).status, 204);
    const session = Buffer.from(randomUUID().replaceAll('-', ''), 'utf8').toString('base64url');
    await db.collection('sessions').insertOne({
      _id: createHash('sha256').update(session).digest('base64url'), sub: 'test',
      expiresAt: new Date(Date.now() + 60_000), workspaces: [{ id: workspace, role: 'agent' }],
    });
    const ws = new WebSocket(second.url.replace('http:', 'ws:') + '/ws?workspace=' + workspace + '&after=' + (claimedHead.seq - 1), {
      headers: { cookie: 'sb_session=' + session },
    });
    sockets.add(ws);
    const frames = [];
    ws.on('message', message => frames.push(JSON.parse(message.toString())));
    await once(ws, 'open');
    await eventually(() => frames.length >= 2);
    assert.deepEqual(frames.map(frame => frame.message_id), ['stranded', 'pmsg_next']);
    assert.deepEqual(frames.map(frame => frame.seq), [claimedHead.seq, claimedHead.seq + 1]);
    ws.close();
  });

  await t.test('resets old workspace data without stranding live cursors and revokes logout access', async () => {
    const session = Buffer.from(randomUUID().replaceAll('-', '')).toString('base64url');
    const sessionId = createHash('sha256').update(session).digest('base64url');
    await db.collection('sessions').insertOne({
      _id: sessionId, sub: 'test', expiresAt: new Date(Date.now() + 60_000),
      workspaces: [{ id: workspace, role: 'agent' }],
    });
    const headers = { cookie: 'sb_session=' + session };
    const other = second.url + '/api/conversations/' + encodeURIComponent(contact) + '/claim?workspace=ws_globex';
    assert.equal((await fetch(other, { method: 'POST', headers })).status, 403);
    assert.equal((await fetch(second.url + '/__grader/snapshot')).status, 401);
    const ws = new WebSocket(second.url.replace('http:', 'ws:') + '/ws?workspace=' + workspace, { headers });
    sockets.add(ws);
    const frames = [];
    ws.on('message', message => frames.push(JSON.parse(message.toString())));
    await once(ws, 'open');
    const ready = await eventually(() => frames[0]);
    assert.equal(ready.type, 'feed.ready');
    assert.ok(ready.cursor > 0);
    assert.equal((await grader(second.url, 'reset', {})).status, 200);
    const snapshot = await (await grader(second.url, 'snapshot')).json();
    for (const tenant of Object.values(snapshot.workspaces)) {
      assert.deepEqual(tenant, { contacts: {}, outbound: {}, billing: { status: 'none', seats: 0, can_send: true } });
    }
    assert.equal(await db.collection('feed_events').countDocuments(), 0);
    assert.equal((await webhook(second.url, event({ message_id: 'after-reset', from: contact, text: 'New' }))).status, 204);
    const fresh = await eventually(() => frames[1]);
    assert.equal(fresh.message_id, 'after-reset');
    assert.ok(fresh.seq > ready.cursor);
    const logout = origin => fetch(second.url + '/auth/logout', { method: 'POST', headers: { ...headers, origin } });
    assert.equal((await logout('https://outside.invalid')).status, 403);
    assert.equal((await fetch(second.url + '/api/me', { headers })).status, 200);
    const response = await logout('http://localhost:5173');
    assert.equal(response.status, 204);
    assert.match(response.headers.getSetCookie()[0], /^sb_session=;.*HttpOnly/i);
    assert.equal((await fetch(second.url + '/api/me', { headers })).status, 401);
    const closed = once(ws, 'close');
    assert.equal((await webhook(second.url, event({ message_id: 'after-logout', from: contact, text: 'Private' }))).status, 204);
    assert.equal((await closed)[0], 1008);
    assert.equal(frames.length, 2);
    await db.collection('sessions').insertOne({
      _id: sessionId, sub: 'test', expiresAt: new Date(Date.now() - 1000),
      workspaces: [{ id: workspace, role: 'agent' }],
    });
    assert.equal((await fetch(second.url + '/api/me', { headers })).status, 401);
    const expiredSocket = new WebSocket(second.url.replace('http:', 'ws:') + '/ws?workspace=' + workspace, { headers });
    sockets.add(expiredSocket);
    const rejection = await once(expiredSocket, 'error');
    assert.match(rejection[0].message, /Unexpected server response: 401/);
  });

  await t.test('stores only note envelopes and isolates them from the carrier and other workspaces', async () => {
    async function signInAs(sub, id) {
      const secret = Buffer.from(randomUUID().replaceAll('-', '')).toString('base64url');
      await db.collection('sessions').insertOne({
        _id: createHash('sha256').update(secret).digest('base64url'), sub, expiresAt: new Date(Date.now() + 60_000),
        workspaces: [{ id, role: 'agent' }],
      });
      return { cookie: 'sb_session=' + secret };
    }
    const scope = { workspace, contact, author: 'note-author' };
    const author = await signInAs(scope.author, workspace);
    const teammate = await signInAs('note-reader', workspace);
    const outsider = await signInAs('other-tenant', rateWorkspace);
    const code = await makeShareCode(workspace);
    const sender = await importShareCode(workspace, code);
    const recipient = await importShareCode(workspace, code);
    const plaintext = 'Private note only: do not contact this customer 🚫';
    const envelope = await sealNote(plaintext, scope, sender);
    const path = second.url + '/api/conversations/' + encodeURIComponent(contact) + '/notes?workspace=';
    const post = (tenant, identity, payload) => fetch(path + tenant, {
      method: 'POST', headers: { ...identity, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const attemptsBefore = attempts.length;
    assert.equal((await fetch(path + workspace)).status, 401);
    assert.equal((await fetch(path + workspace, { headers: outsider })).status, 403);
    assert.equal((await post(workspace, outsider, envelope)).status, 403);
    assert.equal((await post(workspace, author, { ...envelope, text: plaintext })).status, 400);
    assert.equal((await post(workspace, author, envelope)).status, 201);
    assert.equal((await post(workspace, author, envelope)).status, 201);
    assert.equal((await post(workspace, teammate, envelope)).status, 409);
    const rows = await (await fetch(path + workspace, { headers: teammate })).json();
    assert.equal(rows.items.length, 1);
    const note = rows.items[0];
    assert.equal(note.author, scope.author);
    assert.equal(await openNote(note, scope, recipient), plaintext);
    const otherRows = await (await fetch(path + rateWorkspace, { headers: outsider })).json();
    assert.deepEqual(otherRows.items, []);
    const stored = await db.collection('private_notes').findOne({ id: envelope.id });
    for (const value of [plaintext, code, code.split('.')[2]]) assert.ok(!JSON.stringify(stored).includes(value));
    const realtime = await eventually(() => db.collection('feed_events').findOne({ workspace, type: 'note.created' }));
    assert.equal(realtime.contact, contact);
    assert.ok(!JSON.stringify(realtime).includes(envelope.ciphertext));
    assert.equal(await db.collection('replies').countDocuments(), 0);
    assert.equal(attempts.length, attemptsBefore);
    assert.equal((await grader(second.url, 'reset', {})).status, 200);
    assert.equal(await db.collection('private_notes').countDocuments(), 0);
  });
});

test('private note encryption interoperates between independent keys and detects tampering', async () => {
  const scope = { workspace, contact, author: 'u_ben' };
  const code = await makeShareCode(workspace);
  const origin = await importShareCode(workspace, code);
  const reader = await importShareCode(workspace, code);
  assert.equal(origin.key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', reader.key));
  await assert.rejects(importShareCode('ws_globex', code));
  const text = 'Private line 🌱\nSecond line';
  const envelope = await sealNote(text, scope, origin);
  assert.equal(await openNote(envelope, scope, reader), text);
  assert.notEqual((await sealNote(text, scope, origin)).iv, envelope.iv);
  for (const key of ['ciphertext', 'iv']) {
    const changed = (envelope[key][0] === 'A' ? 'B' : 'A') + envelope[key].slice(1);
    await assert.rejects(openNote({ ...envelope, [key]: changed }, scope, reader));
  }
  for (const key of ['workspace', 'contact', 'author']) {
    await assert.rejects(openNote(envelope, { ...scope, [key]: 'different' }, reader));
  }
  await assert.rejects(openNote({ ...envelope, id: randomUUID() }, scope, reader));
  const other = await importShareCode(workspace, await makeShareCode(workspace));
  await assert.rejects(openNote({ ...envelope, keyId: other.id }, scope, other));
});
