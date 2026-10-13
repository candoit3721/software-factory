#!/usr/bin/env node
/**
 * Software factory board: the deterministic half of the factory.
 *
 * Agents do the thinking; this script owns every state change and git
 * operation, so the board can never drift from what really happened.
 * Run it from the project root:
 *
 *   node board.mjs init
 *   node board.mjs new "<title>" [--request-file <path>] [--backlog "<item text>"]
 *   node board.mjs stage <id> <stage> [--note "<text>"]
 *   node board.mjs round <id>              increment the review round
 *   node board.mjs collect <id>            read this round's review verdicts
 *   node board.mjs decision <id>           read decision.md
 *   node board.mjs setup <id>              run the profile's setup command in the worktree
 *   node board.mjs verify <id>             merge the base branch into the job, then run the profile's verify command
 *   node board.mjs merge <id> [--human]    merge the verified job into the base branch and clean up
 *                                          (--human: a person approved it; required for human_only paths)
 *   node board.mjs deploy [<id>]           migrate, deploy and smoke-check the base branch (profile commands)
 *   node board.mjs discard <id>            drop the worktree and branch
 *   node board.mjs preview <id> [--open]   run the job's app from its worktree for a human to try
 *   node board.mjs preview <id> --stop     stop it (merge, discard and leaving needs-human also stop it)
 *   node board.mjs next                    first open backlog item not claimed by a job
 *   node board.mjs list | show <id> | paths <id>
 *   node board.mjs register | unregister   add or remove this project on the all-projects dashboard
 *   node board.mjs projects                every registered project
 *
 * Output is JSON on stdout (except `list`). Exit code 0 on success, 1 on a
 * failed check (verify, merge preconditions, deploy), 2 on usage errors,
 * 3 when a merge needs a human.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { smokeCheck, waitForGithubRuns } from './deploy.mjs';
import { answers, launchPreview, openInBrowser, processAlive, stopPreview, tail, waitForPreview } from './preview.mjs';
import { projectKey, readRegistry, registerProject, unregisterProject } from './registry.mjs';

const ROOT = process.cwd();
const FACTORY = join(ROOT, 'factory');
const JOBS = join(FACTORY, 'jobs');
const BOARD = join(FACTORY, 'board.json');
const PROFILE = join(FACTORY, 'profile.md');
const BACKLOG = join(FACTORY, 'backlog.md');
const LOCK = join(FACTORY, '.board.lock');
const DEPLOY_LOCK = join(FACTORY, '.deploy.lock');

export const STAGES = ['spec', 'build', 'review', 'approve', 'needs-human', 'merged', 'discarded', 'failed'];
const ACTIVE = new Set(['spec', 'build', 'review', 'approve', 'needs-human']);

// ----------------------------------------------------------------- helpers

function fail(message, code = 1) {
  process.stderr.write(`board: ${message}\n`);
  process.exit(code);
}

function out(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(args, cwd = ROOT) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

function now() {
  return new Date().toISOString();
}

function slugify(text) {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^(.{0,40})(?:-.*)?$/, '$1') // cut at a word boundary within 40 characters
      .slice(0, 40) // and never longer, even for one very long word
      .replace(/-$/, '') || 'job'
  );
}

/** Strip one pair of matching surrounding quotes, and nothing else. */
function unquote(value) {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}

/** Minimal front matter reader: `key: value` and `key: [a, b]` lines between --- fences. */
export function readProfile(path = PROFILE) {
  if (!existsSync(path)) fail(`missing ${path}; create it first (see the factory skill's "init" command)`);
  const text = readFileSync(path, 'utf8');
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) fail('factory/profile.md must start with a --- front matter block');
  const profile = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, key, raw] = kv;
    const list = /^\[(.*)\]$/.exec(raw);
    profile[key] = list
      ? list[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : unquote(raw);
  }
  for (const key of ['base_branch', 'setup', 'verify', 'reviewers']) {
    if (!profile[key] || (Array.isArray(profile[key]) && profile[key].length === 0)) {
      fail(`factory/profile.md front matter needs "${key}"`);
    }
  }
  profile.max_rounds = Number(profile.max_rounds ?? 2);
  profile.preview_timeout = Number(profile.preview_timeout ?? 180);
  profile.preview_exclusive = profile.preview_exclusive === 'true';
  profile.deploy_timeout = Number(profile.deploy_timeout ?? 1200);
  profile.smoke_timeout = Number(profile.smoke_timeout ?? 300);
  profile.deploy_when = profile.deploy_when || 'auto';
  for (const key of ['human_only', 'migrations']) {
    if (typeof profile[key] === 'string') profile[key] = profile[key] ? [profile[key]] : [];
    profile[key] ??= [];
  }
  return profile;
}

function readBoard() {
  if (!existsSync(BOARD)) return { version: 1, jobs: {} };
  return JSON.parse(readFileSync(BOARD, 'utf8'));
}

function writeBoard(board) {
  mkdirSync(FACTORY, { recursive: true });
  const tmp = `${BOARD}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`);
  renameSync(tmp, BOARD); // atomic, so the dashboard never reads half a file
}

/** Find a job by its id or by a unique prefix of it, such as "004". */
function getJob(board, id) {
  if (!id) fail('missing job id', 2);
  if (board.jobs[id]) return board.jobs[id];
  const matches = Object.keys(board.jobs).filter((key) => key.startsWith(id));
  if (matches.length === 1) return board.jobs[matches[0]];
  if (matches.length > 1) fail(`"${id}" matches several jobs: ${matches.join(', ')}`, 2);
  fail(`no job "${id}"`, 2);
}

function readDecision(job) {
  const line = firstLine(join(JOBS, job.id, 'decision.md'));
  const match = line && /^DECISION:\s*(APPROVE|ESCALATE)\b\s*[-:]?\s*(.*)$/i.exec(line);
  return match ? { decision: match[1].toUpperCase(), reason: match[2] || '', at: now() } : null;
}

function setStage(job, stage, note) {
  if (!STAGES.includes(stage)) fail(`unknown stage "${stage}" (one of ${STAGES.join(', ')})`, 2);
  // Leaving the approve stage: record the approver's decision even if the
  // orchestrator skipped the "decision" command.
  if (job.stage === 'approve' && stage !== 'approve' && !job.decision) job.decision = readDecision(job);
  // A preview is for reviewing a job that waits for a human; once it moves on, it would show stale work.
  if (stage !== 'needs-human') endPreview(job);
  job.stage = stage;
  job.updatedAt = now();
  job.history.push({ at: job.updatedAt, stage, round: job.round, ...(note ? { note } : {}) });
}

function endPreview(job) {
  if (!job.preview) return;
  stopPreview(job.preview);
  delete job.preview;
}

/** Whether migration files changed between the last good deploy and `head` (unknown counts as changed). */
function migrationsChanged(since, head, paths) {
  if (!since || paths.length === 0) return true;
  const diff = tryGit(['diff', '--name-only', since, head, '--', ...paths]);
  return !diff.ok || diff.out !== '';
}

/**
 * Record a deploy on the board and on the jobs it ships: the given job plus
 * every job merged since the last good deploy. Returns their ids.
 */
function recordDeploy(job, lastOk, state) {
  return withLock(() => {
    const board = readBoard();
    board.deploys = { ...board.deploys, last: state, ...(state.state === 'ok' ? { lastOk: state } : {}) };
    const mergedAt = (j) => j.history.findLast((h) => h.stage === 'merged')?.at;
    const shipped = Object.values(board.jobs).filter(
      (j) =>
        j.id === job?.id ||
        (lastOk && j.stage === 'merged' && mergedAt(j) > lastOk.at && j.deploy?.state !== 'ok'),
    );
    for (const j of shipped) j.deploy = state;
    writeBoard(board);
    return shipped.map((j) => j.id);
  });
}

/** Stop every other job's preview; returns their ids. */
function stopOtherPreviews(id) {
  return withLock(() => {
    const board = readBoard();
    const stopped = Object.values(board.jobs).filter((j) => j.id !== id && j.preview);
    for (const j of stopped) endPreview(j);
    if (stopped.length) writeBoard(board);
    return stopped.map((j) => j.id);
  });
}

function worktreesDir() {
  return resolve(ROOT, '..', `${basename(ROOT)}.worktrees`);
}

function jobPaths(job) {
  return {
    id: job.id,
    branch: job.branch,
    worktree: job.worktree,
    jobDir: join(JOBS, job.id),
    profile: PROFILE,
    request: join(JOBS, job.id, 'request.md'),
    spec: join(JOBS, job.id, 'spec.md'),
    build: join(JOBS, job.id, 'build.md'),
    review: (lens) => join(JOBS, job.id, `review-${lens}-r${job.round}.md`),
    decision: join(JOBS, job.id, 'decision.md'),
    verifyLog: join(JOBS, job.id, 'verify.log'),
  };
}

function firstLine(path) {
  if (!existsSync(path)) return null;
  return (
    readFileSync(path, 'utf8')
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? null
  );
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function runShell(command, cwd, extraEnv = {}) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * Cross-process lock around read-modify-write of board.json, so several
 * factory sessions can run jobs in parallel. mkdir is atomic; a lock older
 * than two minutes is treated as abandoned.
 */
const held = new Set();
// fail() exits the process, which skips `finally`; release locks here too.
process.on('exit', () => {
  for (const path of held) rmSync(path, { recursive: true, force: true });
});

/** Wait for a lock directory; a lock older than `staleMs` counts as abandoned. */
function acquire(path, staleMs, what) {
  mkdirSync(FACTORY, { recursive: true });
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + staleMs * 1.5; // longer than it takes a lock to go stale
  for (;;) {
    try {
      mkdirSync(path);
      held.add(path);
      return;
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) rmSync(path, { recursive: true, force: true });
      } catch {
        // Lock vanished between checks: retry.
      }
      if (Date.now() > deadline) fail(`${what} is locked by another process (${path})`);
      Atomics.wait(sleeper, 0, 0, 50);
    }
  }
}

function release(path) {
  rmSync(path, { recursive: true, force: true });
  held.delete(path);
}

function withLock(fn) {
  acquire(LOCK, 60_000, 'the board');
  try {
    return fn();
  } finally {
    release(LOCK);
  }
}

// ---------------------------------------------------------------- backlog

/** Backlog items are Markdown task lines: "- [ ] text" (open) or "- [x] text" (done). */
function backlogItems() {
  if (!existsSync(BACKLOG)) return [];
  return readFileSync(BACKLOG, 'utf8')
    .split('\n')
    .map((line, index) => ({ line, index, match: /^\s*- \[( |x)\] (.+)$/.exec(line) }))
    .filter((entry) => entry.match)
    .map((entry) => ({ index: entry.index, done: entry.match[1] === 'x', text: entry.match[2].trim() }));
}

function checkOffBacklog(text, jobId) {
  if (!existsSync(BACKLOG)) return false;
  const lines = readFileSync(BACKLOG, 'utf8').split('\n');
  const index = lines.findIndex((line) => line.trim() === `- [ ] ${text}`);
  if (index === -1) return false;
  lines[index] = lines[index].replace('- [ ]', '- [x]') + ` (${jobId})`;
  writeFileSync(BACKLOG, lines.join('\n'));
  return true;
}

// --------------------------------------------------------------- commands

const commands = {
  init() {
    mkdirSync(JOBS, { recursive: true });
    if (!existsSync(BOARD)) writeBoard({ version: 1, jobs: {} });
    const profile = readProfile();
    const project = registerProject(ROOT);
    out({ ok: true, board: BOARD, profile, dashboardKey: project.key });
  },

  new(args) {
    const title = args._[0];
    if (!title) fail('usage: new "<title>" [--request-file <path>] [--backlog "<item>"]', 2);
    const profile = readProfile();
    const status = git(['status', '--porcelain']);
    if (status) fail(`the main working tree has uncommitted changes; commit or stash them first:\n${status}`);
    const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (current !== profile.base_branch) {
      fail(`check out "${profile.base_branch}" first (currently on "${current}")`);
    }

    registerProject(ROOT);
    const board = readBoard();
    const seq = Object.keys(board.jobs).length + 1;
    const id = `${String(seq).padStart(3, '0')}-${slugify(title)}`;
    const branch = `factory/${id}`;
    const worktree = join(worktreesDir(), id);
    mkdirSync(dirname(worktree), { recursive: true });
    git(['worktree', 'add', '-b', branch, worktree, profile.base_branch]);

    const jobDir = join(JOBS, id);
    mkdirSync(jobDir, { recursive: true });
    const request = args['request-file'] ? readFileSync(args['request-file'], 'utf8') : title;
    writeFileSync(join(jobDir, 'request.md'), `# ${title}\n\n${request.trim()}\n`);

    const job = {
      id,
      title,
      stage: 'spec',
      round: 0,
      branch,
      worktree,
      backlog: args.backlog ?? null,
      reviewers: profile.reviewers,
      createdAt: now(),
      updatedAt: now(),
      verdicts: {},
      decision: null,
      history: [],
    };
    setStage(job, 'spec', 'job created');
    board.jobs[id] = job;
    writeBoard(board);
    const { review: _review, ...paths } = jobPaths(job);
    out({ ...paths, reviewers: profile.reviewers, maxRounds: profile.max_rounds });
  },

  stage(args) {
    const [id, stage] = args._;
    const board = readBoard();
    const job = getJob(board, id);
    setStage(job, stage, args.note);
    writeBoard(board);
    out({ id: job.id, stage: job.stage, round: job.round });
  },

  round(args) {
    const board = readBoard();
    const job = getJob(board, args._[0]);
    job.round += 1;
    setStage(job, 'review', `review round ${job.round}`);
    writeBoard(board);
    const paths = jobPaths(job);
    out({
      id: job.id,
      round: job.round,
      reviews: Object.fromEntries(job.reviewers.map((lens) => [lens, paths.review(lens)])),
    });
  },

  collect(args) {
    const board = readBoard();
    const job = getJob(board, args._[0]);
    if (job.round < 1) fail('no review round has started; run "round" first', 2);
    const paths = jobPaths(job);
    const verdicts = {};
    for (const lens of job.reviewers) {
      const line = firstLine(paths.review(lens));
      const match = line && /^VERDICT:\s*(PASS|CHANGES)\b/i.exec(line);
      verdicts[lens] = match ? match[1].toUpperCase() : 'MISSING';
    }
    job.verdicts[job.round] = verdicts;
    job.updatedAt = now();
    writeBoard(board);
    const values = Object.values(verdicts);
    out({
      id: job.id,
      round: job.round,
      verdicts,
      allPass: values.every((v) => v === 'PASS'),
      missing: Object.keys(verdicts).filter((lens) => verdicts[lens] === 'MISSING'),
      roundsLeft: Math.max(0, readProfile().max_rounds - job.round),
    });
  },

  decision(args) {
    const board = readBoard();
    const job = getJob(board, args._[0]);
    const path = jobPaths(job).decision;
    const decision = readDecision(job);
    if (!decision) fail(`${path} must start with "DECISION: APPROVE" or "DECISION: ESCALATE - <reason>"`);
    job.decision = decision;
    job.updatedAt = now();
    writeBoard(board);
    out({ id: job.id, ...job.decision });
  },

  setup(args) {
    const board = readBoard();
    const job = getJob(board, args._[0]);
    const { setup } = readProfile();
    const result = runShell(setup, job.worktree);
    writeFileSync(join(JOBS, job.id, 'setup.log'), result.output);
    if (!result.ok) fail(`setup failed; see ${join(JOBS, job.id, 'setup.log')}`);
    out({ id: job.id, ok: true });
  },

  async verify(args) {
    const board = readBoard();
    const job = getJob(board, args._[0]);
    const profile = readProfile();
    const paths = jobPaths(job);

    if (git(['status', '--porcelain'], job.worktree)) {
      fail(`the job worktree has uncommitted changes; the builder must commit everything:\n${job.worktree}`);
    }
    // Bring the latest base into the job so the verified tree is exactly what will be merged.
    const sync = tryGit(['merge', '--no-edit', profile.base_branch], job.worktree);
    if (!sync.ok) {
      tryGit(['merge', '--abort'], job.worktree);
      writeFileSync(paths.verifyLog, `Merging ${profile.base_branch} into ${job.branch} conflicted:\n${sync.out}\n`);
      out({ id: job.id, ok: false, reason: 'conflict', log: paths.verifyLog });
      process.exit(1);
    }

    const port = await freePort();
    const result = runShell(profile.verify, job.worktree, { FACTORY_PORT: String(port) });
    const head = git(['rev-parse', 'HEAD'], job.worktree);
    writeFileSync(paths.verifyLog, `commit ${head}\ncommand: ${profile.verify}\n\n${result.output}`);
    withLock(() => {
      const fresh = readBoard();
      const current = getJob(fresh, job.id);
      current.verified = result.ok ? { commit: head, at: now() } : null;
      current.updatedAt = now();
      writeBoard(fresh);
    });
    const tail = result.output.trim().split('\n').slice(-25).join('\n');
    out({ id: job.id, ok: result.ok, commit: head, log: paths.verifyLog, tail });
    if (!result.ok) process.exit(1);
  },

  merge(args) {
    const board = readBoard();
    const job = getJob(board, args._[0]);
    const profile = readProfile();
    const head = git(['rev-parse', job.branch]);

    if (!job.verified || job.verified.commit !== head) {
      fail('the job is not verified at its current commit; run "verify" first');
    }
    if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== profile.base_branch) {
      fail(`check out "${profile.base_branch}" in ${ROOT} first`);
    }
    const dirty = git(['status', '--porcelain']);
    if (dirty) fail(`the main working tree has uncommitted changes:\n${dirty}`);
    if (!tryGit(['merge-base', '--is-ancestor', profile.base_branch, job.branch]).ok) {
      fail(`${profile.base_branch} moved since verification; run "verify" again`);
    }
    // Paths such as database migrations only merge when a person approved the job.
    const changed = git(['diff', '--name-only', `${profile.base_branch}...${job.branch}`]).split('\n').filter(Boolean);
    const guarded = changed.filter((file) => profile.human_only.some((prefix) => file.startsWith(prefix)));
    if (guarded.length && !args.human) {
      process.stderr.write(`board: needs a human: it changes ${guarded.join(', ')} (human_only in the profile)\n`);
      process.exit(3);
    }

    endPreview(job);
    git(['merge', '--no-ff', job.branch, '-m', `Merge ${job.branch}: ${job.title}`]);
    if (job.backlog && checkOffBacklog(job.backlog, job.id)) {
      git(['add', BACKLOG]);
      const short = job.backlog.length > 60 ? `${job.backlog.slice(0, 57).trimEnd()}...` : job.backlog;
      git(['commit', '-m', `chore(factory): check off ${job.id}\n\n${short}`]);
    }
    tryGit(['worktree', 'remove', '--force', job.worktree]);
    tryGit(['branch', '-D', job.branch]);
    setStage(job, 'merged', `merged into ${profile.base_branch}`);
    writeBoard(board);
    out({ id: job.id, ok: true, merged: git(['rev-parse', '--short', 'HEAD']) });
  },

  discard(args) {
    const board = readBoard();
    const job = getJob(board, args._[0]);
    endPreview(job);
    tryGit(['worktree', 'remove', '--force', job.worktree]);
    tryGit(['branch', '-D', job.branch]);
    setStage(job, 'discarded', args.note);
    writeBoard(board);
    out({ id: job.id, stage: job.stage });
  },

  async preview(args) {
    const job = getJob(readBoard(), args._[0]);
    const save = (preview) =>
      withLock(() => {
        const fresh = readBoard();
        const current = getJob(fresh, job.id);
        if (preview) current.preview = preview;
        else delete current.preview;
        current.updatedAt = now();
        writeBoard(fresh);
      });

    if (args.stop) {
      const stopped = stopPreview(job.preview);
      if (job.preview) save(null);
      return out({ id: job.id, stopped });
    }

    const profile = readProfile();
    if (!profile.preview) {
      fail('factory/profile.md has no "preview" command; add one, for example: preview: npm run dev -- --port $FACTORY_PORT');
    }
    if (!['needs-human', 'approve', 'review', 'build'].includes(job.stage) || !existsSync(job.worktree)) {
      fail(`job ${job.id} is ${job.stage} and has no worktree to preview`);
    }
    const head = git(['rev-parse', 'HEAD'], job.worktree);
    const running = job.preview;
    if (running && processAlive(running.pid) && running.commit === head && (await answers(running.url))) {
      if (args.open) openInBrowser(running.url);
      return out({ id: job.id, ...running, reused: true });
    }
    stopPreview(running); // stale: an older commit, or no longer answering
    // Previews that share one resource (such as a local database) run one at a time.
    const others = profile.preview_exclusive ? stopOtherPreviews(job.id) : [];

    const port = await freePort();
    const url = `http://localhost:${port}/`;
    const log = join(JOBS, job.id, 'preview.log');
    const pid = launchPreview(profile.preview, job.worktree, port, log);
    const ready = await waitForPreview(pid, url, profile.preview_timeout * 1000);
    if (!ready.ok) {
      stopPreview({ pid });
      save(null);
      fail(`preview did not start: ${ready.reason}; see ${log}\n${tail(log)}`);
    }
    const preview = { pid, port, url, commit: head, at: now() };
    save(preview);
    if (args.open) openInBrowser(url);
    out({ id: job.id, ...preview, log, ...(others.length ? { stopped: others } : {}) });
  },

  async deploy(args) {
    const profile = readProfile();
    if (!profile.deploy) fail('factory/profile.md has no "deploy" command; add one, for example: deploy: git push origin main', 2);
    const job = args._[0] ? getJob(readBoard(), args._[0]) : null;
    if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== profile.base_branch) {
      fail(`check out "${profile.base_branch}" in ${ROOT} first; deploys run from it`);
    }
    const dirty = git(['status', '--porcelain']);
    if (dirty) fail(`the main working tree has uncommitted changes; deploy only committed work:\n${dirty}`);

    // One deploy at a time; a second one waits, then deploys the newer commit.
    acquire(DEPLOY_LOCK, (profile.deploy_timeout + 600) * 1000, 'deploying');
    try {
      const head = git(['rev-parse', 'HEAD']);
      const lastOk = readBoard().deploys?.lastOk ?? null;
      const logPath = job ? join(JOBS, job.id, 'deploy.log') : join(FACTORY, 'deploy.log');
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, `deploy ${head}\n`);
      const log = (text) => appendFileSync(logPath, `${text}\n`);
      const step = (command) => {
        log(`\n$ ${command}`);
        const result = runShell(command, ROOT, { DEPLOY_COMMIT: head });
        log(result.output.trim());
        return result.ok;
      };
      recordDeploy(job, lastOk, { state: 'running', commit: head, at: now() });

      let failure = null;
      if (profile.migrate) {
        if (migrationsChanged(lastOk?.commit, head, profile.migrations)) {
          if (!step(profile.migrate)) failure = { step: 'migrate', reason: 'the migrate command failed; nothing was deployed' };
        } else log('\nNo migration changes since the last deploy; skipped migrate.');
      }
      if (!failure && !step(profile.deploy)) failure = { step: 'deploy', reason: 'the deploy command failed' };
      if (!failure && profile.deploy_wait) {
        if (profile.deploy_wait === 'github-actions') {
          log('\nWaiting for GitHub Actions...');
          const waited = await waitForGithubRuns(head, ROOT, profile.deploy_timeout * 1000, log);
          if (!waited.ok) failure = { step: 'deploy_wait', reason: waited.reason };
        } else if (!step(profile.deploy_wait)) failure = { step: 'deploy_wait', reason: 'the deploy_wait command failed' };
      }
      if (!failure && profile.smoke) {
        const checked = await smokeCheck(profile.smoke, profile.smoke_timeout * 1000);
        log(`\nSmoke check ${profile.smoke}: ${checked.ok ? `HTTP ${checked.status}` : checked.reason}`);
        if (!checked.ok) failure = { step: 'smoke', reason: checked.reason };
      }

      const result = {
        state: failure ? 'failed' : 'ok',
        commit: head,
        at: now(),
        ...(failure ?? {}),
        ...(profile.smoke ? { url: profile.smoke } : {}),
        log: logPath,
      };
      const jobs = recordDeploy(job, lastOk, result);
      out({ ...result, jobs });
      if (failure) process.exit(1);
    } finally {
      release(DEPLOY_LOCK);
    }
  },

  next() {
    const board = readBoard();
    const claimed = new Set(
      Object.values(board.jobs)
        .filter((job) => ACTIVE.has(job.stage) && job.backlog)
        .map((job) => job.backlog),
    );
    const item = backlogItems().find((entry) => !entry.done && !claimed.has(entry.text));
    out(item ? { item: item.text } : { item: null });
  },

  list() {
    const board = readBoard();
    const jobs = Object.values(board.jobs);
    if (jobs.length === 0) return out('No jobs yet.');
    const rows = jobs.map((job) => {
      const verdicts = job.verdicts[job.round];
      const summary = verdicts
        ? Object.entries(verdicts)
            .map(([lens, v]) => `${lens}:${v}`)
            .join(' ')
        : '';
      const preview = job.preview && processAlive(job.preview.pid) ? `  preview ${job.preview.url}` : '';
      return `${job.id.padEnd(46)} ${job.stage.padEnd(12)} r${job.round}  ${summary}${preview}`;
    });
    out(rows.join('\n'));
  },

  show(args) {
    out(getJob(readBoard(), args._[0]));
  },

  paths(args) {
    const job = getJob(readBoard(), args._[0]);
    const { review, ...paths } = jobPaths(job);
    out({ ...paths, reviews: Object.fromEntries(job.reviewers.map((lens) => [lens, review(lens)])) });
  },

  jobs() {
    out(existsSync(JOBS) ? readdirSync(JOBS) : []);
  },

  register() {
    readProfile();
    const project = registerProject(ROOT);
    out({ ...project, url: `http://localhost:4700/?project=${project.key}` });
  },

  unregister() {
    out({ removed: unregisterProject(ROOT), key: projectKey(ROOT) });
  },

  projects() {
    out(readRegistry().projects);
  },
};

const FLAGS = new Set(['open', 'stop', 'human']); // options without a value

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAGS.has(arg.slice(2))) args[arg.slice(2)] = true;
    else if (arg.startsWith('--')) {
      args[arg.slice(2)] = argv[i + 1];
      i++;
    } else args._.push(arg);
  }
  return args;
}

const [command, ...rest] = process.argv.slice(2);
if (!command || !commands[command]) {
  fail(`usage: board.mjs <${Object.keys(commands).join('|')}> ...`, 2);
}
// Long-running commands take the lock only around their own board writes.
const UNLOCKED = new Set(['setup', 'verify', 'preview', 'deploy', 'list', 'show', 'paths', 'jobs', 'next', 'register', 'unregister', 'projects']);
if (UNLOCKED.has(command)) await commands[command](parseArgs(rest));
else withLock(() => commands[command](parseArgs(rest)));
