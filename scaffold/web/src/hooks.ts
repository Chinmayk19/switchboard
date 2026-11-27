import { useEffect, useRef, useState } from 'react';
import { request, messageOf, type FeedEvent, type Page } from './api';

export function useFeed(workspace: string, onEvent: (event: FeedEvent) => void, onConnect: () => void, onSessionEnded: () => void) {
  const [live, setLive] = useState(false);
  const listeners = useRef({ onEvent, onConnect, onSessionEnded });
  listeners.current = { onEvent, onConnect, onSessionEnded };

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let reconnect: number | undefined;
    let cursor: number | undefined;
    let delay = 500;

    function connect() {
      const url = new URL('/ws', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('workspace', workspace);
      if (cursor !== undefined) url.searchParams.set('after', String(cursor));
      const connection = new WebSocket(url);
      socket = connection;
      connection.onopen = () => {
        if (stopped) return;
        setLive(true);
        delay = 500;
        listeners.current.onConnect();
      };
      connection.onmessage = message => {
        if (stopped) return;
        const event: FeedEvent | { type: 'feed.ready'; cursor: number } = JSON.parse(message.data);
        if ('cursor' in event) {
          cursor ??= event.cursor;
        } else if (event.seq > (cursor ?? 0)) {
          cursor = event.seq;
          listeners.current.onEvent(event);
        }
      };
      connection.onclose = event => {
        if (stopped) return;
        setLive(false);
        if (event.code === 1008 && event.reason === 'Session ended') {
          listeners.current.onSessionEnded();
          return;
        }
        reconnect = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10_000);
      };
      connection.onerror = () => connection.close();
    }

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(reconnect);
      socket?.close();
    };
  }, [workspace]);

  return live;
}

export function usePages<T>(path: string, revision: number, keyOf: (item: T) => string) {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const loadedMore = useRef(false);
  const more = useRef<AbortController | null>(null);
  useEffect(() => () => more.current?.abort(), []);

  useEffect(() => {
    const abort = new AbortController();
    void request<Page<T>>(path, { signal: abort.signal }).then(page => {
      if (abort.signal.aborted) return;
      setItems(previous => {
        if (!loadedMore.current) return page.items;
        const freshKeys = new Set(page.items.map(keyOf));
        return [...page.items, ...previous.filter(item => !freshKeys.has(keyOf(item)))];
      });
      if (!loadedMore.current) setNext(page.next);
      setError('');
      setReady(true);
    }).catch(error => {
      if (!abort.signal.aborted) setError(messageOf(error));
    });
    return () => abort.abort();
  }, [path, revision, keyOf]);

  async function loadMore() {
    if (!next || more.current) return;
    const abort = new AbortController();
    more.current = abort;
    setLoadingMore(true);
    try {
      const params = new URL(path, location.href);
      params.searchParams.set('after', next);
      const page = await request<Page<T>>(params.pathname + params.search, { signal: abort.signal });
      if (abort.signal.aborted) return;
      loadedMore.current = true;
      setItems(previous => {
        const existing = new Set(previous.map(keyOf));
        return [...previous, ...page.items.filter(item => !existing.has(keyOf(item)))];
      });
      setNext(page.next);
      setError('');
    } catch (error) {
      if (!abort.signal.aborted) setError(messageOf(error));
    } finally {
      more.current = null;
      if (!abort.signal.aborted) setLoadingMore(false);
    }
  }

  return { items, setItems, ready, error, next, loadMore, loadingMore };
}
