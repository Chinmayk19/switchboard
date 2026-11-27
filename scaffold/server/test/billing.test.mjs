import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MongoClient } from 'mongodb';

const token = 'billing-test-grader';
const secret = 'billing-test-webhook';
const pub = 'pk_test_paybox_9a7b3e';
const app = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const sim = fileURLToPath(new URL('../../../paybox/server.js', import.meta.url));
const mongoUrl = new URL(process.env.MONGO_URL || 'mongodb://localhost:27017');
mongoUrl.pathname = '/sb_billing_test_' + randomUUID().replaceAll('-', '');
const headers = { 'content-type': 'application/json' };

async function eventual(check) {
  for (let i = 0; i < 100; i++) {
    const answer = await check();
    if (answer) return answer;
    await sleep(60);
  }
  assert.fail('Timed out waiting for billing state');
}

test('Paybox subscriptions, proration, approval, renewal and enforcement', { timeout: 45_000 }, async t => {
  const children = [];
  const mongo = new MongoClient(mongoUrl.href);
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }));
    try { await mongo.db().dropDatabase(); } finally { await mongo.close(); }
  });
  const choose = createServer().listen(0, '127.0.0.1');
  await once(choose, 'listening');
  const port = choose.address().port;
  await new Promise(resolve => choose.close(resolve));
  const provider = 'http://localhost:' + port;

  async function launch(args, env, regex) {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Startup timeout')), 8000);
      let output = '';
      child.on('error', reject);
      child.on('exit', code => { clearTimeout(timer); reject(Error('Unexpected exit ' + code)); });
      child.stdout.on('data', data => {
        output += data;
        const match = regex.exec(output);
        if (match) { clearTimeout(timer); resolve(match); }
      });
    });
  }
  const appEnv = {
    PORT: '0', MONGO_URL: mongoUrl.href, GRADER_TOKEN: token, PAYBOX_URL: provider,
    PAYBOX_WEBHOOK_SECRET: secret, PIGEON_URL: 'http://127.0.0.1:9',
  };
  const [, appPort] = await launch(['--experimental-strip-types', app], appEnv, /listening.*port: (\d+)/i);
  const [, peerPort] = await launch(['--experimental-strip-types', app], appEnv, /listening.*port: (\d+)/i);
  const base = 'http://127.0.0.1:' + appPort;
  await launch([sim], { PORT: String(port), PAYBOX_PUBLIC_URL: provider, PAYBOX_WEBHOOK_SECRET: secret,
    PAYBOX_TARGET_URL: base + '/webhooks/paybox' }, /paybox listening/);
  const post = (url, body, auth = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...auth }, body: JSON.stringify(body) });
  const grader = { 'x-grader-token': token };
  const bill = (op, workspace, seats, token, origin = base) => post(origin + '/__grader/billing/' + op, { workspace, seats, ...(token ? { token } : {}) }, grader);
  const snapshot = async () => (await (await fetch(base + '/__grader/snapshot', { headers: grader })).json()).workspaces;
  const report = async () => (await fetch(provider + '/__admin/report')).json();
  const tokenize = async number => {
    const res = await post(provider + '/v1/tokens', { card: { number, exp_month: 12, exp_year: new Date().getFullYear() + 3, cvc: '123' } }, { authorization: 'Bearer ' + pub });
    assert.equal(res.status, 200);
    return (await res.json()).id;
  };
  const session = async (id, role) => {
    const raw = Buffer.from(randomUUID().replaceAll('-', '')).toString('base64url');
    await mongo.db().collection('sessions').insertOne({
      _id: createHash('sha256').update(raw).digest('base64url'), sub: role, expiresAt: new Date(Date.now() + 60_000), workspaces: [{ id, role }],
    });
    return { cookie: 'sb_session=' + raw };
  };
  const acme = 'ws_acme', globex = 'ws_globex';
  const admin = await session(acme, 'admin');
  const agent = await session(acme, 'agent');
  assert.equal((await fetch(base + '/api/billing?workspace=' + acme)).status, 401);
  assert.equal((await fetch(base + '/api/billing?workspace=' + globex, { headers: admin })).status, 403);
  assert.equal((await fetch(base + '/api/billing?workspace=' + acme, { headers: agent })).status, 403);
  assert.equal((await post(base + '/api/billing/seats?workspace=' + acme, { seats: 2 }, agent)).status, 403);
  assert.equal((await post(base + '/__grader/billing/seats', { workspace: acme, seats: 2 })).status, 401);
  const visible = await (await fetch(base + '/api/billing?workspace=' + acme, { headers: admin })).json();
  assert.equal(visible.status, 'none');
  assert.equal(visible.publishable_key, pub);
  assert.ok(!JSON.stringify(visible).includes('sk_test_'));

  const normalToken = await tokenize('4242424242424242');
  const duplicates = await Promise.all([base, 'http://127.0.0.1:' + peerPort, base]
    .map(origin => bill('subscribe', acme, 3, normalToken, origin)));
  assert.deepEqual(duplicates.map(res => res.status), [200, 200, 200]);
  assert.equal((await bill('seats', acme, 5)).status, 200);
  assert.equal((await bill('seats', acme, 2)).status, 200);
  const acmeRecord = (await report()).customers.find(c => c.workspace === acme);
  assert.equal(acmeRecord.subscriptions.length, 1);
  assert.equal(acmeRecord.subscriptions[0].quantity, 2);
  assert.equal(acmeRecord.subscriptions[0].invoices.find(i => i.reason === 'subscription_create').amount_due, 3600);
  assert.ok(acmeRecord.subscriptions[0].invoices.some(i => i.reason === 'proration' && i.status === 'paid'));
  assert.ok(acmeRecord.credit_balance > 0);

  const requiresAction = await bill('subscribe', globex, 1, await tokenize('4000002500003155'));
  assert.equal(requiresAction.status, 402);
  const approval = (await requiresAction.json()).approval_url;
  assert.match(approval, /authenticate/);
  assert.equal((await post(approval, { outcome: 'fail' })).status, 200);
  await eventual(async () => (await mongo.db().collection('billing_accounts').findOne({ _id: globex }))?.approvalUrl === '');
  assert.equal((await bill('subscribe', globex, 1, await tokenize('4000000000000341'))).status, 200);
  assert.equal((await bill('seats', globex, 2)).status, 402);
  assert.equal((await snapshot())[globex].billing.seats, 1);

  const advance = async days => assert.equal((await post(provider + '/v1/test_clock/advance', { days })).status, 200);
  await advance(31);
  await eventual(async () => (await snapshot())[globex].billing.status === 'past_due');
  assert.equal((await snapshot())[globex].billing.can_send, true);
  await advance(5);
  await eventual(async () => (await snapshot())[globex].billing.status === 'canceled');
  const forged = await (await post(provider + '/__admin/forge', { workspace: globex })).json();
  assert.equal(forged.delivered, 401);
  const canceledCustomer = (await report()).customers.find(c => c.workspace === globex);
  const old = JSON.stringify({ id: 'late-event', type: 'customer.subscription.updated', data: { object: { customer: canceledCustomer.id, status: 'active' } } });
  const t0 = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(t0 + '.' + old).digest('hex');
  const duplicate = () => fetch(base + '/webhooks/paybox', { method: 'POST', headers: { ...headers, 'x-paybox-signature': 't=' + t0 + ',v1=' + signature }, body: old });
  assert.equal((await duplicate()).status, 204);
  assert.equal((await duplicate()).status, 204);
  await eventual(async () => (await mongo.db().collection('billing_webhooks').findOne({ _id: 'late-event' }))?.done);
  assert.equal((await snapshot())[globex].billing.status, 'canceled');
  const send = workspace => post(base + '/__grader/reply', { workspace, contact: '+14155550101', text: 'Billing enforcement', client_ref: 'billing-send-' + workspace }, grader);
  assert.equal((await send(globex)).status, 402);
  assert.equal((await send(acme)).status, 202);
  assert.equal(await mongo.db().collection('replies').countDocuments({ workspace: globex }), 0);
  const resume = await bill('subscribe', globex, 1, await tokenize('4000002500003155'));
  assert.equal(resume.status, 402);
  const resumeApproval = (await resume.json()).approval_url;
  assert.equal((await post(resumeApproval, { outcome: 'approve' })).status, 200);
  await eventual(async () => (await snapshot())[globex].billing.status === 'active');
  assert.equal((await send(globex)).status, 202);
  const result = await report();
  assert.deepEqual(result.flags, { rawCardViaSecretKey: 0, postsWithoutIdempotencyKey: 0 });
  assert.equal(result.customers.length, 2);
});
