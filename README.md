# Switchboard

Switchboard is a shared customer-support inbox. Support teams can read and reply to customer messages, claim and close conversations, and collaborate through private notes. One deployment serves multiple workspaces with separate data and permissions.

## What it includes

- OIDC sign-in with PKCE, shared sessions, workspace selection, and logout.
- A paginated inbox, ordered message history, atomic claims, close and reopen, and outbound delivery status.
- Signed Pigeon webhooks, durable reply processing, and WebSocket updates with replay after reconnect.
- Browser-encrypted private notes and optional admin-only Paybox billing.

The backend uses Node.js, TypeScript, Express, MongoDB, and ws. The frontend uses React, TypeScript, Vite, and browser Web Crypto. Docker Compose starts MongoDB, Redis, and the Pigeon, IdP, and Paybox simulators. Application state lives in MongoDB.

## Run from a clean clone

Install Git, Node.js **22.12 or later in the 22.x line**, npm, and Docker with the Compose plugin. Run these commands from a terminal with Docker running.

```sh
git clone REPOSITORY_URL switchboard
cd switchboard
cp .env.example .env
npm run up
npm run scaffold:install
```

In PowerShell, `Copy-Item .env.example .env` is equivalent to the copy command. `npm run up` runs `docker compose up -d` and checks the service ports. Run `npm run doctor` to diagnose connectivity.

Open two terminals at the repository root.

```sh
npm run scaffold:server
```

```sh
npm run scaffold:web
```

Open **http://localhost:5173**. The backend serves **http://localhost:4000**, with readiness at `/healthz`. Use `http://localhost` consistently for the browser and mock IdP. To start the backend without watch mode, run `npm run start:server`. Run `npm run inbound` to generate an incoming customer message.

### Test accounts

Select **Sign in** and click an account in the mock IdP. The simulator uses a user picker without passwords. Use **Logout** in the header profile menu before switching accounts.

| Account | IdP subject | Workspace access |
| --- | --- | --- |
| Asha Rao | `u_asha` | Acme admin |
| Ben Ortiz | `u_ben` | Acme agent |
| Chloe Martin | `u_chloe` | Globex admin |
| Dev Patel | `u_dev` | Globex agent |
| Eli Novak | `u_eli` | Acme and Globex agent |

### Configuration

The root `.env.example` lists local values. Keep `.env` out of Git. The sample credentials are for the provided simulators.

| Variables | Purpose |
| --- | --- |
| `PORT`, `WEB_ORIGIN` | Backend port and browser origin. Vite proxies API, auth, health, and WebSocket requests. |
| `MONGO_URL` | MongoDB database. The Compose Redis service is available at `REDIS_URL`, while the application persists its shared state in MongoDB. |
| `OIDC_*` | Issuer, client credentials, and callback. The callback must match a URI registered with the mock IdP. |
| `PIGEON_*` | Messaging URL, per-workspace keys, signing secret, and optional Compose callback target. |
| `PAYBOX_*` | Payment URL, publishable and secret keys, signing secret, and optional Compose callback target. The browser must be able to reach `PAYBOX_URL`. |
| `GRADER_TOKEN` | Enables grader routes when set. The checker injects its own token. Leave this unset outside testing. |

If you change the backend port, point the simulator webhook targets and registered OIDC callback at the correct endpoint. The default Docker targets use `host.docker.internal:4000`. The application server uses the port supplied by the checker.

## Architecture

1. **Inbound** — Pigeon sends a signed webhook. The server verifies the exact body and timestamp, then journals the workspace-scoped message in MongoDB before acknowledging it. Indexed event and message IDs deduplicate delivery.
2. **Outbound** — A reply is durably queued before acceptance. Workers use a shared per-workspace lease, persistent provider idempotency keys, and retries that honor `Retry-After`. Pigeon callbacks advance delivery status.
3. **Realtime** — Durable changes are projected into a per-workspace sequence. Authenticated WebSocket clients use the same ordered cursor for replay and live delivery, even when another instance processed the change.
4. **Isolation** — Shared MongoDB sessions carry the verified IdP workspace claims. API and WebSocket authorization check membership on the server. Billing additionally requires the admin role.

## Private notes

Open a conversation and select **Private notes**. A workspace admin creates a key under **Workspace note keys**, stores the share code in an approved secrets manager, and shares it with authorized agents through a trusted channel outside Switchboard. Agents import the code in each browser they use. The browser encrypts notes before upload, and Pigeon receives only customer replies.

A locked note requires the key used when it was written. Notes work on localhost or HTTPS. See [PROTOCOL.md](PROTOCOL.md) for key custody, rotation, recovery, and the threat model.

## Paybox billing

Sign in as a workspace admin and select **Billing**. Enter the seat count and a **Paybox test card** from [PAYBOX.md](PAYBOX.md). For example, the simulator accepts `4242 4242 4242 4242` with a future expiry and a three-digit test CVC. The browser sends the card directly to Paybox and sends only the token to Switchboard. Follow the Paybox approval link if prompted.

Use **Update seats** on an existing subscription. Paybox prorates increases and credits decreases on the next invoice. Canceled accounts can read their inbox and cannot send replies. The test clock and renewal scenarios are documented in [PAYBOX.md](PAYBOX.md).

## Checks and tests

Run the official checker in **Linux or a Linux dev container**. Its crash phases use POSIX process-group termination. Stop the backend first and use disposable data because the checker resets application state.

```sh
npm run check                       # Level 1
npm run check -- --levels 2,3,5      # Selected public levels
npm run check:full                  # Levels 1, 2, 3, and 5, writes CHECK_REPORT.json
```

The saved [public report](CHECK_REPORT.json) records **75/75**. The private level 4 checker and an official bonus checker were unavailable.

With MongoDB running, run the automated tests and builds from the repository root. The tests create disposable databases and launch their own application and test-provider processes.

```sh
node --experimental-strip-types --test scaffold/server/test/billing.test.mjs scaffold/server/test/reliability.test.mjs
npm --prefix scaffold/server run typecheck
npm --prefix scaffold/web run typecheck
npm --prefix scaffold/web run build
```

See [DECISIONS.md](DECISIONS.md) for trade-offs and [AUDIT.md](AUDIT.md) for the written-rule review.
