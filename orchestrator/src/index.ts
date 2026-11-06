// Stall orchestrator: receives queue webhooks from the app and runs the lanes.
import { createServer } from 'node:http';
import { loadOrchConfig } from './config.ts';
import { AppClient } from './appClient.ts';
import { Store } from './store.ts';
import { Orchestrator } from './orchestrator.ts';
import { ClaudeAgent } from './claudeAgent.ts';
import { MockAgent } from './mockAgent.ts';
import { log } from './log.ts';
import { verify, SIGNATURE_HEADER, TIMESTAMP_HEADER, DELIVERY_HEADER } from '../../shared/signing.ts';
import type { WebhookEvent } from '../../shared/types.ts';

const cfg = loadOrchConfig();
const store = new Store(cfg.dataDir);
const app = new AppClient(cfg.appUrl, cfg.appToken);
const agent = cfg.agent === 'mock' ? new MockAgent() : new ClaudeAgent(cfg);
const orch = new Orchestrator(cfg, app, store, agent);

const server = createServer((req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, ...orch.status() });
  if (req.method !== 'POST' || req.url !== '/webhook') return send(404, { error: 'not found' });

  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > 256 * 1024) req.destroy();
    else chunks.push(c);
  });
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const h = (n: string) => req.headers[n] as string | undefined;
    if (!verify(cfg.webhookSecret, h(TIMESTAMP_HEADER), raw, h(SIGNATURE_HEADER))) return send(401, { error: 'bad signature' });
    const delivery = h(DELIVERY_HEADER);
    if (delivery && !store.firstDelivery(delivery)) return send(200, { duplicate: true });
    let event: WebhookEvent;
    try {
      event = JSON.parse(raw);
    } catch {
      return send(400, { error: 'bad json' });
    }
    send(202, { accepted: true });
    log('webhook', event.type, 'requestId' in event ? `#${event.requestId}` : `#${event.request.id}`);
    if (event.type === 'request.cancelled') void orch.cancel(event.requestId);
    else orch.pump(); // queued or replied: either way there is something to claim
  });
});

await orch.start();
server.listen(cfg.port, () =>
  log('orchestrator', `listening on :${cfg.port}; ${cfg.workerLanes} worker lanes + integration; agent=${cfg.agent}; repo=${cfg.repo} (${cfg.remote ? `${cfg.remote}/` : ''}${cfg.baseBranch})`),
);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    log('orchestrator', `${sig}: stopping lanes (in-flight work resumes on next start)`);
    server.close();
    await orch.stop();
    process.exit(0);
  });
}
