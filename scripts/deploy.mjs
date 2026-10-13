/**
 * Deploy helpers for board.mjs: waiting for GitHub Actions and smoke-checking
 * the live site. The deploy itself is the project's own command; the factory
 * never handles credentials, it runs CLIs that are already logged in.
 */
import { spawnSync } from 'node:child_process';

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Wait until every GitHub Actions run for `commit` has finished.
 * Pushing starts the runs a few seconds later, so an empty list is retried
 * for a while before it counts as "no workflow ran".
 */
export async function waitForGithubRuns(commit, cwd, timeoutMs, log, { pollMs = 10_000, appearMs = 120_000 } = {}) {
  const started = Date.now();
  let lastLine = '';
  for (;;) {
    const result = spawnSync(
      'gh',
      ['run', 'list', '--commit', commit, '--json', 'databaseId,workflowName,status,conclusion,url'],
      { cwd, encoding: 'utf8' },
    );
    if (result.error || result.status !== 0) {
      return { ok: false, reason: `gh run list failed: ${(result.stderr || result.error?.message || '').trim()}` };
    }
    const runs = JSON.parse(result.stdout || '[]');
    const line = runs.map((r) => `${r.workflowName}: ${r.status}${r.conclusion ? ` (${r.conclusion})` : ''}`).join(', ');
    if (line && line !== lastLine) log(`GitHub Actions: ${line}`);
    lastLine = line;
    if (runs.length === 0 && Date.now() - started > appearMs) {
      return { ok: false, reason: `no GitHub Actions run started for ${commit.slice(0, 7)}` };
    }
    if (runs.length > 0 && runs.every((r) => r.status === 'completed')) {
      const failed = runs.filter((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion));
      return failed.length
        ? { ok: false, reason: `GitHub Actions failed: ${failed.map((r) => `${r.workflowName} ${r.url}`).join(', ')}` }
        : { ok: true };
    }
    if (Date.now() - started > timeoutMs) {
      return { ok: false, reason: `GitHub Actions still running after ${Math.round(timeoutMs / 1000)} s` };
    }
    await sleep(pollMs);
  }
}

/** Wait until the live url answers with a 2xx status. */
export async function smokeCheck(url, timeoutMs, { pollMs = Math.min(5000, timeoutMs / 4) } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
      if (res.ok) return { ok: true, status: res.status };
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error.cause?.code ?? error.message;
    }
    if (Date.now() > deadline) return { ok: false, reason: `${url} did not answer with 2xx (${last})` };
    await sleep(pollMs);
  }
}
