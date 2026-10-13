/**
 * Tests for deploys (board.mjs deploy and the human_only merge guard) against
 * a throwaway repository that "deploys" by pushing to a local bare remote,
 * a stub `gh` for GitHub Actions, and an in-process "live site".
 * Run with: node --test tests/
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const BOARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'board.mjs');
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'factory-deploy-')));
const repo = join(sandbox, 'project');
const remote = join(sandbox, 'remote.git');
const migrateLog = join(sandbox, 'migrate.log');

const GH_STUB = `#!/usr/bin/env node
const conclusion = process.env.GH_STUB_CONCLUSION || 'success';
console.log(JSON.stringify([{ databaseId: 1, workflowName: 'CI', status: 'completed', conclusion, url: 'https://ci/1' }]));
`;

let env;
let site;
let siteStatus = 200;
let siteUrl;

const sh = (cmd, args, cwd = repo) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();

/** Run the board without blocking this process, which serves the live site. */
function board(args, extraEnv = {}) {
  return new Promise((resolveRun) => {
    execFile('node', [BOARD, ...args], { cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8' }, (error, stdout, stderr) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        // Not JSON (an error message).
      }
      resolveRun({ code: error ? error.code : 0, json, stderr });
    });
  });
}

async function ok(args, extraEnv) {
  const result = await board(args, extraEnv);
  assert.equal(result.code, 0, `board ${args.join(' ')} failed:\n${result.stderr}`);
  return result.json;
}

function profile(extra = '') {
  writeFileSync(
    join(repo, 'factory', 'profile.md'),
    [
      '---',
      'base_branch: main',
      'setup: true',
      'verify: true',
      'reviewers: [code]',
      'deploy: git push -q origin main',
      'deploy_wait: github-actions',
      `smoke: ${siteUrl}`,
      'smoke_timeout: 1',
      `migrate: echo "$DEPLOY_COMMIT" >> ${migrateLog}`,
      'migrations: [db/]',
      'human_only: [db/]',
      extra,
      '---',
      '',
    ].join('\n'),
  );
  sh('git', ['commit', '-qam', 'profile']);
}

/** Build a job that changes `file`, and approve it through to "approve". */
async function approvedJob(title, file) {
  const job = await ok(['new', title]);
  mkdirSync(dirname(join(job.worktree, file)), { recursive: true });
  writeFileSync(join(job.worktree, file), title);
  sh('git', ['add', '-A'], job.worktree);
  sh('git', ['commit', '-qm', title], job.worktree);
  await ok(['verify', job.id]);
  return job;
}

const remoteHead = () => sh('git', ['rev-parse', 'main'], remote);
const head = () => sh('git', ['rev-parse', 'HEAD']);
const migrations = () => (existsSync(migrateLog) ? readFileSync(migrateLog, 'utf8').trim().split('\n') : []);
const boardFile = () => JSON.parse(readFileSync(join(repo, 'factory', 'board.json'), 'utf8'));

before(async () => {
  site = createServer((req, res) => {
    res.statusCode = siteStatus;
    res.end('live');
  });
  await new Promise((resolveListen) => site.listen(0, '127.0.0.1', resolveListen));
  siteUrl = `http://127.0.0.1:${site.address().port}/`;

  const bin = join(sandbox, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), GH_STUB);
  chmodSync(join(bin, 'gh'), 0o755);
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SOFTWARE_FACTORY_HOME: join(sandbox, 'home') };

  sh('git', ['init', '-q', '--bare', '-b', 'main', remote], sandbox);
  mkdirSync(join(repo, 'factory'), { recursive: true });
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'factory@test']);
  sh('git', ['config', 'user.name', 'Factory Test']);
  sh('git', ['remote', 'add', 'origin', remote]);
  writeFileSync(join(repo, '.gitignore'), 'factory/jobs/\nfactory/board.json\nfactory/.board.lock\nfactory/.deploy.lock\nfactory/deploy.log\n');
  writeFileSync(join(repo, 'factory', 'profile.md'), '');
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'init']);
  profile();
});

after(() => {
  site.close();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('human_only paths', () => {
  it('will not merge a database change without a person', async () => {
    const job = await approvedJob('Add a table', 'db/001_table.sql');
    const result = await board(['merge', job.id]);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /needs a human: it changes db\/001_table\.sql/);
    assert.equal(boardFile().jobs[job.id].stage, 'spec');

    await ok(['merge', job.id, '--human']);
    assert.equal(boardFile().jobs[job.id].stage, 'merged');
  });
});

describe('deploy', () => {
  it('migrates, deploys, waits for GitHub Actions and smoke-checks the first time', async () => {
    const job = Object.values(boardFile().jobs)[0];
    const result = await ok(['deploy', job.id]);
    assert.equal(result.state, 'ok');
    assert.equal(result.commit, head());
    assert.equal(remoteHead(), head(), 'pushed');
    assert.deepEqual(migrations(), [head()], 'migrated with DEPLOY_COMMIT');
    assert.deepEqual(result.jobs, [job.id]);
    const log = readFileSync(join(repo, 'factory', 'jobs', job.id, 'deploy.log'), 'utf8');
    assert.match(log, /GitHub Actions: CI: completed \(success\)/);
    assert.match(log, /Smoke check .*: HTTP 200/);
    assert.equal(boardFile().deploys.lastOk.commit, head());
    assert.equal(boardFile().jobs[job.id].deploy.state, 'ok');
  });

  it('skips migrate when no migration changed, and ships every job merged since', async () => {
    const first = await approvedJob('First page', 'pages/a.txt');
    await ok(['merge', first.id]);
    const second = await approvedJob('Second page', 'pages/b.txt');
    await ok(['merge', second.id]);
    const result = await ok(['deploy', second.id]);
    assert.deepEqual(result.jobs.sort(), [first.id, second.id].sort());
    assert.equal(migrations().length, 1, 'no new migration run');
    assert.match(readFileSync(join(repo, 'factory', 'jobs', second.id, 'deploy.log'), 'utf8'), /skipped migrate/);
    assert.equal(remoteHead(), head());
  });

  it('reports a failed smoke check without undoing the merge', async () => {
    const job = await approvedJob('Third page', 'pages/c.txt');
    await ok(['merge', job.id]);
    siteStatus = 503;
    const result = await board(['deploy', job.id]);
    siteStatus = 200;
    assert.equal(result.code, 1);
    assert.equal(result.json.state, 'failed');
    assert.equal(result.json.step, 'smoke');
    assert.match(result.json.reason, /HTTP 503/);
    const saved = boardFile();
    assert.equal(saved.jobs[job.id].deploy.state, 'failed');
    assert.equal(saved.jobs[job.id].stage, 'merged');
    assert.notEqual(saved.deploys.lastOk.commit, head(), 'the last good deploy is unchanged');
  });

  it('reports failed GitHub Actions runs', async () => {
    const result = await board(['deploy'], { GH_STUB_CONCLUSION: 'failure' });
    assert.equal(result.code, 1);
    assert.equal(result.json.step, 'deploy_wait');
    assert.match(result.json.reason, /GitHub Actions failed: CI https:\/\/ci\/1/);
    assert.ok(existsSync(join(repo, 'factory', 'deploy.log')));
  });

  it('deploys nothing when the migration fails', async () => {
    profile('migrate: exit 7');
    const job = await approvedJob('Another table', 'db/002_more.sql');
    await ok(['merge', job.id, '--human']);
    const before = remoteHead();
    const result = await board(['deploy', job.id]);
    assert.equal(result.code, 1);
    assert.equal(result.json.step, 'migrate');
    assert.equal(remoteHead(), before, 'not pushed');
  });

  it('refuses to deploy uncommitted work, and needs a deploy command', async () => {
    writeFileSync(join(repo, 'scratch.txt'), 'wip');
    const dirty = await board(['deploy']);
    assert.equal(dirty.code, 1);
    assert.match(dirty.stderr, /uncommitted changes/);
    rmSync(join(repo, 'scratch.txt'));

    writeFileSync(join(repo, 'factory', 'profile.md'), '---\nbase_branch: main\nsetup: true\nverify: true\nreviewers: [code]\n---\n');
    sh('git', ['commit', '-qam', 'no deploy']);
    const none = await board(['deploy']);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /no "deploy" command/);
  });
});

describe('waiting for GitHub Actions', () => {
  const STATEFUL = `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.GH_STUB_COUNT;
const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
fs.writeFileSync(file, String(n));
const mode = process.env.GH_STUB_MODE;
if (mode === 'none') { console.log('[]'); process.exit(0); }
// Nothing yet, then running, then done: what a push really looks like.
const runs = n === 1 ? [] : [{ workflowName: 'CI', status: n < 3 ? 'in_progress' : 'completed', conclusion: n < 3 ? '' : 'success', url: 'u' }];
console.log(JSON.stringify(runs));
`;
  let waitForGithubRuns;
  let saved;

  before(async () => {
    ({ waitForGithubRuns } = await import('../scripts/deploy.mjs'));
    const bin = join(sandbox, 'bin-stateful');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), STATEFUL);
    chmodSync(join(bin, 'gh'), 0o755);
    saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
  });

  after(() => {
    process.env.PATH = saved;
  });

  it('waits for a run to appear and finish', async () => {
    process.env.GH_STUB_COUNT = join(sandbox, 'count-1');
    process.env.GH_STUB_MODE = '';
    const lines = [];
    const result = await waitForGithubRuns('abc1234', sandbox, 5000, (l) => lines.push(l), { pollMs: 10 });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(lines, ['GitHub Actions: CI: in_progress', 'GitHub Actions: CI: completed (success)']);
  });

  it('gives up when no run starts for the commit', async () => {
    process.env.GH_STUB_COUNT = join(sandbox, 'count-2');
    process.env.GH_STUB_MODE = 'none';
    const result = await waitForGithubRuns('abc1234', sandbox, 5000, () => {}, { pollMs: 10, appearMs: 50 });
    assert.deepEqual(result, { ok: false, reason: 'no GitHub Actions run started for abc1234' });
  });
});
