export interface NoteEnvelope {
  id: string;
  version: 1;
  keyId: string;
  iv: string;
  ciphertext: string;
}

export interface NoteScope {
  workspace: string;
  contact: string;
  author: string;
}

export interface NoteKey {
  id: string;
  key: CryptoKey;
}

const utf8 = new TextEncoder();

const encode = (value: Uint8Array) => btoa(Array.from(value, byte => String.fromCharCode(byte)).join(''))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));

async function keyId(workspace: string, value: string) {
  const digest = await crypto.subtle.digest('SHA-256', utf8.encode(JSON.stringify(['switchboard-note-key', 1, workspace, value])));
  return encode(new Uint8Array(digest, 0, 16));
}

export async function makeShareCode(workspace: string) {
  const value = encode(crypto.getRandomValues(new Uint8Array(32)));
  return 'sb1.' + await keyId(workspace, value) + '.' + value;
}

export async function importShareCode(workspace: string, code: string): Promise<NoteKey> {
  const match = /^sb1\.([\w-]{22})\.([\w-]{43})$/.exec(code.trim());
  if (!match) throw new Error('Enter a valid workspace key code.');
  const [, id, value] = match;
  const raw = decode(value);
  try {
    if (encode(raw) !== value || id !== await keyId(workspace, value)) {
      throw new Error('This key code is invalid for the selected workspace.');
    }
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { id, key };
  } finally {
    raw.fill(0);
  }
}

function context(scope: NoteScope, note: Pick<NoteEnvelope, 'id' | 'keyId' | 'version'>) {
  return utf8.encode(JSON.stringify(['switchboard-private-note', note.version, scope.workspace, scope.contact, scope.author, note.id, note.keyId]));
}

export async function sealNote(text: string, scope: NoteScope, key: NoteKey): Promise<NoteEnvelope> {
  const plaintext = utf8.encode(text);
  if (!plaintext.length || plaintext.length > 10_000) throw new Error('Private notes must contain 1 to 10,000 UTF-8 bytes.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const note = { id: crypto.randomUUID(), version: 1 as const, keyId: key.id, iv: encode(iv) };
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(scope, note), tagLength: 128 }, key.key, plaintext);
  return { ...note, ciphertext: encode(new Uint8Array(ciphertext)) };
}

export async function openNote(note: NoteEnvelope, scope: NoteScope, key: NoteKey) {
  if (note.version !== 1 || note.keyId !== key.id) throw new Error('The note requires a different workspace key.');
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: decode(note.iv), additionalData: context(scope, note), tagLength: 128,
  }, key.key, decode(note.ciphertext));
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
}
