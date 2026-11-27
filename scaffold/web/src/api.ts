export interface Identity {
  sub: string;
  workspaces: { id: string; role: string }[];
}

export interface Conversation {
  contact: string;
  lastActivity: string;
  assignee: string | null;
  closed: boolean;
}

export interface Message {
  id: string;
  text: string;
  at: string;
  direction: 'inbound' | 'outbound';
  status?: 'queued' | 'sent' | 'delivered' | 'failed';
}

export interface FeedEvent {
  seq: number;
  type: string;
  contact: string;
  client_ref?: string;
  assignee?: string;
  closed?: boolean;
  status?: Message['status'];
}

export interface Page<T> { items: T[]; next: string | null }

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 401 ? 'Your session has expired. Sign in again.' :
      status === 403 ? 'You do not have access to this workspace.' :
      status === 409 ? 'Another agent has already claimed this conversation.' :
      'Switchboard could not complete the request. Try again.');
    this.status = status;
  }
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) throw new ApiError(response.status);
  if (response.headers.get('content-type')?.includes('application/json')) return response.json();
  return undefined as T;
}

export const messageOf = (error: unknown) => error instanceof ApiError ? error.message : 'Could not reach Switchboard. Try again.';

export function endpoint(workspace: string, suffix = '', after?: string) {
  const query = new URLSearchParams({ workspace });
  if (after) query.set('after', after);
  return '/api/conversations' + suffix + '?' + query;
}
