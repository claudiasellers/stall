// The thing that actually writes code in a worker lane.
import type { RequestDetail } from '../../shared/types.ts';

export type AgentMode = 'fresh' | 'answer' | 'rework' | 'resume';

export type AgentInput = {
  request: RequestDetail;
  mode: AgentMode;
  cwd: string;
  branch: string;
  baseRef: string;
  prompt: string;
  systemAppend: string;
  resumeSessionId: string | null;
  signal: AbortSignal;
  /** Posts a question to the submitter. After calling it the agent should stop. */
  askSubmitter: (question: string) => Promise<void>;
  /** Short progress note shown on the request's timeline. */
  postUpdate: (note: string) => Promise<void>;
  onSession: (sessionId: string) => void;
  log: (...args: unknown[]) => void;
};

export type AgentResult = {
  sessionId: string | null;
  text: string;
  isError: boolean;
  asked: boolean;
  costUsd?: number;
};

export interface Agent {
  run(input: AgentInput): Promise<AgentResult>;
}
