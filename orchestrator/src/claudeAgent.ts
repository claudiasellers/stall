// Worker lane agent backed by the Claude Agent SDK (the same engine as Claude Code).
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Agent, AgentInput, AgentResult } from './agent.ts';
import type { OrchConfig } from './config.ts';

export class ClaudeAgent implements Agent {
  cfg: OrchConfig;
  constructor(cfg: OrchConfig) {
    this.cfg = cfg;
  }

  async run(input: AgentInput): Promise<AgentResult> {
    let asked = false;
    let sessionId: string | null = input.resumeSessionId;

    const stall = createSdkMcpServer({
      name: 'stall',
      version: '1.0.0',
      tools: [
        tool(
          'ask_submitter',
          'Ask the person who submitted this feature request a clarifying question. They answer in the Stall app, ' +
            'which can take hours, so after calling this you must end your turn immediately. You will be resumed with their answer. ' +
            'Ask at most one focused question, and only when the answer would materially change what you build.',
          { question: z.string().min(5).max(2000).describe('One short, friendly question in everyday language. The submitter is not technical: no jargon. Offering two or three options to pick from works well.') },
          async ({ question }) => {
            if (asked) return { content: [{ type: 'text', text: 'You already asked a question. End your turn now.' }], isError: true };
            await input.askSubmitter(question);
            asked = true;
            return { content: [{ type: 'text', text: 'Question sent to the submitter. Commit any work in progress, then end your turn now without further tool calls.' }] };
          },
        ),
        tool(
          'post_update',
          'Post a short, friendly progress note (one sentence, no technical terms) to the timeline the submitter sees. Use sparingly, for real milestones.',
          { note: z.string().min(3).max(500) },
          async ({ note }) => {
            await input.postUpdate(note);
            return { content: [{ type: 'text', text: 'Posted.' }] };
          },
        ),
      ],
    });

    const abortController = new AbortController();
    input.signal.addEventListener('abort', () => abortController.abort(), { once: true });

    const q = query({
      prompt: input.prompt,
      options: {
        cwd: input.cwd,
        resume: input.resumeSessionId ?? undefined,
        model: this.cfg.model,
        maxTurns: this.cfg.maxTurns,
        maxBudgetUsd: this.cfg.maxBudgetUsd,
        abortController,
        // Lanes run unattended inside their own worktree; run the orchestrator in a container or VM.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        disallowedTools: ['AskUserQuestion'],
        settingSources: ['project'], // pick up the target repo's CLAUDE.md and .claude/settings.json
        systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemAppend },
        mcpServers: { stall },
      },
    });

    let text = '';
    let isError = false;
    let costUsd: number | undefined;
    try {
      for await (const msg of q) {
        if ('session_id' in msg && msg.session_id && msg.session_id !== sessionId) {
          sessionId = msg.session_id;
          input.onSession(sessionId);
        }
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') input.log(`tool ${block.name}`);
          }
        } else if (msg.type === 'result') {
          costUsd = msg.total_cost_usd;
          if (msg.subtype === 'success') {
            text = msg.result;
            isError = msg.is_error;
          } else {
            isError = true;
            text = `${msg.subtype}: ${(msg.errors ?? []).join('; ')}`;
          }
        }
      }
    } catch (e) {
      if (input.signal.aborted) return { sessionId, text: 'cancelled', isError: true, asked };
      return { sessionId, text: String((e as Error).message ?? e), isError: true, asked };
    }
    return { sessionId, text: text.trim(), isError: isError && !asked, asked, costUsd };
  }
}
