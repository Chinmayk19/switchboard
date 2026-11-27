import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError, endpoint, messageOf, request } from './api';
import { usePages } from './hooks';
import { importShareCode, makeShareCode, openNote, sealNote, type NoteEnvelope } from './noteCrypto';
import { keyringFor, type Keyring } from './noteKeys';

interface StoredNote extends NoteEnvelope {
  author: string;
  at: string;
}

interface Props {
  workspace: string;
  contact: string;
  agent: string;
  canGenerate: boolean;
  revision: number;
}

const noteKey = (note: StoredNote) => note.id;

export function PrivateNotes({ workspace, contact, agent, canGenerate, revision }: Props) {
  const path = endpoint(workspace, '/' + encodeURIComponent(contact) + '/notes');
  const [refresh, setRefresh] = useState(0);
  const page = usePages(path, revision + refresh, noteKey);
  const [ring, setRing] = useState<Keyring | null>(null);
  const [opened, setOpened] = useState<Record<string, string | false>>({});
  const [code, setCode] = useState('');
  const [share, setShare] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [keyError, setKeyError] = useState('');
  const retry = useRef<{ text: string; envelope: NoteEnvelope } | null>(null);
  const keys = useMemo(() => new Map(ring?.keys.map(key => [key.id, key])), [ring]);
  const active = ring?.active ? keys.get(ring.active) : undefined;

  useEffect(() => {
    let mounted = true;
    void keyringFor(agent, workspace).then(value => { if (mounted) setRing(value); })
      .catch(() => { if (mounted) setKeyError('This browser could not open private key storage.'); });
    return () => { mounted = false; };
  }, [agent, workspace]);

  useEffect(() => {
    let current = true;
    void Promise.all(page.items.map(async ({ author, ...note }) => {
      const key = keys.get(note.keyId);
      if (!key) return [note.id, false] as const;
      try {
        return [note.id, await openNote(note, { workspace, contact, author }, key)] as const;
      } catch {
        return [note.id, false] as const;
      }
    })).then(items => { if (current) setOpened(Object.fromEntries(items)); });
    return () => { current = false; };
  }, [contact, keys, page.items, workspace]);

  async function setup(generate: boolean) {
    setBusy(true);
    setKeyError('');
    try {
      if (!window.isSecureContext) throw new Error('Private notes require HTTPS or localhost.');
      const value = generate ? await makeShareCode(workspace) : code;
      const key = await importShareCode(workspace, value);
      setRing(await keyringFor(agent, workspace, key));
      setCode('');
      if (generate) setShare(value);
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : 'Could not save this workspace key.');
    } finally {
      setBusy(false);
    }
  }

  async function activate(id: string) {
    const key = keys.get(id);
    if (!key) return;
    setBusy(true);
    setKeyError('');
    try {
      setRing(await keyringFor(agent, workspace, key));
    } catch {
      setKeyError('Could not change the active workspace key.');
    } finally {
      setBusy(false);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!active || !text || busy) return;
    setBusy(true);
    setError('');
    try {
      if (retry.current?.text !== text || retry.current.envelope.keyId !== active.id) {
        retry.current = { text, envelope: await sealNote(text, { workspace, contact, author: agent }, active) };
      }
      await request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(retry.current.envelope),
      });
      retry.current = null;
      setDraft('');
      setRefresh(value => value + 1);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        retry.current = null;
        setError('This note ID has already been used. Save again to retry.');
      } else {
        setError(error instanceof Error && error.message.startsWith('Private notes')
          ? error.message : messageOf(error));
      }
    } finally {
      setBusy(false);
    }
  }

  return <div className="private-notes">
    <p className="private-note-banner">Private notes are encrypted in this browser and never sent to customers.</p>
    <details className="note-key-settings" open={!active || !!share || undefined}>
      <summary>Workspace note keys</summary>
      <p>Import a key code from your workspace admin using a trusted channel. The code can unlock private notes, so keep it out of replies.</p>
      <form className="note-key-form" onSubmit={event => { event.preventDefault(); void setup(false); }}>
        <label htmlFor="note-key-code">Workspace key code</label>
        <input id="note-key-code" type="password" value={code} onChange={event => setCode(event.target.value)} autoComplete="off" spellCheck={false} />
        <button type="submit" disabled={busy || !code.trim()}>Import key</button>
      </form>
      {ring && ring.keys.length > 1 && <label className="note-active-key">
        Key for new notes
        <select value={ring.active} disabled={busy} onChange={event => void activate(event.target.value)}>
          {ring.keys.map(key => <option key={key.id} value={key.id}>{key.id}</option>)}
        </select>
      </label>}
      {canGenerate && <button type="button" disabled={busy || !!share} onClick={() => void setup(true)}>
        {active ? 'Generate replacement key' : 'Generate workspace key'}
      </button>}
      {share && <div className="note-share">
        <label htmlFor="note-share-code">Save this code in your approved secrets manager, then share it securely with authorized agents.</label>
        <textarea id="note-share-code" value={share} readOnly rows={2} onFocus={event => event.target.select()} />
        <button type="button" onClick={() => setShare('')}>Hide code</button>
      </div>}
      {keyError && <p role="alert">{keyError}</p>}
    </details>
    <div className="note-history">
      {page.error && <p role="alert">{page.error} <button onClick={() => setRefresh(value => value + 1)}>Retry</button></p>}
      {!page.ready && !page.error && <p role="status">Loading private notes...</p>}
      {page.ready && page.items.length === 0 && <p>No private notes yet.</p>}
      {page.next && <button onClick={() => void page.loadMore()} disabled={page.loadingMore}>Load earlier notes</button>}
      <ol>
        {[...page.items].reverse().map(note => <li key={note.id}>
          <div className="note-meta"><strong>{note.author === agent ? 'You' : note.author}</strong>
            <time dateTime={note.at}>{new Date(note.at).toLocaleString()}</time></div>
          <p>{opened[note.id] || (keys.has(note.keyId)
            ? opened[note.id] === false ? 'This note could not be authenticated.' : 'Decrypting...'
            : 'Locked. Import the key used for this note.')}</p>
        </li>)}
      </ol>
    </div>
    <form className="composer" onSubmit={send}>
      <label htmlFor="private-note">Add a private note</label>
      {error && <p role="alert">{error}</p>}
      <div className="compose-row">
        <textarea id="private-note" value={draft} disabled={busy || !active} rows={2} maxLength={2500}
          placeholder={active ? 'Write a private note...' : 'Set up a workspace key to write notes.'}
          onChange={event => setDraft(event.target.value)} />
        <button className="primary" disabled={busy || !active || !draft.trim()}>Save private note</button>
      </div>
    </form>
  </div>;
}
