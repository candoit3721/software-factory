#!/usr/bin/env node
/**
 * One dashboard for every project that uses the factory.
 *
 *   node dashboard.mjs [--port 4700]
 *
 * Projects come from the registry (see registry.mjs). The server binds to
 * localhost and reads each project's factory/board.json, factory/backlog.md
 * and factory/jobs/<id>/*.md|log. Its one action, starting a review preview,
 * goes through board.mjs like every other state change.
 *
 *   GET  /                            the dashboard page
 *   GET  /api/projects                every project with its jobs and open backlog items
 *   GET  /api/jobs/<key>/<job-id>     the files of one job
 *   POST /api/preview/<key>/<job-id>  start (or reuse) the job's review preview
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backlogPath, unclaimedItems } from './backlog.mjs';
import { processAlive } from './preview.mjs';
import { projectStatus, readRegistry } from './registry.mjs';

const BOARD = join(dirname(fileURLToPath(import.meta.url)), 'board.mjs');

const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'index.html');
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > -1 ? process.argv[portArg + 1] : (process.env.FACTORY_DASHBOARD_PORT ?? 4700));

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function readJobs(root) {
  try {
    const jobs = Object.values(JSON.parse(readFileSync(join(root, 'factory', 'board.json'), 'utf8')).jobs ?? {});
    // A preview recorded on the board may have been stopped by hand, or by a restart.
    for (const job of jobs) if (job.preview) job.preview.alive = processAlive(job.preview.pid);
    return jobs;
  } catch {
    return [];
  }
}

/** Whether the project's profile sets `key` (such as `preview` or `deploy`), so the page can show that step. */
function profileHas(root, key) {
  try {
    const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(root, 'factory', 'profile.md'), 'utf8'));
    return Boolean(front && new RegExp(`^${key}:[ \\t]*\\S`, 'm').test(front[1]));
  } catch {
    return false;
  }
}

function projects() {
  return readRegistry().projects.map((entry) => {
    const status = projectStatus(entry);
    const jobs = status.exists ? readJobs(entry.root) : [];
    return {
      ...entry,
      ...status,
      canPreview: status.exists && profileHas(entry.root, 'preview'),
      canDeploy: status.exists && profileHas(entry.root, 'deploy'),
      jobs,
      // An item a job has claimed shows as that job's card instead.
      backlog: status.exists ? unclaimedItems(backlogPath(entry.root), jobs).map((item) => item.text) : [],
    };
  });
}

/**
 * Only this page may start previews: a browser sends Origin on POST, and a
 * site elsewhere (or a DNS-rebound name) would not match this localhost host.
 */
function sameOrigin(req) {
  const host = req.headers.host ?? '';
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && req.headers.origin === `http://${host}`;
}

function startPreview(res, key, id) {
  const project = readRegistry().projects.find((p) => p.key === key);
  if (!project || !existsSync(project.root)) return send(res, 404, 'application/json', '{"error":"no such project"}');
  execFile('node', [BOARD, 'preview', id], { cwd: project.root, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) {
      const message = stderr.replace(/^board: /, '').trim() || error.message;
      return send(res, 500, 'application/json', JSON.stringify({ error: message }));
    }
    send(res, 200, 'application/json', stdout);
  });
}

export function createDashboardServer() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const previewRoute = /^\/api\/preview\/([\w-]+)\/([\w-]+)$/.exec(url.pathname);
    if (previewRoute) {
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Use POST');
      if (!sameOrigin(req)) return send(res, 403, 'application/json', '{"error":"cross-origin request refused"}');
      return startPreview(res, previewRoute[1], previewRoute[2]);
    }
    if (url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', readFileSync(PAGE));
    }
    if (url.pathname === '/api/projects') {
      return send(res, 200, 'application/json', JSON.stringify({ projects: projects() }));
    }
    const match = /^\/api\/jobs\/([\w-]+)\/([\w-]+)$/.exec(url.pathname);
    if (match) {
      const project = readRegistry().projects.find((p) => p.key === match[1]);
      const dir = project && join(project.root, 'factory', 'jobs', match[2]);
      if (!dir || !existsSync(dir)) return send(res, 404, 'application/json', '{"error":"no such job"}');
      const files = readdirSync(dir)
        .filter((name) => /\.(md|log)$/.test(name))
        .map((name) => ({
          name,
          modified: statSync(join(dir, name)).mtimeMs,
          content: readFileSync(join(dir, name), 'utf8').slice(-200_000),
        }))
        .sort((a, b) => a.modified - b.modified);
      return send(res, 200, 'application/json', JSON.stringify({ files }));
    }
    send(res, 404, 'text/plain', 'Not found');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createDashboardServer();
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      process.stdout.write(`A dashboard is already running: http://localhost:${PORT}\n`);
      process.exit(0);
    }
    throw error;
  });
  server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`Factory dashboard (all projects): http://localhost:${PORT}\n`);
  });
}
