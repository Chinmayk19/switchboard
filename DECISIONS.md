# Billing decisions

- A workspace can send before subscribing and while Paybox reports an incomplete or past-due subscription. Sending stops at cancellation, including expiration of an incomplete subscription. Past-due access lasts through Paybox's renewal retry schedule. The inbox stays readable, and any previously accepted unsent replies wait until the workspace can send again.
- Seats are a purchased quantity. Reducing the quantity does not remove IdP members or revoke their workspace access. The simulator has no seat assignment or provisioning protocol.
- The UI explains that a seat increase is charged pro rata immediately and that a decrease credits the next invoice. Switchboard leaves balances and proration calculations to Paybox.
- A payment waiting for bank approval shows a Paybox link and continues polling billing status. The UI uses reconciled provider state to confirm success. A declined initial payment can be retried with a new card token.
- Billing operations are serialized per workspace in MongoDB. A persisted operation ID supplies idempotency keys for Paybox writes, and a worker resumes interrupted operations after the lease expires. Signed webhooks are durably deduplicated and trigger a read of current Paybox state. Periodic reads cover missed callbacks. The browser tokenizes test cards directly with the publishable key.
