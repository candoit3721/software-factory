/**
 * End-to-end tests for scripts/board.mjs against a throwaway git repository.
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

let sandbox;
let repo;
let ENV;

function sh(cmd, args, cwd = repo) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function board(args, { expectFail = false } = {}) {
  const result = spawnSync('node', [BOARD, ...args], { cwd: repo, encoding: 'utf8', env: ENV });
  if (expectFail) {
    assert.notEqual(result.status, 0, `expected failure: ${args.join(' ')}\n${result.stdout}`);
    return { stdout: result.stdout, stderr: result.stderr };
  }
  assert.equal(result.status, 0, `board ${args.join(' ')} failed:\n${result.stderr}${result.stdout}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    return result.stdout;
  }
}

function commitIn(dir, file, content, message) {
  writeFileSync(join(dir, file), content);
  sh('git', ['add', file], dir);
  sh('git', ['commit', '-qm', message], dir);
}

before(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'factory-test-')));
  repo = join(sandbox, 'project');
  // Keep the test's projects out of the real all-projects registry.
  ENV = { ...process.env, SOFTWARE_FACTORY_HOME: join(sandbox, 'home') };
  mkdirSync(join(repo, 'factory'), { recursive: true });
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'factory@test']);
  sh('git', ['config', 'user.name', 'Factory Test']);
  writeFileSync(
    join(repo, 'factory', 'profile.md'),
    `---\nbase_branch: main\nmax_rounds: 2\nsetup: true\nverify: test -f ok.txt && echo "port=$FACTORY_PORT"\nreviewers: [code, experience]\n---\n# Profile\n`,
  );
  writeFileSync(join(repo, 'factory', 'backlog.md'), '# Backlog\n\n- [ ] First item\n- [ ] Second item\n');
  writeFileSync(join(repo, '.gitignore'), 'factory/jobs/\nfactory/board.json\nfactory/.board.lock\n');
  writeFileSync(join(repo, 'ok.txt'), 'ok\n');
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'init']);
  board(['init']);
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

describe('board.mjs', () => {
  let job;

  it('registers the project for the all-projects dashboard on init, once', () => {
    board(['init']);
    const projects = board(['projects']);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].root, repo);
    assert.match(projects[0].key, /^project-[a-z0-9]+$/);
    assert.ok(existsSync(join(sandbox, 'home', 'projects.json')));
  });

  it('unregisters and re-registers a project', () => {
    assert.equal(board(['unregister']).removed, true);
    assert.deepEqual(board(['projects']), []);
    assert.match(board(['register']).url, /^http:\/\/localhost:4700\/\?project=project-/);
  });

  it('takes the first open backlog item', () => {
    assert.deepEqual(board(['next']), { item: 'First item' });
  });

  it('creates a job with a branch and a worktree outside the repo', () => {
    job = board(['new', 'First item', '--backlog', 'First item']);
    assert.match(job.id, /^001-first-item$/);
    assert.equal(job.branch, 'factory/001-first-item');
    assert.ok(job.worktree.startsWith(join(sandbox, 'project.worktrees')));
    assert.ok(existsSync(join(job.worktree, 'ok.txt')));
    assert.match(readFileSync(job.request, 'utf8'), /# First item/);
    assert.equal(board(['show', job.id]).stage, 'spec');
  });

  it('does not hand out a backlog item that a job already claimed', () => {
    assert.deepEqual(board(['next']), { item: 'Second item' });
  });

  it('finds a job by a unique id prefix', () => {
    assert.equal(board(['show', '001']).id, job.id);
    board(['show', '9'], { expectFail: true });
  });

  it('runs setup in the worktree', () => {
    assert.equal(board(['setup', job.id]).ok, true);
  });

  it('collects verdicts from the first line of each review file', () => {
    board(['stage', job.id, 'build']);
    const round = board(['round', job.id]);
    assert.equal(round.round, 1);
    writeFileSync(round.reviews.code, 'VERDICT: PASS\n\nall good');
    writeFileSync(round.reviews.experience, '\nVERDICT: CHANGES\n## Required changes\n1. fix it');
    const collected = board(['collect', job.id]);
    assert.deepEqual(collected.verdicts, { code: 'PASS', experience: 'CHANGES' });
    assert.equal(collected.allPass, false);
    assert.equal(collected.roundsLeft, 1);
  });

  it('marks a missing review as MISSING', () => {
    const round = board(['round', job.id]);
    writeFileSync(round.reviews.code, 'VERDICT: PASS');
    const collected = board(['collect', job.id]);
    assert.deepEqual(collected.missing, ['experience']);
    assert.equal(collected.roundsLeft, 0);
  });

  it('refuses to verify a worktree with uncommitted changes', () => {
    writeFileSync(join(job.worktree, 'feature.txt'), 'wip');
    board(['verify', job.id], { expectFail: true });
    sh('git', ['add', 'feature.txt'], job.worktree);
    sh('git', ['commit', '-qm', 'feat: feature'], job.worktree);
  });

  it('refuses to merge before verification', () => {
    board(['merge', job.id], { expectFail: true });
  });

  it('verifies with a free port and records the verified commit', () => {
    const result = board(['verify', job.id]);
    assert.equal(result.ok, true);
    assert.match(readFileSync(result.log, 'utf8'), /port=\d+/);
    assert.equal(board(['show', job.id]).verified.commit, result.commit);
  });

  it('reads the approver decision', () => {
    writeFileSync(board(['paths', job.id]).decision, 'DECISION: ESCALATE - touches the platform\n');
    assert.deepEqual(
      { decision: board(['decision', job.id]).decision, reason: board(['show', job.id]).decision.reason },
      { decision: 'ESCALATE', reason: 'touches the platform' },
    );
    writeFileSync(board(['paths', job.id]).decision, 'DECISION: APPROVE\n');
    assert.equal(board(['decision', job.id]).decision, 'APPROVE');
  });

  it('requires re-verification when the base branch moved', () => {
    commitIn(repo, 'base.txt', 'base change', 'chore: base moves');
    board(['merge', job.id], { expectFail: true });
    assert.equal(board(['verify', job.id]).ok, true);
  });

  it('merges, checks off the backlog item and cleans up', () => {
    const result = board(['merge', job.id]);
    assert.equal(result.ok, true);
    assert.ok(existsSync(join(repo, 'feature.txt')));
    assert.match(readFileSync(join(repo, 'factory', 'backlog.md'), 'utf8'), /- \[x\] First item \(001-first-item\)/);
    assert.equal(sh('git', ['status', '--porcelain']), '');
    assert.ok(!existsSync(job.worktree));
    assert.equal(sh('git', ['branch', '--list', job.branch]), '');
    assert.equal(board(['show', job.id]).stage, 'merged');
    assert.equal(sh('git', ['log', '-1', '--format=%s']), 'chore(factory): check off 001-first-item');
  });

  it('reports a conflict with the base branch instead of merging it', () => {
    const second = board(['new', 'Second item', '--backlog', 'Second item']);
    commitIn(second.worktree, 'ok.txt', 'job version\n', 'feat: job edit');
    commitIn(repo, 'ok.txt', 'base version\n', 'chore: base edit');
    const { stdout } = board(['verify', second.id], { expectFail: true });
    assert.equal(JSON.parse(stdout).reason, 'conflict');
    assert.equal(sh('git', ['status', '--porcelain'], second.worktree), '');
    board(['discard', second.id, '--note', 'test cleanup']);
    assert.equal(board(['show', second.id]).stage, 'discarded');
  });

  it('records the approver decision when a job leaves approval, even without "decision"', () => {
    const extra = board(['new', 'Escalated change']);
    board(['stage', extra.id, 'approve']);
    writeFileSync(extra.decision, 'DECISION: ESCALATE - platform lane\n');
    board(['stage', extra.id, 'needs-human', '--note', 'platform lane']);
    assert.deepEqual(
      (({ decision, reason }) => ({ decision, reason }))(board(['show', extra.id]).decision),
      { decision: 'ESCALATE', reason: 'platform lane' },
    );
    board(['discard', extra.id]);
  });

  it('cuts long job ids at a word boundary', () => {
    const job = board(['new', 'Grade 6 vertebrates and invertebrates lesson with extras']);
    assert.equal(job.id.slice(4), 'grade-6-vertebrates-and-invertebrates');
    board(['discard', job.id]);
  });

  it('refuses to start a job while the main tree is dirty', () => {
    writeFileSync(join(repo, 'dirty.txt'), 'x');
    board(['new', 'Dirty'], { expectFail: true });
    rmSync(join(repo, 'dirty.txt'));
  });

  it('keeps every update when several processes write at once', async () => {
    const ids = [1, 2, 3, 4].map((n) => board(['new', `Parallel ${n}`]).id);
    const ambiguous = board(['show', '00'], { expectFail: true });
    assert.match(ambiguous.stderr, /matches several jobs/);
    await Promise.all(
      ids.map(
        (id) =>
          new Promise((resolve, reject) => {
            const child = spawnSync('node', [BOARD, 'stage', id, 'build', '--note', 'parallel'], {
              cwd: repo,
              encoding: 'utf8',
              env: ENV,
            });
            child.status === 0 ? resolve() : reject(new Error(child.stderr));
          }),
      ),
    );
    const jobs = JSON.parse(readFileSync(join(repo, 'factory', 'board.json'), 'utf8')).jobs;
    for (const id of ids) assert.equal(jobs[id].stage, 'build');
    for (const id of ids) board(['discard', id]);
  });
});
