// The orchestrator's view of the Stall app API (/api/orch/*).
import type { QueueItem, RequestDetail } from '../../shared/types.ts';

export class AppClient {
  base: string;
  token: string;
  constructor(base: string, token: string) {
    this.base = base;
    this.token = token;
  }

  private async call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; data: T }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(`${this.base}/api/orch${path}`, {
          method,
          headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        const data = (await res.json().catch(() => ({}))) as T & { error?: string };
        if (res.ok || okStatuses.includes(res.status)) return { status: res.status, data };
        if (res.status >= 400 && res.status < 500) throw new AppError(res.status, data.error ?? `HTTP ${res.status}`);
        lastErr = new AppError(res.status, data.error ?? `HTTP ${res.status}`);
      } catch (e) {
        if (e instanceof AppError && e.status < 500) throw e;
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    throw lastErr;
  }

  async queue(): Promise<QueueItem[]> {
    return (await this.call<{ queue: QueueItem[] }>('GET', '/queue')).data.queue;
  }
  async detail(id: number): Promise<RequestDetail> {
    return (await this.call<RequestDetail>('GET', `/requests/${id}`)).data;
  }
  async claim(id: number, lane: string): Promise<boolean> {
    return (await this.call<{ claimed: boolean }>('POST', `/requests/${id}/claim`, { lane }, [409])).data.claimed;
  }
  async progress(id: number, p: { status?: 'in_progress' | 'integrating'; lane?: string | null; branch?: string; note?: string }) {
    await this.call('POST', `/requests/${id}/progress`, p);
  }
  async question(id: number, question: string) {
    await this.call('POST', `/requests/${id}/question`, { question });
  }
  async requeue(id: number, reason: string) {
    await this.call('POST', `/requests/${id}/requeue`, { reason });
  }
  async complete(id: number, p: { summary: string; commit: string; branch: string }) {
    await this.call('POST', `/requests/${id}/complete`, p);
  }
  async fail(id: number, reason: string) {
    await this.call('POST', `/requests/${id}/fail`, { reason: reason.slice(0, 4000) });
  }
  async lanes(lanes: { id: string; state: string; requestId?: number | null; detail?: string }[]) {
    await this.call('POST', '/lanes', { lanes });
  }
}

export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
