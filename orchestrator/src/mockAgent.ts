// Deterministic stand-in for Claude, for tests and dry runs (AGENT=mock).
//   "[ask]"   in the description: asks one question first, then builds using the answer.
//   "[break]" in the description: first attempt leaves a BROKEN file (fails TEST_CMD), rework fixes it.
//   "[conflict]": edits shared.txt so parallel requests conflict in integration.
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent, AgentInput, AgentResult } from './agent.ts';
import { run } from './exec.ts';

export class MockAgent implements Agent {
  delayMs: number;
  constructor(delayMs = Number(process.env.MOCK_DELAY_MS ?? 300)) {
    this.delayMs = delayMs;
  }

  async run(input: AgentInput): Promise<AgentResult> {
    const { request: r, cwd } = input;
    const sessionId = input.resumeSessionId ?? `mock-${r.id}-${Date.now()}`;
    input.onSession(sessionId);
    await sleep(this.delayMs, input.signal);

    const answers = r.messages.filter((m) => m.kind === 'reply').map((m) => m.body);
    if (r.description.includes('[ask]') && answers.length === 0) {
      await input.askSubmitter('Which colour should this use?');
      return { sessionId, text: 'Asked the submitter a question.', isError: false, asked: true };
    }

    if (input.mode === 'rework' && input.prompt.includes('conflict')) {
      // Take base's side of the conflict, then re-apply our edit on top below.
      await run('git', ['-c', 'user.name=mock', '-c', 'user.email=mock@x', 'merge', '-X', 'theirs', '--no-edit', input.baseRef], { cwd });
    }
    await input.postUpdate('Writing the feature.');
    await mkdir(join(cwd, 'features'), { recursive: true });
    await writeFile(
      join(cwd, 'features', `req-${r.id}.md`),
      `# ${r.title}\n\n${r.description}\n${answers.length ? `\nAnswers: ${answers.join(' / ')}\n` : ''}`,
    );
    if (r.description.includes('[conflict]')) await writeFile(join(cwd, 'shared.txt'), `edited by request ${r.id}\n`);
    if (r.description.includes('[break]')) {
      if (input.mode === 'rework') await rm(join(cwd, 'BROKEN'), { force: true });
      else await writeFile(join(cwd, 'BROKEN'), 'oops\n');
    }
    await run('git', ['add', '-A'], { cwd });
    await run('git', ['-c', 'user.name=mock', '-c', 'user.email=mock@x', 'commit', '-q', '-m', `Implement #${r.id}: ${r.title}`], { cwd });
    await sleep(this.delayMs, input.signal);
    return { sessionId, text: `Added ${r.title.toLowerCase()}${answers.length ? ` using "${answers.at(-1)}"` : ''}.`, isError: false, asked: false };
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}
