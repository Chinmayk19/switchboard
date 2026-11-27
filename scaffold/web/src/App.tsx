import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, endpoint, messageOf, request, type Conversation, type FeedEvent, type Identity, type Message } from './api';
import { useFeed, usePages } from './hooks';
import './styles.css';

const contactKey = (item: Conversation) => item.contact;
const messageKey = (item: Message) => item.id;
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const calendar = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const workspaceName = (id: string) => ({ ws_acme: 'Acme', ws_globex: 'Globex' })[id] ?? id;
const agentName = (id: string) => id.replace(/^u_/, '').split(/[_-]/).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
function formatDate(value: string) {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString() ? clock.format(date) : calendar.format(date);
}
const isFinal = (status: Message['status']) => status === 'delivered' || status === 'failed';

function Brand() {
  return <div className="brand"><span className="brand-mark" aria-hidden="true">S</span><span>Switchboard<small>Support inbox</small></span></div>;
}

function Profile({ name, busy, error, onLogout }: {
  name: string;
  busy: boolean;
  error: string;
  onLogout: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  return (
    <details className="profile" ref={menu} onKeyDown={event => {
      if (event.key !== 'Escape' || !menu.current?.open) return;
      menu.current.open = false;
      menu.current.querySelector('summary')?.focus();
    }}>
      <summary aria-label={name + ' profile'}>
        <span className="agent-avatar" aria-hidden="true">{name.charAt(0)}</span>
        <span className="account-name">{name}</span>
      </summary>
      <div className="profile-panel">
        {error && <p role="alert">{error}</p>}
        <button type="button" disabled={busy} onClick={onLogout}>{busy ? 'Logging out…' : 'Logout'}</button>
      </div>
    </details>
  );
}

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [workspace, setWorkspace] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const user = await request<Identity>('/api/me', { signal });
      if (signal?.aborted) return;
      setIdentity(user);
      setWorkspace(user.workspaces[0]?.id ?? '');
    } catch (error) {
      if (!signal?.aborted && !(error instanceof ApiError && error.status === 401)) setError(messageOf(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);

  async function logout() {
    setLoggingOut(true);
    setLogoutError('');
    try {
      await request('/auth/logout', { method: 'POST' });
      // Unmounting Inbox closes its socket and discards workspace data and drafts.
      setWorkspace('');
      setIdentity(null);
    } catch (error) {
      setLogoutError(messageOf(error));
    } finally {
      setLoggingOut(false);
    }
  }

  if (!identity || !workspace) return (
    <main className="welcome">
      <section className="welcome-card">
        <Brand />
        <h1>{identity ? 'No workspace access' : 'Your team inbox'}</h1>
        {loading ? <p role="status">Checking your session...</p> : error ? <>
          <p role="alert">{error}</p><button className="primary" onClick={() => void load()}>Try again</button>
        </> : <>
          <p>{identity ? 'Sign in with an account that belongs to a workspace.' : 'Sign in to read and reply to customer messages.'}</p>
          {identity ? <>
            {logoutError && <p role="alert">{logoutError}</p>}
            <button className="primary" disabled={loggingOut} onClick={logout}>{loggingOut ? 'Logging out…' : 'Logout'}</button>
          </> : <a className="primary" href="/auth/login">Sign in</a>}
        </>}
      </section>
    </main>
  );

  return (
    <main className="shell">
      <header className="topbar">
        <Brand />
        <div className="account">
          <label className="workspace-control">
            Workspace
            <select value={workspace} onChange={event => setWorkspace(event.target.value)}>
              {identity.workspaces.map(({ id }) => <option key={id} value={id}>{workspaceName(id)}</option>)}
            </select>
          </label>
          <Profile name={agentName(identity.sub)} busy={loggingOut} error={logoutError} onLogout={logout} />
        </div>
      </header>
      <Inbox key={workspace} workspace={workspace} agent={identity.sub} />
    </main>
  );
}

function Inbox({ workspace, agent }: { workspace: string; agent: string }) {
  const [selected, setSelected] = useState('');
  const [revision, setRevision] = useState(0);
  const [messageStatuses, setMessageStatuses] = useState<Record<string, Message['status']>>({});
  const refreshTimer = useRef<number | undefined>(undefined);
  const conversations = usePages(endpoint(workspace), revision, contactKey);

  function refresh() {
    if (refreshTimer.current !== undefined) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = undefined;
      setRevision(value => value + 1);
    }, 120);
  }
  useEffect(() => () => window.clearTimeout(refreshTimer.current), []);

  function incoming(event: FeedEvent) {
    if (event.client_ref !== undefined && event.status) {
      const key = 'out:' + event.client_ref;
      setMessageStatuses(previous => ({ ...previous, [key]: event.status }));
    }
    if (event.assignee !== undefined || event.closed !== undefined) {
      conversations.setItems(previous => previous.map(item => item.contact === event.contact ? {
        ...item, assignee: event.assignee ?? item.assignee, closed: event.closed ?? item.closed,
      } : item));
    }
    refresh();
  }
  const live = useFeed(workspace, incoming, refresh);
  const conversation = conversations.items.find(item => item.contact === selected);
  return (
    <div className={'inbox-layout' + (conversation ? ' has-selection' : '')}>
      <aside className="sidebar">
        <div className="sidebar-heading">
          <div><h1>Inbox</h1><p>{workspaceName(workspace)} conversations</p></div>
          <span className={'connection ' + (live ? 'online' : '')} role="status"><i />{live ? 'Live' : 'Connecting'}</span>
        </div>
        <div className="sidebar-list">
          {conversations.error && <div className="notice" role="alert">{conversations.error} <button onClick={refresh}>Retry</button></div>}
          {!conversations.ready && !conversations.error && <p className="notice" role="status">Loading conversations...</p>}
          {conversations.ready && conversations.items.length === 0 && <p className="notice">No conversations yet. New customer messages will appear here.</p>}
          <ul aria-label="Conversations">
            {conversations.items.map(item => (
              <li key={item.contact}>
                <button className={'conversation-row' + (item.contact === selected ? ' selected' : '')} aria-current={item.contact === selected ? 'true' : undefined} onClick={() => setSelected(item.contact)}>
                  <span className="contact-avatar" aria-hidden="true">{item.contact.slice(-2)}</span>
                  <span className="row-information">
                    <strong>{item.contact}</strong>
                    <span>{item.closed ? 'Closed' : item.assignee ? agentName(item.assignee) : 'Unassigned'}</span>
                  </span>
                  <time dateTime={item.lastActivity}>{formatDate(item.lastActivity)}</time>
                </button>
              </li>
            ))}
          </ul>
          {conversations.next && <button className="load-more" disabled={conversations.loadingMore} onClick={conversations.loadMore}>{conversations.loadingMore ? 'Loading...' : 'More conversations'}</button>}
        </div>
      </aside>
      {conversation ? <Thread key={conversation.contact} {...{ workspace, agent, conversation, revision, messageStatuses, refresh }} onBack={() => setSelected('')}
        onUpdate={patch => conversations.setItems(previous => previous.map(item => item.contact === conversation.contact ? { ...item, ...patch } : item))} />
        : <section className="empty-thread"><div className="empty-icon" aria-hidden="true">···</div><h2>Select a conversation</h2><p>Read the history and reply to customers from here.</p></section>}
    </div>
  );
}

interface ThreadProps {
  workspace: string;
  agent: string;
  conversation: Conversation;
  revision: number;
  messageStatuses: Record<string, Message['status']>;
  refresh: () => void;
  onBack: () => void;
  onUpdate: (patch: Partial<Conversation>) => void;
}

function Thread({ workspace, agent, conversation, revision, messageStatuses, refresh, onBack, onUpdate }: ThreadProps) {
  const suffix = '/' + encodeURIComponent(conversation.contact);
  const history = usePages(endpoint(workspace, suffix + '/messages'), revision, messageKey);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');
  const retry = useRef<{ text: string; ref: string } | undefined>(undefined);
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const preserve = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!scroll.current) return;
    if (preserve.current !== undefined && !history.loadingMore) {
      scroll.current.scrollTop += scroll.current.scrollHeight - preserve.current;
      preserve.current = undefined;
    } else if (stick.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [history.items, history.loadingMore]);

  async function action(name: 'claim' | 'close' | 'reopen') {
    setActing(true);
    setError('');
    try {
      await request(endpoint(workspace, suffix + '/' + name), { method: 'POST' });
      onUpdate(name === 'claim' ? { assignee: agent } : { closed: name === 'close' });
      refresh();
    } catch (error) { setError(messageOf(error)); refresh(); }
    finally { setActing(false); }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    if (retry.current?.text !== text) retry.current = { text, ref: crypto.randomUUID() };
    setSending(true);
    setError('');
    try {
      await request(endpoint(workspace, suffix + '/reply'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, client_ref: retry.current.ref }),
      });
      retry.current = undefined;
      stick.current = true;
      setDraft('');
      refresh();
    } catch (error) { setError(messageOf(error)); }
    finally { setSending(false); }
  }

  return <section className="thread" aria-label="Selected conversation">
    <header className="thread-heading">
      <button className="mobile-back" onClick={onBack}>Inbox</button>
      <div>
        <h2>{conversation.contact}</h2>
        <p>{conversation.closed ? 'Closed' : 'Open'} <span aria-hidden="true">·</span> {conversation.assignee ? 'Assigned to ' + agentName(conversation.assignee) : 'Unassigned'}</p>
      </div>
      <div className="thread-actions">
        {!conversation.assignee && <button disabled={acting} onClick={() => action('claim')}>Claim</button>}
        <button disabled={acting} onClick={() => action(conversation.closed ? 'reopen' : 'close')}>{conversation.closed ? 'Reopen' : 'Close'}</button>
      </div>
    </header>
    <div className="thread-scroll" ref={scroll} onScroll={() => {
      const node = scroll.current;
      if (node) stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    }}>
      {history.error && <p className="notice" role="alert">{history.error} <button onClick={refresh}>Retry</button></p>}
      {!history.ready && !history.error && <p className="notice" role="status">Loading messages...</p>}
      {history.ready && history.items.length === 0 && <p className="notice">No messages in this conversation yet.</p>}
      {history.next && <button className="load-more" disabled={history.loadingMore} onClick={() => {
        preserve.current = scroll.current?.scrollHeight;
        void history.loadMore();
      }}>{history.loadingMore ? 'Loading...' : 'Load earlier messages'}</button>}
      <ol className="messages">
        {[...history.items].reverse().map(message => {
          const update = messageStatuses[message.id];
          const status = update && !isFinal(message.status) && update !== 'queued' ? update : message.status;
          return <li className={'message ' + message.direction} key={message.id}>
            <div className="bubble">{message.text}</div>
            <div className="message-meta"><time dateTime={message.at}>{formatDate(message.at)}</time>
              {status && <span className={'status ' + status}>{status}</span>}
            </div>
          </li>;
        })}
      </ol>
    </div>
    <form className="composer" onSubmit={send}>
      {error && <p className="notice" role="alert">{error}</p>}
      <label htmlFor="reply">Reply</label>
      <div className="compose-row">
        <textarea id="reply" placeholder="Write a message..." value={draft} disabled={sending} rows={2} maxLength={5000} onChange={event => setDraft(event.target.value)} />
        <button className="primary" disabled={sending || !draft.trim()}>{sending ? 'Sending...' : 'Send reply'}</button>
      </div>
    </form>
  </section>;
}
