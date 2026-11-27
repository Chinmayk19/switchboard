# Switchboard implementation audit

This is a review of the written contract in BRIEF.md, PIGEON.md, and REFERENCE.pdf. The private level 4 checker was unavailable. The checklist is evidence from the public checker, the focused integration suite, and code review.

## Pigeon webhook rules

| Written rule | Final status | Evidence |
| --- | --- | --- |
| POST to /webhooks/pigeon with the documented signature and event ID headers | Satisfied | The route verifies the HMAC over the timestamp and exact received bytes, then checks the event header against the signed ID for handled types. |
| Missing, malformed, or wrong signature returns 401 | Satisfied | Focused tests cover missing and malformed headers, false MACs, and signatures over different bytes. Signature verification runs ahead of body format handling. |
| A signature more than five minutes old returns 401 | Satisfied | Focused test at 301 seconds and public checker. Excessive future clock skew is also rejected. |
| A valid signature up to five minutes old is genuine | Satisfied | Focused tests near the cutoff at 299 seconds; comparison is inclusive at 300 seconds. |
| A genuine event is durably stored or already recorded before 2xx, within five seconds | Satisfied | Journaled MongoDB writes, level 1 acknowledgement check, and level 2 crash run. The HTTP body limit applies to signed bodies larger than 1 MiB. |
| A valid signature with an unknown event type returns 2xx | Satisfied | Focused integration test. |
| A status for an unknown provider message returns 2xx and does not change a reply | Satisfied | Focused integration tests, including an unrelated provider ID reusing an existing client reference and a status with no client reference. Early status is held until the carrier confirms the provider ID. |
| A signed body that cannot be parsed returns 400 | Satisfied | Focused tests for malformed JSON, invalid UTF-8, and signed compressed bytes. |
| A valid event for an unknown workspace returns 2xx and is ignored | Satisfied | Focused integration test. |
| Duplicate delivery and out-of-order inbound/status messages are handled | Satisfied | Workspace-scoped event and message keys, timestamp/message-ID ordering, terminal status guards, and focused tests for early and delayed callbacks. |
| Bursts, retransmission, and short application outages do not lose acknowledged work | Satisfied | Public levels 1–3. Recovery of events sent during longer downtime is bounded by Pigeon's retry window. |

## Pigeon outbound and BRIEF.md contracts

| Written rule | Final status | Evidence |
| --- | --- | --- |
| Send POST /v1/messages with the workspace Bearer key, recipient, text, and original client reference | Satisfied | Outbox request and public send checks. |
| Use a stable provider idempotency key | Satisfied | The persisted reply ID is reused, including after a killed worker. The reference provider forgets those keys on its own reset or restart. |
| Share workspace rate limits and honor Retry-After | Satisfied | Shared workspace send gate and public level 3. The outbox conservatively spaces sends instead of consuming the initial burst allowance. |
| Handle slow success, intermittent 503 and outages | Satisfied | Request deadlines, persisted retry times, focused ambiguous-acceptance crash test, and public outage checks. |
| A and B. Repository manifest, configured port and dependencies, readiness health check | Satisfied | Unchanged public checker starts the manifest on dynamically assigned ports. Readiness requires MongoDB and its startup indexes. |
| C. Webhook path | Satisfied | Covered above. |
| D. Missing or wrong grader token returns 401 | Satisfied | Explicit token configuration, constant-time equal-length comparison, and focused checks. Grader responses are marked no-store. |
| D. Reset returns 200 and deletes application data, with sessions allowed to remain | Satisfied | Focused test checks workspace data and events. Redis holds no application data. The feed retains only sequence watermarks so existing sockets can continue after reset. |
| D. Reset concurrent with live ingress and provider sends | Unverified | The contract describes reset between checker phases. It is a maintenance operation across multiple collections and cannot cancel an HTTP send already in flight. |
| D. Snapshot groups inbound by tenant/contact in chronological order and includes assignee and outbound status | Satisfied | Public levels 1–3 and focused reset coverage. |
| D. Reply returns 202 after durable acceptance, is idempotent under concurrency, creates a reply-only conversation, and rejects unknown workspaces | Satisfied | Journaled upsert, workspace/client-ref unique index, conversation union query, and focused/public tests. |
| D. Claim permits an opaque agent ID, creates a conversation when needed, returns 200 for that holder and 409 for competing holders | Satisfied | Atomic indexed claim and focused/public concurrency tests. Grader and agent API share the same operation. |
| E. OIDC login and callback, authenticated /api/me shape and anonymous 401, conversation membership checks | Satisfied | Public level 5 and inspection of the explicit workspace predicate on all conversation reads and mutations. |
| F. WebSocket authenticates with the session cookie and rejects other workspaces | Satisfied | Level 5 and focused logout and tenant mutation checks. WebSockets recheck authorization on delivery and on idle heartbeat. |
| F. Monotonic per-workspace sequence, durable replay and multi-instance live delivery | Satisfied | Level 5 and focused tests for an abandoned sequence reservation and a live cursor crossing an administrative reset. |
| Product workflows. Paginated inbox and history, claim, close and reopen, reply status, and automatic reconnection | Satisfied by implementation review | Vite build and backend integration coverage. Browser interaction and accessibility were not retested in this audit. |

## Findings and fixes

The baseline violated the signature-response rule for encoded malformed requests and the replay continuity rule for a cursor carried across reset. The fixes below close those cases. Concurrent ingress during a grader reset remains unverified.

- The body parser could return 415 before signature validation. The webhook now hashes the original request stream and checks the MAC before parsing. It bounds buffered bytes to 1 MiB.
- The known development grader token was previously active by default. An explicit GRADER_TOKEN now enables grader access. The checker supplies it, and .env.example documents the local value.
- Driver objects can contain customer data. HTTP, outbox, feed, and WebSocket failure logs now record the operation and numeric error code.
- Reset previously reset sequence numbers and could strand connected clients at an old cursor. Reset now removes event payloads, invalidates pending reservations, and preserves the monotonically increasing cursor watermark. Projectors confirm a source change still exists before reserving it.
- The projector used to scan all source rows for pending work. Partial indexes now restrict those polls to documents with pending events.
- The outbox now checks its remaining lease budget before dispatch, while preserving the stable send key and existing attempt fencing.
- The inbox now starts from the current feed cursor and replays missed changes on reconnect. It preserves the open conversation and draft when that conversation drops out of the refreshed first page, and returns to sign-in when the socket reports session revocation.

## Remaining limitations and follow-up

- Use deployment-specific secrets, HTTPS, and restrict grader routes or leave GRADER_TOKEN unset outside testing. Mock provider defaults are deliberately published in the assessment.
- For larger datasets, add a materialized inbox summary and a bounded replay retention policy with explicit client resynchronization. Conversation and history queries still aggregate across collections; socket delivery polls MongoDB.
- Validate browser keyboard and responsive flows and add a browser automation case for logout, expired sessions, and reconnecting with an open draft. A very late inbound message outside the loaded history slice may require loading that slice again.
- Treat reset as a maintenance operation. Exact-once sends depend on Pigeon retaining its idempotency keys, and lease timing assumes hosts have closely aligned clocks.
