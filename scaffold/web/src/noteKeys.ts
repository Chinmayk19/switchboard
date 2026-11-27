import type { NoteKey } from './noteCrypto';

export interface Keyring {
  keys: NoteKey[];
  active?: string;
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('switchboard-note-keys', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keyrings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Key storage is blocked in this browser.'));
  });
}

export async function keyringFor(agent: string, workspace: string, add?: NoteKey): Promise<Keyring> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('keyrings', add ? 'readwrite' : 'readonly');
      const store = tx.objectStore('keyrings');
      const scope = JSON.stringify([agent, workspace]);
      const request = store.get(scope);
      let ring: Keyring;
      request.onsuccess = () => {
        ring = request.result ?? { keys: [] };
        if (add) {
          ring = { keys: [...ring.keys.filter(key => key.id !== add.id), add], active: add.id };
          store.put(ring, scope);
        }
      };
      tx.oncomplete = () => resolve(ring);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
