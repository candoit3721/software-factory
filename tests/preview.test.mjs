/**
 * Tests for review previews (board.mjs preview, scripts/preview.mjs and the
 * dashboard's start endpoint) against a throwaway repository whose "app" is
 * a tiny HTTP server.
 * Run with: node --test tests/
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const BOARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'board.mjs');
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'factory-preview-')));
process.env.SOFTWARE_FACTORY_HOME = join(sandbox, 'home');
const { processAlive } = await import('../scripts/preview.mjs');
const { createDashboardServer } = await import('../scripts/dashboard.mjs');

const repo = join(sandbox, 'project');
const APP = `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
createServer((req, res) => res.end(readFileSync('page.txt', 'utf8'))).listen(Number(process.env.FACTORY_PORT));
`;

const sh = (cmd, args, cwd = repo) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();

function board(args, { expectFail = false } = {}) {
  const result = spawnSync('node', [BOARD, ...args], { cwd: repo, encoding: 'utf8', env: process.env });
  if (expectFail) {
    assert.notEqual(result.status, 0, `expected failure: ${args.join(' ')}\n${result.stdout}`);
    return result.stderr;
  }
  assert.equal(result.status, 0, `board ${args.join(' ')} failed:\n${result.stderr}${result.stdout}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    return result.stdout;
  }
}

function profile(preview) {
  writeFileSync(
    join(repo, 'factory', 'profile.md'),
    `---\nbase_branch: main\nsetup: true\nverify: true\n${preview ? `preview: ${preview}\n` : ''}preview_timeout: 15\nreviewers: [code]\n---\n`,
  );
  sh('git', ['commit', '-qam', 'profile']);
}

/** A job that waits for a human, with one commit of its own. */
function waitingJob(title) {
  const job = board(['new', title]);
  writeFileSync(join(job.worktree, 'page.txt'), `built by ${title}`);
  sh('git', ['add', '-A'], job.worktree);
  sh('git', ['commit', '-qm', 'build'], job.worktree);
  board(['stage', job.id, 'needs-human', '--note', 'platform lane']);
  return job;
}

const shown = (id) => board(['show', id]);
const gone = async (pid) => {
  for (let i = 0; i < 40 && processAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !processAlive(pid);
};

before(() => {
  mkdirSync(join(repo, 'factory'), { recursive: true });
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'factory@test']);
  sh('git', ['config', 'user.name', 'Factory Test']);
  writeFileSync(join(repo, 'app.mjs'), APP);
  writeFileSync(join(repo, 'page.txt'), 'main');
  writeFileSync(join(repo, 'factory', 'profile.md'), '');
  writeFileSync(join(repo, '.gitignore'), 'factory/jobs/\nfactory/board.json\nfactory/.board.lock\n');
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'init']);
  profile('node app.mjs');
  board(['init']);
});

after(() => {
  // Never leave a preview running, even when a test failed half way.
  try {
    const { jobs } = JSON.parse(readFileSync(join(repo, 'factory', 'board.json'), 'utf8'));
    for (const job of Object.values(jobs)) if (job.preview) board(['preview', job.id, '--stop']);
  } catch {
    // No board: nothing to stop.
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe('review previews', () => {
  let job;
  let first;

  it('runs the job worktree on a free port and records it on the job', async () => {
    job = waitingJob('Preview me');
    first = board(['preview', job.id.slice(0, 3)]);
    assert.match(first.url, /^http:\/\/localhost:\d+\/$/);
    assert.equal(await (await fetch(first.url)).text(), 'built by Preview me');
    assert.equal(shown(job.id).preview.commit, sh('git', ['rev-parse', 'HEAD'], job.worktree));
    assert.match(board(['list']), new RegExp(`preview ${first.url}`));
  });

  it('reuses a running preview of the same commit', () => {
    const again = board(['preview', job.id]);
    assert.equal(again.reused, true);
    assert.equal(again.pid, first.pid);
  });

  it('restarts the preview when the job has new commits', async () => {
    writeFileSync(join(job.worktree, 'page.txt'), 'second build');
    sh('git', ['commit', '-qam', 'rework'], job.worktree);
    const fresh = board(['preview', job.id]);
    assert.notEqual(fresh.pid, first.pid);
    assert.ok(await gone(first.pid), 'the old preview was stopped');
    assert.equal(await (await fetch(fresh.url)).text(), 'second build');
    first = fresh;
  });

  it('stops the preview when the job leaves needs-human', async () => {
    board(['stage', job.id, 'build', '--note', 'human feedback']);
    assert.ok(await gone(first.pid));
    assert.equal(shown(job.id).preview, undefined);
  });

  it('stops the preview on --stop and on discard', async () => {
    board(['stage', job.id, 'needs-human']);
    const running = board(['preview', job.id]);
    assert.deepEqual(board(['preview', job.id, '--stop']), { id: job.id, stopped: true });
    assert.ok(await gone(running.pid));

    const again = board(['preview', job.id]);
    board(['discard', job.id, '--note', 'done']);
    assert.ok(await gone(again.pid));
    assert.ok(!existsSync(job.worktree));
  });

  it('stops the preview before merging', async () => {
    const merging = waitingJob('Merge me');
    const running = board(['preview', merging.id]);
    board(['verify', merging.id]);
    board(['merge', merging.id]);
    assert.ok(await gone(running.pid));
    assert.equal(shown(merging.id).stage, 'merged');
  });

  it('reports the log when the preview command fails', () => {
    profile('echo "no such server" && exit 3');
    const failing = waitingJob('Broken preview');
    const error = board(['preview', failing.id], { expectFail: true });
    assert.match(error, /preview did not start: the preview command exited/);
    assert.match(error, /no such server/);
    assert.equal(shown(failing.id).preview, undefined);
  });

  it('explains how to add a preview command when the profile has none', () => {
    profile(null);
    const plain = waitingJob('No preview');
    assert.match(board(['preview', plain.id], { expectFail: true }), /no "preview" command/);
  });
});

describe('dashboard preview endpoint', () => {
  let server;
  let base;
  let key;
  let job;

  before(async () => {
    profile('node app.mjs');
    job = waitingJob('From the dashboard');
    key = board(['register']).key;
    server = createDashboardServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  it('says which projects can preview and whether a preview is alive', async () => {
    const { projects } = await (await fetch(`${base}/api/projects`)).json();
    const project = projects.find((p) => p.key === key);
    assert.equal(project.canPreview, true);
    assert.equal(project.jobs.find((j) => j.id === job.id).preview, undefined);
  });

  it('refuses requests from other sites', async () => {
    const res = await fetch(`${base}/api/preview/${key}/${job.id}`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
    assert.equal(shown(job.id).preview, undefined);
    assert.equal((await fetch(`${base}/api/preview/${key}/${job.id}`)).status, 405);
  });

  it('starts a preview through the board for the page itself', async () => {
    const res = await fetch(`${base}/api/preview/${key}/${job.id}`, { method: 'POST', headers: { origin: base } });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(await (await fetch(body.url)).text(), 'built by From the dashboard');
    const { projects } = await (await fetch(`${base}/api/projects`)).json();
    assert.equal(projects.find((p) => p.key === key).jobs.find((j) => j.id === job.id).preview.alive, true);
  });

  it('passes board errors through', async () => {
    const res = await fetch(`${base}/api/preview/${key}/999-nope`, { method: 'POST', headers: { origin: base } });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /no job "999-nope"/);
  });
});
