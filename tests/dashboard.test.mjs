/**
 * Tests for the all-projects dashboard API (scripts/dashboard.mjs).
 * Run with: node --test tests/
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'factory-dashboard-')));
process.env.SOFTWARE_FACTORY_HOME = join(sandbox, 'home');
const { registerProject } = await import('../scripts/registry.mjs');
const { createDashboardServer } = await import('../scripts/dashboard.mjs');

let server;
let base;
let alpha;

function project(name, jobs) {
  const root = join(sandbox, name);
  mkdirSync(join(root, 'factory', 'jobs'), { recursive: true });
  writeFileSync(join(root, 'factory', 'profile.md'), '---\nbase_branch: main\n---\n');
  writeFileSync(
    join(root, 'factory', 'board.json'),
    JSON.stringify({ version: 1, jobs: Object.fromEntries(jobs.map((job) => [job.id, job])) }),
  );
  for (const job of jobs) {
    mkdirSync(join(root, 'factory', 'jobs', job.id), { recursive: true });
    writeFileSync(join(root, 'factory', 'jobs', job.id, 'spec.md'), `# ${job.title}`);
    writeFileSync(join(root, 'factory', 'jobs', job.id, 'secret.json'), '{"not":"served"}');
  }
  return registerProject(root);
}

const job = (id, stage) => ({ id, title: `Job ${id}`, stage, round: 1, updatedAt: new Date().toISOString() });

before(async () => {
  alpha = project('alpha', [job('001-a', 'review'), job('002-b', 'needs-human')]);
  project('beta', [job('001-c', 'merged')]);
  const gone = project('gone', []);
  rmSync(gone.root, { recursive: true, force: true });
  server = createDashboardServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('dashboard API', () => {
  it('serves the page', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>Software Factory<\/title>/);
  });

  it('lists every registered project with its jobs', async () => {
    const { projects } = await (await fetch(`${base}/api/projects`)).json();
    assert.deepEqual(
      projects.map((p) => [p.name, p.exists, p.jobs.length]),
      [
        ['alpha', true, 2],
        ['beta', true, 1],
        ['gone', false, 0],
      ],
    );
  });

  it('serves a job file list, but only Markdown and logs', async () => {
    const res = await fetch(`${base}/api/jobs/${alpha.key}/001-a`);
    const { files } = await res.json();
    assert.deepEqual(
      files.map((f) => f.name),
      ['spec.md'],
    );
    assert.equal(files[0].content, '# Job 001-a');
  });

  it('rejects unknown projects, unknown jobs and path tricks', async () => {
    for (const path of [
      `/api/jobs/nope/001-a`,
      `/api/jobs/${alpha.key}/999-x`,
      `/api/jobs/${alpha.key}/..%2F..%2Fsecret`,
      `/api/jobs/${alpha.key}/../../etc`,
    ]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404, path);
    }
  });
});
