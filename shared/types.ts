// Contract shared by the Stall app and the orchestrator.

export const REQUEST_STATUSES = [
  'proposed',    // open for votes, not yet approved to build
  'queued',      // approved, waiting for a free worker lane
  'in_progress', // a worker lane is implementing it
  'needs_info',  // Claude asked the submitter a question; waiting on a reply
  'integrating', // branch finished, waiting on / inside the integration lane
  'done',        // merged into the base branch
  'failed',
  'rejected',    // voted down or rejected by an admin
  'cancelled',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const ACTIVE_STATUSES: RequestStatus[] = ['queued', 'in_progress', 'needs_info', 'integrating'];
export const TERMINAL_STATUSES: RequestStatus[] = ['done', 'failed', 'rejected', 'cancelled'];

export type WebhookEvent =
  | { type: 'request.queued'; request: QueueItem }
  | { type: 'request.replied'; requestId: number; messageId: number; body: string }
  | { type: 'request.cancelled'; requestId: number };

/** What the orchestrator sees for a request waiting to be built. */
export type QueueItem = {
  id: number;
  title: string;
  description: string;
  submitter: string;
  priority: number;
  score: number;
  createdAt: string;
};

export type ThreadMessage = {
  id: number;
  author: 'user' | 'claude' | 'system';
  kind: 'question' | 'reply' | 'note';
  body: string;
  createdAt: string;
};

export type RequestDetail = QueueItem & {
  status: RequestStatus;
  lane: string | null;
  branch: string | null;
  messages: ThreadMessage[];
};
