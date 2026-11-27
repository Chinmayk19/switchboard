# Private conversation notes protocol

## Trust and keys

Notes use AES-256-GCM via browser Web Crypto with a fresh random 96-bit IV and a 128-bit authentication tag for every note. A workspace admin generates a random 256-bit workspace note key in the browser. The browser displays a versioned share code once, containing the raw key and its workspace-bound identifier. The identifier is the first 128 bits of SHA-256 over a domain label, version, workspace ID and encoded key. It is public and helps select the right key.

The admin saves the code in an approved secrets manager and shares it with each authorized workspace member through an authenticated, encrypted channel outside Switchboard. Verify the recipient against the workspace roster before sharing. Each member imports the code in each browser and account they use. The client recomputes the identifier for the selected workspace before importing the key as a non-extractable CryptoKey. The most recently imported or generated key is active for writing. Agents can choose the active key from the key settings, for example to resume using the current key after importing a historical key. Older keys remain available for reading their existing notes. The keyring is stored in IndexedDB under the signed-in user and workspace. Logout clears the live UI state. Browser-stored keys remain for the next login with that account.

There is no key endpoint. Neither key generation nor import sends the share code or private key to Switchboard. No server or service account receives workspace note keys. Serve the client via HTTPS, or use the browser's trusted localhost context for development.

## Note storage and reading

The client encrypts note text before constructing the HTTP request. AES-GCM authenticates the protocol domain and version, workspace, conversation contact, author ID, note ID, and key ID as additional authenticated data. The server derives workspace and author from the authorized route and authenticated session. It stores an opaque envelope with the note ID, version, key ID, IV, and ciphertext, plus workspace, conversation, author, and creation time. Web Crypto appends the authentication tag to the ciphertext before base64url encoding. The server accepts that envelope shape and stores notes in a dedicated collection. Customer message history and the outbound queue exclude private notes. Realtime notifications carry the workspace feed sequence, contact, and change type.

To read a note, a workspace member's browser fetches the envelope, finds the matching key ID in its IndexedDB keyring, and recomputes the authenticated context using the current conversation and the returned author. AES-GCM must authenticate before any plaintext is shown. A missing key produces a locked note. Authentication failure produces an error without displaying content. An exact retry of a stored envelope is idempotent.

## Membership changes and recovery

Workspace access controls govern who can fetch stored ciphertext. The cryptographic boundary also depends on who received each key. A removed agent may still have saved keys and ciphertext, so removing API access cannot revoke decryption of material already obtained. After changing membership, a workspace admin should generate a replacement key and distribute it only to remaining authorized members before new sensitive notes are written. Each browser must import the replacement. Switchboard cannot enforce synchronized rotation because key distribution is off-platform. Membership claims in an existing session can remain valid until the session expires or is revoked.

A new member gets the current key through the approved channel. Share older keys only if the member is allowed to read that history. Notes written with the same key cannot be shared selectively. There is no server-side recovery or escrow. An authorized custodian must retain each share code for recovery on new devices. Loss of all copies of a key makes the affected history unreadable. Browser storage can be evicted or erased.

## Attacks outside the protocol

- A compromised browser, malicious extension, XSS, or compromised client build can access plaintext and use browser-held keys. A server that changes the JavaScript it serves could also steal keys or plaintext. The claim covers a server that runs the reviewed client and observes requests or stored data.
- An authorized agent can copy plaintext, disclose a share code, or forge another author's authenticated context with the shared key. Server-side author assignment prevents ordinary API impersonation. Group cryptography does not provide independent proof of authorship.
- A compromised sharing channel, secrets manager, or device can expose keys. Rotation protects future notes once writers switch keys and cannot undo prior disclosure. The scheme provides no forward secrecy.
- The server can observe note metadata, ciphertext length, access patterns, and timing, and it can suppress, reorder, or delete notes. The protocol provides content confidentiality and tamper detection, not availability or metadata privacy.
